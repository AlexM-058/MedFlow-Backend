import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser, type CurrentUser } from './auth';
import { getAdminClient } from './supabaseAdmin';
import { loadPatientContext } from './patientContext';

type CaseRow = { id: string; patient_id: string; doctor_id: string; status: string; created_at: string; updated_at: string };
type MessageRow = { id: string; case_id: string; sender_role: string; content: string; created_at: string };
type DecisionRow = { id: string; case_id: string; doctor_id: string; final_response: string; created_at: string };
type Page = { offset: number; limit: number };
export interface CaseViewStore {
  list(user: CurrentUser, page: Page): Promise<CaseRow[]>;
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
    try { response.json({ cases: await repository.list(response.locals.user, page.data) }); }
    catch { response.status(503).json({ error: 'Dosarele nu pot fi încărcate.', code: 'SERVICE_UNAVAILABLE' }); }
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
