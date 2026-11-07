import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser, type CurrentUser } from './auth';
import { createLocalAgentClient } from './localAgent';
import { loadPatientContext } from './patientContext';
import { pickDocumentDate, upsertMedicalRecord } from './records';
import { confirmedMedicationsFromReview } from './reviewData';
import { getAdminClient } from './supabaseAdmin';

// Control questions for a patient. The doctor asks for them; the local gateway (this project's laptop) turns the
// medical file into the closed anonymized summary, and ONLY that summary goes to the cloud AI (Gemini), which
// answers with a short summary and control questions. The local agent then asks the patient those questions
// (see localAgentRoutes.ts). The Backend never calls the cloud AI for this: it talks to the local gateway only.

export const CONTROL_QUESTIONS_RECORD = 'control_questions_v1';
const MAX_DOCUMENTS = 200;
const MAX_CONTEXT_ITEMS = 200;

export const StoredQuestionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  text: z.string().trim().min(8).max(200),
  answerType: z.enum(['yes_no', 'number', 'short_text']),
});
export type StoredQuestion = z.infer<typeof StoredQuestionSchema>;

const GatewayResultSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  questions: z.array(StoredQuestionSchema).min(1).max(8),
  anonymizedSummary: z.record(z.string(), z.unknown()),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  model: z.string().min(1).max(100),
  rejectedQuestionCount: z.number().int().nonnegative().optional(),
});

/** The stored record (medical_records.clinical_data) -> its questions, or null when absent or malformed. */
export function parseStoredQuestions(clinicalData: unknown): StoredQuestion[] | null {
  const parsed = z.array(StoredQuestionSchema).min(1).max(8).safeParse((clinicalData as { questions?: unknown } | null | undefined)?.questions);
  return parsed.success ? parsed.data : null;
}

/** Text date found in a document -> ISO date (YYYY-MM-DD), or null. Two-digit years are ambiguous: not guessed. */
export function toIsoDate(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const dmy = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*$/.exec(text);
  const ymd = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(text);
  const [year, month, day] = dmy ? [dmy[3], dmy[2], dmy[1]] : ymd ? [ymd[1], ymd[2], ymd[3]] : [];
  if (!year || !month || !day) return null;
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  const real = new Date(Date.UTC(y, m - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export type DocumentRow = { document_type?: unknown; extracted_data?: unknown; review?: unknown };
export type ContextRow = { kind: string; text: string; confirmation?: { status?: string } | null };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The medical file as the local gateway expects it. It contains the patient's own text, so it goes ONLY to the
 * local gateway, which projects it into the anonymized summary. A document counts as reviewed only when the patient
 * confirmed its medicines; diagnoses and lab results are never marked confirmed (no review exists for them yet).
 */
export function buildDossier(documents: DocumentRow[], contextItems: ContextRow[]) {
  const docs = documents.slice(0, MAX_DOCUMENTS).flatMap((document) => {
    const data = document.extracted_data;
    if (!isRecord(data) || data.extraction_status === 'unavailable') return [];
    const confirmed = confirmedMedicationsFromReview(document.review);
    const extractedMedications = Array.isArray(data.medications) ? data.medications : [];
    return [{
      reviewed: confirmed !== null,
      documentDate: toIsoDate(pickDocumentDate(data.dates)),
      medications: (confirmed ? confirmed.map((medication) => medication.name) : extractedMedications.map((medication) => (isRecord(medication) ? text(medication.name) : null)))
        .map((name) => ({ name })),
      diagnoses: (Array.isArray(data.diagnoses) ? data.diagnoses : []).filter((diagnosis): diagnosis is string => typeof diagnosis === 'string'),
      labResults: (Array.isArray(data.lab_results) ? data.lab_results : []).map((lab) => {
        const row = isRecord(lab) ? lab : {};
        return { test: text(row.test), value: text(row.value), referenceRange: text(row.reference_range) };
      }),
    }];
  });
  const items = contextItems.slice(0, MAX_CONTEXT_ITEMS)
    .filter((item) => item.kind === 'allergy' || item.kind === 'condition' || item.kind === 'medication')
    .map((item) => ({ kind: item.kind as 'allergy' | 'condition' | 'medication', text: item.text, confirmed: item.confirmation?.status === 'confirmed' }));
  return { documents: docs, contextItems: items };
}

export interface ControlQuestionsOptions {
  authenticate?: RequestHandler;
  getDb?: typeof getAdminClient;
  agent?: ReturnType<typeof createLocalAgentClient>;
  loadContext?: (patientId: string) => Promise<ContextRow[]>;
  save?: (patientId: string, data: Record<string, unknown>) => Promise<unknown>;
  now?: () => Date;
}

export function createControlQuestionsRouter(options: ControlQuestionsOptions = {}) {
  const router = Router();
  const authenticate = options.authenticate ?? requireUser;

  async function findCase(db: ReturnType<typeof getAdminClient>, caseId: string) {
    const found = await db.from('cases').select('patient_id,doctor_id').eq('id', caseId).maybeSingle();
    if (found.error) throw found.error;
    return found.data as { patient_id: string; doctor_id: string } | null;
  }

  // POST /cases/:id/control-questions — only the case's doctor. Body: {}.
  router.post('/:id/control-questions', authenticate, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success || !z.strictObject({}).safeParse(request.body ?? {}).success) {
      response.status(400).json({ error: 'Cerere invalidă.' });
      return;
    }
    const user = response.locals.user as CurrentUser;
    if (user.role !== 'doctor') { response.status(403).json({ error: 'Acces nepermis.' }); return; }
    try {
      const db = (options.getDb ?? getAdminClient)();
      const found = await findCase(db, id.data);
      if (!found || found.doctor_id !== user.id) { response.status(404).json({ error: 'Dosarul nu este disponibil.' }); return; }

      const documents = await db.from('medical_documents').select('document_type,extracted_data,review')
        .eq('case_id', id.data).order('created_at', { ascending: true }).limit(MAX_DOCUMENTS);
      if (documents.error) throw documents.error;
      const context = await (options.loadContext ?? (async (patientId) => (await loadPatientContext(patientId)) as unknown as ContextRow[]))(found.patient_id);
      const dossier = buildDossier((documents.data ?? []) as DocumentRow[], context);

      const result = await (options.agent ?? createLocalAgentClient())('control-questions', { caseId: id.data, dossier });
      if (!result.ok) { response.status(result.status).json({ error: result.error }); return; }
      const parsed = GatewayResultSchema.safeParse(result.data);
      if (!parsed.success) { response.status(502).json({ error: 'Răspuns invalid de la agentul local.' }); return; }

      const generatedAt = (options.now ?? (() => new Date()))().toISOString();
      const stored = {
        caseId: id.data, summary: parsed.data.summary, questions: parsed.data.questions, model: parsed.data.model,
        generatedAt, payloadHash: parsed.data.payloadHash, sentToCloud: parsed.data.anonymizedSummary,
      };
      await (options.save ?? ((patientId, data) => upsertMedicalRecord(patientId, CONTROL_QUESTIONS_RECORD, data)))(found.patient_id, stored);

      // Evidence of what left for the cloud: the hash and the model, never the content.
      const disclosed = await db.from('cloud_disclosures').insert({ case_id: id.data, provider: 'gemini', model_name: parsed.data.model, payload_hash: parsed.data.payloadHash });
      if (disclosed.error) console.error('Nu am putut înregistra trimiterea către cloud:', disclosed.error.message);

      response.status(201).json({ controlQuestions: { summary: stored.summary, questions: stored.questions, model: stored.model, generatedAt, sentToCloud: stored.sentToCloud } });
    } catch (error) {
      console.error('Întrebările de control nu au putut fi generate:', error instanceof Error ? error.message : error);
      response.status(503).json({ error: 'Întrebările de control nu au putut fi generate acum.' });
    }
  });

  // GET /cases/:id/control-questions — the case's patient or doctor.
  router.get('/:id/control-questions', authenticate, async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) { response.status(400).json({ error: 'Cerere invalidă.' }); return; }
    const user = response.locals.user as CurrentUser;
    try {
      const db = (options.getDb ?? getAdminClient)();
      const found = await findCase(db, id.data);
      if (!found || (found.patient_id !== user.id && found.doctor_id !== user.id)) { response.status(404).json({ error: 'Dosarul nu este disponibil.' }); return; }
      const record = await db.from('medical_records').select('clinical_data').eq('patient_id', found.patient_id).eq('record_type', CONTROL_QUESTIONS_RECORD).maybeSingle();
      if (record.error) throw record.error;
      const data = record.data?.clinical_data as Record<string, unknown> | undefined;
      const questions = parseStoredQuestions(data);
      if (!data || !questions) { response.json({ controlQuestions: null }); return; }
      response.json({ controlQuestions: { summary: data.summary, questions, model: data.model, generatedAt: data.generatedAt, sentToCloud: data.sentToCloud } });
    } catch {
      response.status(503).json({ error: 'Întrebările de control nu pot fi citite acum.' });
    }
  });

  return router;
}
