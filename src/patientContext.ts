import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser, type CurrentUser } from './auth';
import { getAdminClient } from './supabaseAdmin';

export const PATIENT_CONTEXT_TYPE = 'patient_context_v1';
const status = z.enum(['unconfirmed', 'confirmed', 'unknown']);
const kind = z.enum(['allergy', 'condition', 'medication']);
const timestamp = z.string().datetime({ offset: true });
const confirmation = z.object({ status, by: z.literal('patient').optional(), at: timestamp.optional() });
const dataSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), kind,
  text: z.string().trim().min(1).max(300),
  source: z.object({ kind: z.literal('patient-input'), at: timestamp }),
  confirmation,
  history: z.array(z.object({ status, by: z.literal('patient'), actorId: z.uuid(), at: timestamp })).min(1),
});
export type ContextData = z.infer<typeof dataSchema>;
export type ContextRow = { id: string; patient_id: string; clinical_data: ContextData };
export interface PatientContextStore {
  list(patientId: string): Promise<ContextRow[]>;
  find(patientId: string, id: string): Promise<ContextRow | null>;
  insert(row: ContextRow): Promise<ContextRow>;
  update(row: ContextRow, expectedRevision: number): Promise<ContextRow | null>;
}
const fields = 'id,patient_id,clinical_data';
function decode(row: { id: string; patient_id: string; clinical_data: unknown }): ContextRow {
  return { ...row, clinical_data: dataSchema.parse(row.clinical_data) };
}
const store: PatientContextStore = {
  async list(patientId) {
    const { data, count, error } = await getAdminClient().from('medical_records').select(fields, { count: 'exact' })
      .eq('patient_id', patientId).eq('record_type', PATIENT_CONTEXT_TYPE)
      .order('created_at').order('id').limit(1000);
    if (error) throw error;
    if (count === null || count > data.length) throw new Error('Context exceeds supported size');
    return data.map(decode);
  },
  async find(patientId, id) {
    const { data, error } = await getAdminClient().from('medical_records').select(fields)
      .eq('patient_id', patientId).eq('record_type', PATIENT_CONTEXT_TYPE).eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? decode(data) : null;
  },
  async insert(row) {
    const { data, error } = await getAdminClient().from('medical_records')
      .insert({ ...row, record_type: PATIENT_CONTEXT_TYPE }).select(fields).single();
    if (error) throw error;
    return decode(data);
  },
  async update(row, expectedRevision) {
    const { data, error } = await getAdminClient().from('medical_records')
      .update({ clinical_data: row.clinical_data }).eq('id', row.id).eq('patient_id', row.patient_id)
      .eq('record_type', PATIENT_CONTEXT_TYPE).eq('clinical_data->>revision', String(expectedRevision))
      .select(fields).maybeSingle();
    if (error) throw error;
    return data ? decode(data) : null;
  },
};
export function contextItem(row: ContextRow) {
  const { kind, text, source, confirmation, revision, history } = row.clinical_data;
  return { id: row.id, kind, text, source, confirmation, revision, history };
}
export async function loadPatientContext(patientId: string) {
  return (await store.list(patientId)).map(contextItem);
}

export function createPatientContextRouter(options: { authenticate?: RequestHandler; store?: PatientContextStore; now?: () => Date } = {}) {
  const router = Router();
  const repository = options.store ?? store;
  const now = options.now ?? (() => new Date());
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.use(options.authenticate ?? requireUser);
  router.use((_request, response, next) => {
    if ((response.locals.user as CurrentUser | undefined)?.role !== 'patient') {
      response.status(403).json({ error: 'Doar pacientul poate modifica propriul context.', code: 'FORBIDDEN' }); return;
    }
    next();
  });
  router.get('/', async (_request, response) => {
    try { response.json({ items: (await repository.list(response.locals.user.id)).map(contextItem) }); }
    catch { response.status(503).json({ error: 'Istoricul nu poate fi încărcat.', code: 'SERVICE_UNAVAILABLE' }); }
  });
  router.post('/items', async (request, response) => {
    const body = z.strictObject({ kind, text: z.string().trim().min(1).max(300) }).safeParse(request.body);
    if (!body.success) { response.status(400).json({ error: 'Informație invalidă.', code: 'INVALID_REQUEST' }); return; }
    const user = response.locals.user as CurrentUser;
    const at = now().toISOString();
    const row: ContextRow = { id: randomUUID(), patient_id: user.id, clinical_data: {
      version: 1, revision: 0, ...body.data,
      source: { kind: 'patient-input', at }, confirmation: { status: 'unconfirmed' },
      history: [{ status: 'unconfirmed', by: 'patient', actorId: user.id, at }],
    } };
    try { response.status(201).json({ item: contextItem(await repository.insert(row)) }); }
    catch { response.status(503).json({ error: 'Informația nu a putut fi salvată.', code: 'SERVICE_UNAVAILABLE' }); }
  });
  router.post('/items/:id/:action', async (request, response) => {
    const id = z.uuid().safeParse(request.params.id);
    const action = z.enum(['confirm', 'unknown']).safeParse(request.params.action);
    if (!id.success || !action.success || !z.strictObject({}).safeParse(request.body ?? {}).success) {
      response.status(400).json({ error: 'Cerere invalidă.', code: 'INVALID_REQUEST' }); return;
    }
    const user = response.locals.user as CurrentUser;
    try {
      const found = await repository.find(user.id, id.data);
      if (!found) { response.status(404).json({ error: 'Informația nu este disponibilă.', code: 'NOT_FOUND' }); return; }
      const target = action.data === 'confirm' ? 'confirmed' : 'unknown';
      const previous = found.clinical_data;
      if (previous.confirmation.status === target) { response.json({ item: contextItem(found) }); return; }
      if (previous.confirmation.status === 'confirmed') {
        response.status(409).json({ error: 'Informația a fost deja confirmată.', code: 'CONTEXT_CONFLICT' }); return;
      }
      const at = now().toISOString();
      const updated = await repository.update({ ...found, clinical_data: {
        ...previous, revision: previous.revision + 1,
        confirmation: { status: target, by: 'patient', at },
        history: [...previous.history, { status: target, by: 'patient', actorId: user.id, at }],
      } }, previous.revision);
      if (!updated) { response.status(409).json({ error: 'Informația s-a schimbat. Reîmprospătați istoricul.', code: 'CONTEXT_CONFLICT' }); return; }
      response.json({ item: contextItem(updated) });
    } catch { response.status(503).json({ error: 'Confirmarea nu a putut fi salvată.', code: 'SERVICE_UNAVAILABLE' }); }
  });
  return router;
}
