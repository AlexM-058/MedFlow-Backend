import { z } from 'zod';
import type { AnalysisBodySchema } from './schemas';

// Clientul pentru serviciul HTTP al AI-ului (MedFlow-AI/cloud/server.ts), care face analiza
// de suport decizional pentru medic (DoctorOrchestrator + Gemini).
// Înlocuiește importul direct al fișierelor din ../../AI: așa Backend-ul se compilează
// și se publică singur (de ex. pe Azure), iar AI-ul rulează ca serviciu separat.
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
});
export type AnalysisOutcome = z.infer<typeof AnalysisResponseSchema>['result'];

// Ce îi trimitem. caseSummary, documentsContext și patientResponse sunt deja verificate
// de AnalysisBodySchema (schemas.ts) când ajung aici.
type AnalysisBody = z.infer<typeof AnalysisBodySchema>;
export type AnalysisRequest = {
  caseId: string;
  caseSummary: AnalysisBody['caseSummary'];
  documentsContext?: string | undefined;
  patientResponse?: string | undefined;
  state: OrchestrationState | null;
};

// Rezultatul: ori analiza + starea nouă, ori codul HTTP și mesajul pentru client.
//   503 = serviciul AI nu e configurat sau nu poate fi contactat
//   504 = serviciul AI nu a răspuns în TIMEOUT_MS
//   502 = serviciul AI a răspuns, dar cu o eroare sau cu date în format greșit
export type AnalysisResult =
  | { ok: true; result: AnalysisOutcome; state: OrchestrationState | null }
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

  return { ok: true, result: parsed.data.result, state: parsed.data.state };
}
