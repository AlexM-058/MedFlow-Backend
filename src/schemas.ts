import { z } from 'zod';

// Regulile pentru datele care vin de la Frontend.
// Le verificăm cu .safeParse(), care întoarce { success: true, data } sau { success: false, error }.
// Câmpurile care nu sunt descrise aici sunt eliminate din `data`
// (de ex. un `sender_role` trimis în body este ignorat).

// :id din URL, de ex. /cases/3f1c...  Cheile din tabelul `cases` sunt UUID-uri.
export const CaseIdParamsSchema = z.object({
  id: z.uuid('ID-ul cazului trebuie să fie un UUID valid'),
});

// Body pentru POST /cases. Pacientul NU vine din body, ci din token.
// doctorId e opțional: e nevoie de el doar dacă pacientul are mai mulți medici alocați.
export const CreateCaseBodySchema = z.object({
  doctorId: z.uuid('doctorId trebuie să fie un UUID valid').optional(),
});

// Body pentru POST /cases/:id/messages.
// Întâi .trim() (scoate spațiile de la capete), apoi .min(1):
// așa un mesaj format doar din spații devine "" și e respins.
export const MessageBodySchema = z.object({
  content: z
    .string('content trebuie să fie text')
    .trim()
    .min(1, 'Mesajul nu poate fi gol')
    .max(5000, 'Mesajul poate avea maxim 5000 de caractere'),
});

// Categoriile de documente medicale. Exact valorile permise de baza de date în
// medical_documents.document_type (CHECK din migrarea 002 a Database).
// Dacă se schimbă acolo, trebuie schimbate și aici.
export const DOCUMENT_CATEGORIES = ['prescription', 'lab_result', 'medical_letter', 'other'] as const;

// Query string pentru POST /cases/:id/documents?documentType=lab_result
// Body-ul cererii este fișierul însuși, deci categoria nu poate veni în body: vine din adresă.
// documentType e opțional: dacă lipsește, .default() îl face 'other'.
export const DocumentUploadQuerySchema = z.object({
  documentType: z
    .enum(DOCUMENT_CATEGORIES, 'documentType trebuie să fie: prescription, lab_result, medical_letter sau other')
    .default('other'),
});

// Sumarul cazului, exact forma `CaseSummary` din MedFlow-AI/core/schemas/case-summary.ts.
// Dacă se schimbă acolo, trebuie schimbat și aici (contractul AI <-> Backend).
const CaseSummarySchema = z.object({
  chiefComplaint: z.string(),
  onset: z.string(),
  duration: z.string(),
  pattern: z.string(),
  severity: z.number().min(0).max(10),
  associatedSymptoms: z.array(z.string()),
  currentMedications: z.array(z.string()),
  allergiesConditions: z.array(z.string()),
  redFlagsDetected: z.boolean(),
  rawTranscript: z.string(),
  metadata: z.object({
    timestamp: z.string(),
    patientId: z.uuid('metadata.patientId trebuie să fie un UUID valid'),
    language: z.enum(['ro', 'en']),
  }),
});

// Body pentru POST /cases/:id/analysis.
// - prima rundă: doar caseSummary (+ opțional documentsContext)
// - runda de clarificare: același caseSummary + patientResponse (răspunsul pacientului)
export const AnalysisBodySchema = z.object({
  caseSummary: CaseSummarySchema,
  documentsContext: z.string().optional(),
  patientResponse: z
    .string('patientResponse trebuie să fie text')
    .trim()
    .min(1, 'Răspunsul pacientului nu poate fi gol')
    .max(5000, 'Răspunsul pacientului poate avea maxim 5000 de caractere')
    .optional(),
});
