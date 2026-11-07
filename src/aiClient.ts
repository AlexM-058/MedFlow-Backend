import { z } from 'zod';
import { CaseSummarySchema, type CaseSummary } from './schemas';

// Clientul pentru serviciul HTTP al AI-ului (MedFlow-AI/cloud/server.ts), care face analiza
// de suport decizional pentru medic (DoctorOrchestrator + Gemini).
// Înlocuiește importul direct al fișierelor din ../../AI: așa Backend-ul se compilează
// și rulează singur, iar AI-ul rulează ca serviciu separat (local sau în altă parte).
//
// Contract (descris în MedFlow-AI/README.md):
//   POST {AI_URL}/analysis
//   Body:    { caseId, caseSummary, documentsContext?, patientResponse?, state }
//   Răspuns: 200 + { result: { status: 'FINAL' | 'CLARIFICATION_REQUIRED', data }, state }
//
// `state` = valoarea din coloana cases.doctor_orchestration_state.
// Serviciul AI NU are acces la baza de date: noi îi trimitem starea curentă
// și salvăm înapoi starea pe care ne-o întoarce.

// Cât așteptăm răspunsul. Gemini poate încerca de 3 ori (câte 30 s), cu pauze de 2 s și 4 s între încercări.
const TIMEOUT_MS = 120_000;

// Starea rundelor de clarificare. Pentru Backend e o „cutie închisă”: nu ne uităm înăuntru
// (roundCount etc. le gestionează AI-ul), doar verificăm că e un obiect JSON, cum cere
// CHECK-ul din migrarea 003. Așa, dacă AI-ul adaugă un câmp nou, Backend-ul nu trebuie schimbat.
const OrchestrationStateSchema = z.record(z.string(), z.unknown());
export type OrchestrationState = z.infer<typeof OrchestrationStateSchema>;

// Ce trebuie să conțină răspunsul serviciului AI ca să-l acceptăm.
const AnalysisResponseSchema = z.object({
  result: z.object({
    status: z.enum(['FINAL', 'CLARIFICATION_REQUIRED']),
    data: z.unknown(), // FINAL: analiza pentru medic; CLARIFICATION_REQUIRED: întrebarea (text)
  }),
  state: OrchestrationStateSchema.nullable(),
  // Modelul LLM care a făcut analiza (ex. "gemini-3-flash-preview"). Opțional: o versiune
  // mai veche a serviciului AI nu îl trimite.
  model: z.string().optional(),
});
export type AnalysisOutcome = z.infer<typeof AnalysisResponseSchema>['result'];

// Ce îi trimitem. caseSummary e deja verificat când ajunge aici: ori de AnalysisBodySchema
// (trimis de medic), ori de CaseSummaryResponseSchema (generat de serviciul AI, mai jos).
export type AnalysisRequest = {
  caseId: string;
  caseSummary: CaseSummary;
  documentsContext?: string | undefined;
  patientResponse?: string | undefined;
  state: OrchestrationState | null;
};

// Rezultatul: ori analiza + starea nouă, ori codul HTTP și mesajul pentru client.
//   503 = serviciul AI nu e configurat sau nu poate fi contactat
//   504 = serviciul AI nu a răspuns în TIMEOUT_MS
//   502 = serviciul AI a răspuns, dar cu o eroare sau cu date în format greșit
export type AnalysisResult =
  | { ok: true; result: AnalysisOutcome; state: OrchestrationState | null; model: string | undefined }
  | { ok: false; status: 502 | 503 | 504; error: string };

export async function requestAnalysis(request: AnalysisRequest): Promise<AnalysisResult> {
  const baseUrl = process.env.AI_URL?.trim();
  if (!baseUrl) {
    console.error('AI_URL lipsește din Backend/.env');
    return { ok: false, status: 503, error: 'Serviciul de analiză AI nu este disponibil' };
  }

  // Pasul 1: trimitem cererea. Aici pot apărea două probleme:
  //   - serviciul e oprit / adresa e greșită -> fetch aruncă o eroare
  //   - serviciul nu răspunde la timp -> AbortSignal.timeout oprește cererea
  let aiResponse: Response;
  try {
    aiResponse = await fetch(`${baseUrl}/analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      console.error(`Serviciul AI nu a răspuns în ${TIMEOUT_MS} ms`);
      return { ok: false, status: 504, error: 'Serviciul de analiză AI nu a răspuns la timp' };
    }
    console.error('Nu am putut contacta serviciul AI:', error instanceof Error ? error.message : error);
    return { ok: false, status: 503, error: 'Serviciul de analiză AI nu este disponibil' };
  }

  // Pasul 2: serviciul a răspuns, dar cu o eroare
  // (400 = i-am trimis date greșite; 500 = a eșuat curățarea datelor sau apelul la Gemini).
  if (!aiResponse.ok) {
    console.error(`Serviciul AI a răspuns cu HTTP ${aiResponse.status}`);
    return { ok: false, status: 502, error: 'Analiza AI a eșuat' };
  }

  // Pasul 3: citim răspunsul și verificăm că are forma din contract.
  let body: unknown;
  try {
    body = await aiResponse.json();
  } catch {
    console.error('Serviciul AI a întors un răspuns care nu e JSON valid');
    return { ok: false, status: 502, error: 'Serviciul de analiză AI a întors un răspuns invalid' };
  }

  const parsed = AnalysisResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.error('Răspunsul serviciului AI nu respectă contractul:', z.flattenError(parsed.error).fieldErrors);
    return { ok: false, status: 502, error: 'Serviciul de analiză AI a întors un răspuns invalid' };
  }

  return { ok: true, result: parsed.data.result, state: parsed.data.state, model: parsed.data.model };
}

// ---------------------------------------------------------------------------
// Sumarul cazului generat din conversație: POST {AI_URL}/case-summary
//
// Când medicul cere analiza fără să trimită caseSummary, Backend-ul trimite mesajele
// cazului (case_messages) serviciului AI, care:
//   - curăță fiecare mesaj cu PrivacyGateway (emailuri, telefoane... nu ajung la LLM)
//   - cere LLM-ului (Gemini) câmpurile descriptive (motivul principal, debut, durată...)
//   - calculează redFlagsDetected cu reguli FIXE (edge/safety/redflags.ts), nu cu LLM-ul
//
// Contract (descris în MedFlow-AI/README.md):
//   Body:    { caseId, patientId, language: 'ro' | 'en', messages: [{ sender_role, content, created_at }] }
//   Răspuns: 200 + { caseSummary: CaseSummary, model }
// ---------------------------------------------------------------------------

// Un mesaj, așa cum îl trimitem serviciului AI (doar câmpurile din contract).
export type CaseSummaryMessage = {
  sender_role: string;
  content: string;
  created_at: string;
};

export type CaseSummaryRequest = {
  caseId: string;
  patientId: string; // pacientul cazului (din DB), NU din body-ul cererii
  language: 'ro' | 'en';
  messages: CaseSummaryMessage[];
};

// Ce trebuie să conțină răspunsul ca să-l acceptăm. Sumarul îl verificăm cu ACEEAȘI
// schemă ca un caseSummary trimis de medic: dacă AI-ul greșește forma, nu-l folosim.
const CaseSummaryResponseSchema = z.object({
  caseSummary: CaseSummarySchema,
  model: z.string().optional(),
});

// Aceleași coduri ca la requestAnalysis: 503 (indisponibil), 504 (timeout), 502 (eroare / format greșit).
export type CaseSummaryResult =
  | { ok: true; caseSummary: CaseSummary; model: string | undefined }
  | { ok: false; status: 502 | 503 | 504; error: string };

export async function requestCaseSummary(request: CaseSummaryRequest): Promise<CaseSummaryResult> {
  const baseUrl = process.env.AI_URL?.trim();
  if (!baseUrl) {
    console.error('AI_URL lipsește din Backend/.env');
    return { ok: false, status: 503, error: 'Serviciul de analiză AI nu este disponibil' };
  }

  // Trimitem doar câmpurile din contract (de ex. id-ul mesajului nu pleacă spre AI).
  const messages: CaseSummaryMessage[] = [];
  for (const message of request.messages) {
    messages.push({ sender_role: message.sender_role, content: message.content, created_at: message.created_at });
  }

  // Pasul 1: trimitem cererea (aceleași două probleme posibile ca la requestAnalysis:
  // serviciul e oprit sau nu răspunde în TIMEOUT_MS).
  let aiResponse: Response;
  try {
    aiResponse = await fetch(`${baseUrl}/case-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caseId: request.caseId,
        patientId: request.patientId,
        language: request.language,
        messages,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      console.error(`Serviciul AI nu a răspuns în ${TIMEOUT_MS} ms (sumarul cazului)`);
      return { ok: false, status: 504, error: 'Serviciul de analiză AI nu a răspuns la timp' };
    }
    console.error('Nu am putut contacta serviciul AI:', error instanceof Error ? error.message : error);
    return { ok: false, status: 503, error: 'Serviciul de analiză AI nu este disponibil' };
  }

  // Pasul 2: serviciul a răspuns, dar cu o eroare (400 = date greșite; 500 = curățare sau LLM eșuat).
  if (!aiResponse.ok) {
    console.error(`Serviciul AI a răspuns cu HTTP ${aiResponse.status} (sumarul cazului)`);
    return { ok: false, status: 502, error: 'Generarea sumarului cazului a eșuat' };
  }

  // Pasul 3: citim răspunsul și verificăm că are forma din contract.
  let body: unknown;
  try {
    body = await aiResponse.json();
  } catch {
    console.error('Serviciul AI a întors un răspuns care nu e JSON valid (sumarul cazului)');
    return { ok: false, status: 502, error: 'Serviciul de analiză AI a întors un răspuns invalid' };
  }

  const parsed = CaseSummaryResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.error('Sumarul primit de la serviciul AI nu respectă contractul:', z.flattenError(parsed.error).fieldErrors);
    return { ok: false, status: 502, error: 'Serviciul de analiză AI a întors un răspuns invalid' };
  }

  return { ok: true, caseSummary: parsed.data.caseSummary, model: parsed.data.model };
}
