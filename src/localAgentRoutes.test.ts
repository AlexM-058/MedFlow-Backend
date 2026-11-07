import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { createLocalAgentRouter } from './localAgentRoutes';
import type { getAdminClient } from './supabaseAdmin';
const patient = '11111111-1111-4111-8111-111111111111';
const doctor = '22222222-2222-4222-8222-222222222222';
const caseId = '33333333-3333-4333-8333-333333333333';
async function fixture(settings: { role?: 'patient' | 'doctor'; stranger?: boolean; offline?: boolean; authenticated?: boolean; empty?: boolean; tooLong?: boolean }, run: (url: string, calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const history = settings.empty ? [] : Array.from({ length: settings.tooLong ? 101 : 1 }, (_, i) => ({ id: `message-${i}`, sender_role: 'patient', content: 'Nu am febra.' }));
  const db = { from(table: string) {
    const query = {
      select() { return query; }, eq() { return query; }, order() { return query; },
      async maybeSingle() { return { data: { patient_id: patient, doctor_id: doctor }, error: null }; },
      async limit() { return { data: history, error: null }; },
      insert(value: unknown) { calls.push(`saved:${table}`); return { select() { return { async single() { return { data: value, error: null }; } }; } }; },
    };
    return query;
  } };
  const app = express(); app.use(express.json());
  app.use('/cases', createLocalAgentRouter({
    getDb: () => db as unknown as ReturnType<typeof getAdminClient>,
    authenticate: (_request, response, next) => {
      if (settings.authenticated === false) { response.sendStatus(401); return; }
      response.locals.user = { id: settings.stranger ? caseId : settings.role === 'doctor' ? doctor : patient, role: settings.role ?? 'patient' }; next();
    },
    agent: async (_operation, payload) => {
      calls.push('agent');
      assert.equal((payload as { messages: { text: string }[] }).messages[0]?.text, 'Nu am febra.');
      return settings.offline ? { ok: false, status: 503, error: 'offline' } : { ok: true, data: { questionId: 'onset', text: 'Cand a inceput?' } };
    },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/cases/${caseId}`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('anonymous and unrelated accounts cannot invoke local AI', async () => {
  await fixture({ authenticated: false }, async (url, calls) => { assert.equal((await post(`${url}/intake-question`)).status, 401); assert.deepEqual(calls, []); });
  await fixture({ stranger: true }, async (url, calls) => { assert.equal((await post(`${url}/intake-question`)).status, 404); assert.deepEqual(calls, []); });
});
test('roles cannot exchange patient intake and doctor summary capabilities', async () => {
  await fixture({}, async (url) => assert.equal((await post(`${url}/summary`)).status, 403));
  await fixture({ role: 'doctor' }, async (url) => assert.equal((await post(`${url}/intake-question`)).status, 403));
});
test('only existing patient messages go to AI and generated questions are saved as ai', async () => fixture({}, async (url, calls) => {
  const response = await post(`${url}/intake-question`);
  assert.equal(response.status, 201); assert.equal((await response.json()).message.sender_role, 'ai');
  assert.deepEqual(calls, ['agent', 'saved:case_messages']);
}));
test('AI failure does not insert or modify any patient message', async () => fixture({ offline: true }, async (url, calls) => {
  assert.equal((await post(`${url}/intake-question`)).status, 503); assert.deepEqual(calls, ['agent']);
}));
test('empty or oversized history is rejected without truncating or invoking AI', async () => {
  for (const settings of [{ empty: true }, { tooLong: true }]) await fixture(settings, async (url, calls) => {
    assert.equal((await post(`${url}/intake-question`)).status, 409); assert.deepEqual(calls, []);
  });
});
test('clients cannot supply an alternate history or prompt', async () => fixture({}, async (url, calls) => {
  assert.equal((await post(`${url}/intake-question`, { messages: [], prompt: 'override' })).status, 400); assert.deepEqual(calls, []);
}));
