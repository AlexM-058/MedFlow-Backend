import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser, type CurrentUser } from './auth';
import { getAdminClient } from './supabaseAdmin';
import { loadPatientContext } from './patientContext';

type CaseRow = { id: string; patient_id: string; doctor_id: string; status: string; created_at: string; updated_at: string };
type MessageRow = { id: string; case_id: string; sender_role: string; content: string; created_at: string };
type DecisionRow = { id: string; case_id: string; doctor_id: string; final_response: string; created_at: string };
type Page = { offset: number; limit: number };
/** Newest-first messages of one case plus the time of the doctor's latest saved feedback. */
export type CaseSignals = { caseId: string; messages: MessageRow[]; decisionAt: string | null };
export type ReviewState = 'new' | 'needs_review' | 'up_to_date';
export type CaseBacklogFields = {
  last_message: { sender_role: string; content: string; created_at: string } | null;
  review_state: ReviewState;
  last_activity_at: string;
};
const SNIPPET_LENGTH = 140;
const latest = (...stamps: Array<string | null>) => stamps.reduce<string | null>((best, stamp) => (stamp !== null && (best === null || Date.parse(stamp) > Date.parse(best)) ? stamp : best), null);

/**
 * Backlog view of a case for its doctor, derived only from existing data (no new columns):
 * - new: no message from the patient or the doctor yet;
 * - needs_review: the patient wrote after the doctor's latest message or saved feedback;
 * - up_to_date: the doctor answered after the patient's latest message.
 * System messages (e.g. an emergency notice) never count as an answer.
 */
export function summarizeCase(row: CaseRow, signals: CaseSignals | undefined): CaseBacklogFields {
  const messages = signals?.messages ?? [];
  const human = messages.filter((message) => message.sender_role === 'patient' || message.sender_role === 'doctor');
  const lastHuman = human[0] ?? null;
  const lastPatientAt = human.find((message) => message.sender_role === 'patient')?.created_at ?? null;
  const doctorAt = latest(human.find((message) => message.sender_role === 'doctor')?.created_at ?? null, signals?.decisionAt ?? null);
  let reviewState: ReviewState;
  if (lastPatientAt === null) reviewState = doctorAt === null ? 'new' : 'up_to_date';
  else reviewState = doctorAt !== null && Date.parse(doctorAt) >= Date.parse(lastPatientAt) ? 'up_to_date' : 'needs_review';
  const text = lastHuman?.content.trim() ?? '';
  return {
    last_message: lastHuman ? { sender_role: lastHuman.sender_role, content: text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH - 1)}…` : text, created_at: lastHuman.created_at } : null,
    review_state: reviewState,
    last_activity_at: latest(row.updated_at, messages[0]?.created_at ?? null, signals?.decisionAt ?? null) ?? row.updated_at,
  };
}
export interface CaseViewStore {
  list(user: CurrentUser, page: Page): Promise<CaseRow[]>;
  /** Optional: when absent the doctor list is returned without backlog fields. */
  activity?(caseIds: string[]): Promise<CaseSignals[]>;
  find(id: string): Promise<CaseRow | null>;
  messages(id: string, page: Page): Promise<MessageRow[]>;
  feedback(id: string): Promise<DecisionRow | null>;
  saveFeedback(id: string, doctorId: string, text: string): Promise<DecisionRow>;
  context(patientId: string): Promise<Awaited<ReturnType<typeof loadPatientContext>>>;
}

const CASE_FIELDS = 'id,patient_id,doctor_id,status,created_at,updated_at';
const FEEDBACK_FIELDS = 'id,case_id,doctor_id,final_response,created_at';
const store: CaseViewStore = {
  context: loadPatientContext,
  async list(user, page) {
    const { data, error } = await getAdminClient().from('cases').select(CASE_FIELDS)
      .eq(user.role === 'doctor' ? 'doctor_id' : 'patient_id', user.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(page.offset, page.offset + page.limit - 1);
    if (error) throw error;
    return data;
  },
  async activity(caseIds) {
    if (caseIds.length === 0) return [];
    const admin = getAdminClient();
    const [perCase, decisions] = await Promise.all([
      Promise.all(caseIds.map((caseId) => admin.from('case_messages').select('id,case_id,sender_role,content,created_at').eq('case_id', caseId)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(10))),
      admin.from('doctor_decisions').select('case_id,created_at').in('case_id', caseIds).order('created_at', { ascending: false }).limit(1000),
    ]);
    for (const result of perCase) if (result.error) throw result.error;
    if (decisions.error) throw decisions.error;
    const decisionAt = new Map<string, string>();
    for (const decision of decisions.data) if (!decisionAt.has(decision.case_id)) decisionAt.set(decision.case_id, decision.created_at);
    return caseIds.map((caseId, index) => ({ caseId, messages: perCase[index]?.data ?? [], decisionAt: decisionAt.get(caseId) ?? null }));
  },
  async find(id) {
    const { data, error } = await getAdminClient().from('cases').select(CASE_FIELDS).eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  },
  async messages(id, page) {
    const { data, error } = await getAdminClient().from('case_messages')
      .select('id,case_id,sender_role,content,created_at').eq('case_id', id)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(page.offset, page.offset + page.limit - 1);
    if (error) throw error;
    return data;
  },
  async feedback(id) {
    const { data, error } = await getAdminClient().from('doctor_decisions').select(FEEDBACK_FIELDS)
      .eq('case_id', id).order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(1).maybeSingle();
    if (error) throw error;
    return data;
  },
  async saveFeedback(id, doctorId, text) {
    const { data, error } = await getAdminClient().from('doctor_decisions')
      .insert({ case_id: id, doctor_id: doctorId, decision_type: 'custom', final_response: text })
      .select(FEEDBACK_FIELDS).single();
    if (error) throw error;
    return data;
  },
};

const pagination = z.strictObject({
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const idSchema = z.uuid();
const bodySchema = z.strictObject({ finalResponse: z.string().trim().min(1).max(10000) });

/** Additional case views; keeps the existing create/message/upload routes intact. */
export function createCaseViewsRouter(options: { authenticate?: RequestHandler; store?: CaseViewStore } = {}) {
  const router = Router();
  const repository = options.store ?? store;
  router.use((request, _response, next) => {
    const matches = request.method === 'GET'
      ? request.path === '/' || /^\/[^/]+\/(messages|decision|context)\/?$/.test(request.path)
      : request.method === 'POST' && /^\/[^/]+\/decision\/?$/.test(request.path);
    next(matches ? undefined : 'router');
  });
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.use(options.authenticate ?? requireUser);
  router.use((_request, response, next) => {
    const user = response.locals.user as CurrentUser | undefined;
    if (!user || !['patient', 'doctor'].includes(user.role)) {
      response.status(403).json({ error: 'Acces nepermis.', code: 'FORBIDDEN' }); return;
    }
    next();
  });

  router.get('/', async (request, response) => {
    const page = pagination.safeParse(request.query);
    if (!page.success) { response.status(400).json({ error: 'Paginare invalidă.', code: 'INVALID_REQUEST' }); return; }
    try {
      const user = response.locals.user as CurrentUser;
      const rows = await repository.list(user, page.data);
      let cases: unknown[] = rows;
      // Backlog fields are an additive extra for the doctor; if they cannot be read the plain list is still returned.
      if (user.role === 'doctor' && repository.activity && rows.length > 0) {
        try {
          const byCase = new Map((await repository.activity(rows.map((item) => item.id))).map((signals) => [signals.caseId, signals]));
          cases = rows.map((item) => ({ ...item, ...summarizeCase(item, byCase.get(item.id)) }));
        } catch { cases = rows; }
      }
      response.json({ cases });
    } catch { response.status(503).json({ error: 'Dosarele nu pot fi încărcate.', code: 'SERVICE_UNAVAILABLE' }); }
  });

  for (const resource of ['messages', 'decision', 'context'] as const) {
    router.get(`/:id/${resource}`, async (request, response) => {
      const id = idSchema.safeParse(request.params.id);
      const page = pagination.safeParse(request.query);
      if (!id.success || !page.success) { response.status(400).json({ error: 'Cerere invalidă.', code: 'INVALID_REQUEST' }); return; }
      try {
        const found = await repository.find(id.data);
        const user = response.locals.user as CurrentUser;
        if (!found || (user.role === 'doctor' ? found.doctor_id : found.patient_id) !== user.id) {
          response.status(404).json({ error: 'Dosarul nu este disponibil.', code: 'NOT_FOUND' }); return;
        }
        response.json(resource === 'messages' ? { messages: await repository.messages(id.data, page.data) }
          : resource === 'context' ? { items: await repository.context(found.patient_id) }
          : { decision: await repository.feedback(id.data) });
      } catch { response.status(503).json({ error: 'Datele nu pot fi încărcate.', code: 'SERVICE_UNAVAILABLE' }); }
    });
  }
  router.post('/:id/decision', async (request, response) => {
    const user = response.locals.user as CurrentUser;
    if (user.role !== 'doctor') { response.status(403).json({ error: 'Doar medicul trimite feedback.', code: 'FORBIDDEN' }); return; }
    const id = idSchema.safeParse(request.params.id);
    const body = bodySchema.safeParse(request.body);
    if (!id.success || !body.success) { response.status(400).json({ error: 'Feedback invalid.', code: 'INVALID_REQUEST' }); return; }
    try {
      const found = await repository.find(id.data);
      if (!found || found.doctor_id !== user.id) { response.status(404).json({ error: 'Dosarul nu este disponibil.', code: 'NOT_FOUND' }); return; }
      response.status(201).json({ decision: await repository.saveFeedback(id.data, user.id, body.data.finalResponse) });
    } catch { response.status(503).json({ error: 'Feedback-ul nu a putut fi salvat.', code: 'SERVICE_UNAVAILABLE' }); }
  });
  return router;
}
