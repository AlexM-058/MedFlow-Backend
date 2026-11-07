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
//
// Fișierul brut rămâne doar în memorie, pe durata cererii. Nu îl salvăm nicăieri.

// Cât așteptăm răspunsul. Serviciul face preprocesare, OCR și extragere cu un model local
// (pe un GPU de 6 GB, sau pe CPU dacă nu există GPU), iar un PDF cu mai multe pagini poate dura.
// Se poate schimba din Backend/.env cu EXTRACTION_TIMEOUT_MS (milisecunde).
const DEFAULT_TIMEOUT_MS = 120_000;
const configuredTimeout = Number(process.env.EXTRACTION_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 5_000 ? configuredTimeout : DEFAULT_TIMEOUT_MS;

// Ce trebuie să conțină răspunsul MedGemma ca să-l acceptăm.
// extracted_data trebuie să fie un obiect JSON (nu text, listă sau null),
// pentru că îl salvăm în coloana JSONB medical_documents.extracted_data.
const MedGemmaResponseSchema = z.object({
  extracted_data: z.record(z.string(), z.unknown()),
});

// Rezultatul extragerii: ori datele, ori codul HTTP și mesajul pe care le trimitem clientului.
//   503 = serviciul nu e configurat sau nu poate fi contactat
//   504 = serviciul nu a răspuns în TIMEOUT_MS
//   502 = serviciul a răspuns, dar cu o eroare sau cu date în format greșit
export type ExtractionResult =
  | { ok: true; extractedData: Record<string, unknown> }
  | { ok: false; status: 502 | 503 | 504; error: string };

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

  // Pasul 2: serviciul a răspuns, dar cu o eroare (de ex. 500).
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
