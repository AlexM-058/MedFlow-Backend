import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser, type CurrentUser } from './auth';
import { updatePatientSummariesFromDocuments } from './records';
import { confirmedMedicationsFromReview, textOrNull, type ReviewedMedication } from './reviewData';
import { getAdminClient } from './supabaseAdmin';

// Verificarea rețetei de către pacient.
//
// Serviciul de extragere citește rețeta și poate greși. Pacientul compară fiecare rând cu rețeta
// de hârtie și confirmă, corectează sau declară „nu figurează”. Aici salvăm rezultatul:
//   - extracted_data rămâne NEATINS (ce a citit cititorul), ca medicul să vadă și corecțiile;
//   - review păstrează valorile după verificare (verbatim, fără conversii de dozaj sau ore).
// Doar medicamentele dintr-un document verificat ajung în „Tratament activ” (vezi records.ts).

const MEDICATION_KEYS = ['name', 'dose', 'frequency', 'duration'] as const;
type MedicationKey = (typeof MEDICATION_KEYS)[number];

// Singurul câmp care poate lipsi legitim de pe o rețetă (la fel ca în Frontend, prescriptionReviewLogic.ts).
const MAY_BE_ABSENT: ReadonlySet<MedicationKey> = new Set(['duration']);

const FIELD_PATH = /^medications\.(\d+)\.(name|dose|frequency|duration)$/;

export const ReviewedFieldSchema = z.object({
  path: z.string().regex(FIELD_PATH),
  label: z.string().min(1).max(200),
  extracted: z.string().max(2000).nullable(),
  value: z.string().max(2000).nullable(),
  confirmation: z.object({
    status: z.literal('confirmed'),
    by: z.literal('patient'),
    at: z.iso.datetime({ offset: true }),
  }),
  sourceQuote: z.string().max(2000).optional(),
});
export { confirmedMedicationsFromReview, type ReviewedMedication };
export type ReviewedFieldInput = z.infer<typeof ReviewedFieldSchema>;

export const ReviewBodySchema = z.strictObject({
  fields: z.array(ReviewedFieldSchema).min(1).max(200),
});

const ReviewParamsSchema = z.object({ id: z.uuid(), docId: z.uuid() });

export type ReviewValidation =
  | { ok: true; medications: ReviewedMedication[] }
  | { ok: false; error: string };

// Verifică verificarea pacientului față de ce a extras serviciul. Nu are încredere în client:
//   - fiecare rând extras trebuie să aibă exact cele 4 câmpuri, fără duplicate sau câmpuri străine;
//   - „ce a citit cititorul” trebuie să fie chiar ce e salvat în extracted_data (nu poate fi falsificat);
//   - un câmp ilizibil nu se poate confirma ca atare: pacientul îl introduce de pe rețeta de hârtie;
//   - doar durata poate fi declarată „nu figurează pe rețetă”.
export function validateReview(extractedData: unknown, fields: ReviewedFieldInput[]): ReviewValidation {
  const rawMedications = (extractedData as { medications?: unknown } | null)?.medications;
  if (!Array.isArray(rawMedications) || rawMedications.length === 0) {
    return { ok: false, error: 'Documentul nu are medicamente de verificat.' };
  }
  if (fields.length !== rawMedications.length * MEDICATION_KEYS.length) {
    return { ok: false, error: 'Verificarea trebuie să cuprindă toate câmpurile fiecărui medicament.' };
  }

  const byPath = new Map<string, ReviewedFieldInput>();
  for (const field of fields) {
    if (byPath.has(field.path)) return { ok: false, error: 'Verificarea conține același câmp de două ori.' };
    byPath.set(field.path, field);
  }

  const medications: ReviewedMedication[] = [];
  for (let index = 0; index < rawMedications.length; index++) {
    const raw = (rawMedications[index] ?? {}) as Record<string, unknown>;
    const reviewed: Partial<Record<MedicationKey, string | null>> = {};
    for (const key of MEDICATION_KEYS) {
      const field = byPath.get(`medications.${index}.${key}`);
      if (!field) return { ok: false, error: 'Verificarea nu cuprinde toate câmpurile documentului.' };
      if (textOrNull(field.extracted) !== textOrNull(raw[key])) {
        return { ok: false, error: 'Verificarea nu corespunde documentului citit. Reîncărcați pagina și reluați verificarea.' };
      }
      if (field.value === null) {
        if (!MAY_BE_ABSENT.has(key)) return { ok: false, error: 'Numele, doza și frecvența trebuie completate sau confirmate.' };
        reviewed[key] = null;
        continue;
      }
      const value = field.value.trim();
      if (!value) return { ok: false, error: 'Un câmp verificat nu poate fi gol.' };
      reviewed[key] = value;
    }
    medications.push({
      name: reviewed.name as string,
      dose: reviewed.dose as string,
      frequency: reviewed.frequency as string,
      duration: reviewed.duration ?? null,
    });
  }
  return { ok: true, medications };
}

const DOCUMENT_COLUMNS =
  'id, case_id, uploaded_by, document_type, mime_type, size_bytes, extracted_data, review, reviewed_by, reviewed_at, created_at';

export function createDocumentReviewRouter(
  options: {
    authenticate?: RequestHandler;
    getDb?: typeof getAdminClient;
    afterReview?: (patientId: string) => Promise<unknown>;
  } = {},
) {
  const router = Router();

  // POST /cases/:id/documents/:docId/review — body { fields: ReviewedField[] }. Numai pacientul cazului.
  router.post('/:id/documents/:docId/review', options.authenticate ?? requireUser, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const params = ReviewParamsSchema.safeParse(request.params);
    const body = ReviewBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      response.status(400).json({ error: 'Cerere invalidă.' });
      return;
    }
    const user = response.locals.user as CurrentUser;
    if (user.role !== 'patient') {
      response.status(403).json({ error: 'Acces nepermis.' });
      return;
    }

    const db = (options.getDb ?? getAdminClient)();
    const foundCase = await db.from('cases').select('patient_id').eq('id', params.data.id).maybeSingle();
    if (foundCase.error) throw new Error('Nu am putut citi cazul: ' + foundCase.error.message);
    if (!foundCase.data || foundCase.data.patient_id !== user.id) {
      response.status(404).json({ error: 'Dosarul nu este disponibil.' });
      return;
    }

    const found = await db
      .from('medical_documents')
      .select('id, extracted_data')
      .eq('id', params.data.docId)
      .eq('case_id', params.data.id)
      .maybeSingle();
    if (found.error) throw new Error('Nu am putut citi documentul: ' + found.error.message);
    if (!found.data) {
      response.status(404).json({ error: 'Documentul nu este disponibil.' });
      return;
    }

    const validation = validateReview(found.data.extracted_data, body.data.fields);
    if (!validation.ok) {
      response.status(422).json({ error: validation.error });
      return;
    }

    const saved = await db
      .from('medical_documents')
      .update({
        review: { fields: body.data.fields, medications: validation.medications },
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', params.data.docId)
      .select(DOCUMENT_COLUMNS)
      .single();
    if (saved.error) throw new Error('Nu am putut salva verificarea: ' + saved.error.message);

    // „Tratament activ” se recalculează acum, din medicamentele confirmate. Eșecul nu anulează verificarea.
    try {
      await (options.afterReview ?? updatePatientSummariesFromDocuments)(user.id);
    } catch (error) {
      console.error('Nu am putut actualiza sumarele pacientului:', error);
    }

    response.json(saved.data);
  });

  return router;
}
