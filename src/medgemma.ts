import { z } from 'zod';
import type { FileMimeType } from './fileType';

// Clientul pentru serviciul local MedGemma (modulul AI/edge), care citește documentul
// și extrage datele medicale din el.
//
// Contract PROPUS de Backend (de confirmat cu echipa AI):
//   POST {MEDGEMMA_URL}/extract
//   Header:  Content-Type: image/jpeg | image/png | application/pdf
//   Body:    octeții fișierului (nu JSON, nu base64)
//   Răspuns: 200 + { "extracted_data": { ...datele medicale extrase... } }
//            sau 4xx/5xx + { "error": "mesaj în română" }
//
// Fișierul brut rămâne doar în memorie, pe durata cererii. Nu îl salvăm nicăieri.

// Cât așteptăm răspunsul. Serviciul face preprocesare, OCR și extragere cu un model local
// (pe un GPU de 6 GB, sau pe CPU dacă nu există GPU), iar un PDF cu mai multe pagini poate dura.
// Se poate schimba din Backend/.env cu EXTRACTION_TIMEOUT_MS (milisecunde).
//
// Legătura cu serviciul (MedFlow-AI/edge/extraction_service/time_budget.py):
//   serviciul are un buget de EXTRACTION_TIME_BUDGET_SECONDS (implicit 100 s) pe cerere.
//   Când bugetul se termină, se oprește singur și răspunde 504.
//   Noi așteptăm 120 s, adică MAI MULT decât bugetul serviciului, cu ~20 s rezervă pentru
//   trimiterea fișierului și răspuns. Așa, de obicei serviciul se oprește primul și ne spune
//   ce s-a întâmplat, în loc să renunțăm noi cât timp el încă lucrează.
//   Dacă mărești bugetul serviciului, mărește și TIMEOUT_MS (bugetul trebuie să rămână mai mic).
const DEFAULT_TIMEOUT_MS = 120_000;
const configuredTimeout = Number(process.env.EXTRACTION_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 5_000 ? configuredTimeout : DEFAULT_TIMEOUT_MS;

// Ce trebuie să conțină răspunsul MedGemma ca să-l acceptăm.
// extracted_data trebuie să fie un obiect JSON (nu text, listă sau null),
// pentru că îl salvăm în coloana JSONB medical_documents.extracted_data.
const MedGemmaResponseSchema = z.object({
  extracted_data: z.record(z.string(), z.unknown()),
});

// Forma unui răspuns de eroare al serviciului: { "error": "mesaj" }.
const MedGemmaErrorSchema = z.object({
  error: z.string().min(1),
});

// Rezultatul extragerii: ori datele, ori codul HTTP și mesajul pe care le trimitem clientului.
//   422 = fișierul e valid, dar serviciul nu a găsit text în el (PDF deteriorat, cu parolă,
//         poză fără text). `error` e mesajul serviciului, ca utilizatorul să afle motivul.
//   503 = serviciul nu e configurat sau nu poate fi contactat
//   504 = serviciul nu a răspuns în TIMEOUT_MS
//   502 = serviciul a răspuns, dar cu altă eroare sau cu date în format greșit
export type ExtractionResult =
  | { ok: true; extractedData: Record<string, unknown> }
  | { ok: false; status: 422 | 502 | 503 | 504; error: string };

export async function extractWithMedGemma(file: Buffer, mimeType: FileMimeType): Promise<ExtractionResult> {
  const baseUrl = process.env.MEDGEMMA_URL?.trim();
  if (!baseUrl) {
    console.error('MEDGEMMA_URL lipsește din Backend/.env');
    return { ok: false, status: 503, error: 'Serviciul de extragere a datelor nu este disponibil' };
  }

  // Pasul 1: trimitem fișierul. Aici pot apărea două probleme:
  //   - serviciul e oprit / adresa e greșită -> fetch aruncă o eroare
  //   - serviciul nu răspunde la timp -> AbortSignal.timeout oprește cererea
  let medGemmaResponse: Response;
  try {
    medGemmaResponse = await fetch(`${baseUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType },
      // TypeScript nu acceptă direct un Buffer ca body la fetch;
      // Uint8Array conține aceiași octeți, într-un tip pe care fetch îl acceptă.
      body: new Uint8Array(file),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      console.error(`MedGemma nu a răspuns în ${TIMEOUT_MS} ms`);
      return { ok: false, status: 504, error: 'Serviciul de extragere a datelor nu a răspuns la timp' };
    }
    console.error('Nu am putut contacta MedGemma:', error instanceof Error ? error.message : error);
    return { ok: false, status: 503, error: 'Serviciul de extragere a datelor nu este disponibil' };
  }

  // Pasul 2: serviciul a răspuns, dar cu o eroare.
  //   - 422: documentul nu are text de citit. Trimitem mai departe mesajul serviciului.
  //     E sigur să-l arătăm: mesajele serviciului sunt fixe, în română, fără date medicale.
  //   - orice altceva (de ex. 500): 502, cu un mesaj general.
  if (medGemmaResponse.status === 422) {
    let errorBody: unknown;
    try {
      errorBody = await medGemmaResponse.json();
    } catch {
      errorBody = null; // nu e JSON: tratăm mai jos ca pe orice altă eroare (502)
    }
    const parsedError = MedGemmaErrorSchema.safeParse(errorBody);
    if (parsedError.success) {
      console.error(`MedGemma a răspuns cu HTTP 422: ${parsedError.data.error}`);
      return { ok: false, status: 422, error: parsedError.data.error };
    }
  }

  // 503 / 504 de la serviciu: s-a oprit „curat”, cu un motiv clar (Ollama/modelul nu e disponibil,
  // sau i s-a terminat timpul alocat). Le dăm mai departe cu același cod, ca utilizatorul să știe
  // că poate retrimite documentul mai târziu, nu că documentul ar fi greșit.
  if (medGemmaResponse.status === 503) {
    console.error('MedGemma a răspuns cu HTTP 503');
    return { ok: false, status: 503, error: 'Serviciul de extragere a datelor nu este disponibil momentan' };
  }
  if (medGemmaResponse.status === 504) {
    console.error('MedGemma a răspuns cu HTTP 504');
    return { ok: false, status: 504, error: 'Citirea documentului a durat prea mult. Încercați din nou sau trimiteți mai puține pagini' };
  }

  if (!medGemmaResponse.ok) {
    console.error(`MedGemma a răspuns cu HTTP ${medGemmaResponse.status}`);
    return { ok: false, status: 502, error: 'Serviciul de extragere a datelor a întors o eroare' };
  }

  // Pasul 3: citim răspunsul și verificăm că are forma din contract.
  let body: unknown;
  try {
    body = await medGemmaResponse.json();
  } catch {
    console.error('MedGemma a întors un răspuns care nu e JSON valid');
    return { ok: false, status: 502, error: 'Serviciul de extragere a datelor a întors un răspuns invalid' };
  }

  const parsed = MedGemmaResponseSchema.safeParse(body);
  if (!parsed.success) {
    console.error('Răspunsul MedGemma nu respectă contractul:', z.flattenError(parsed.error).fieldErrors);
    return { ok: false, status: 502, error: 'Serviciul de extragere a datelor a întors un răspuns invalid' };
  }

  return { ok: true, extractedData: parsed.data.extracted_data };
}
