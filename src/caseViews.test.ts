import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import type { CurrentUser } from './auth';
import { createCaseViewsRouter, type CaseViewStore } from './caseViews';

const patient = '11111111-1111-4111-8111-111111111111';
const doctor = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const row = { id, patient_id: patient, doctor_id: doctor, status: 'draft', created_at: '2026-11-07T00:00:00Z', updated_at: '2026-11-07T00:00:00Z' };

async function fixture(user: CurrentUser | null, run: (url: string, calls: string[]) => Promise<void>, overrides: Partial<CaseViewStore> = {}) {
  const calls: string[] = [];
  const store: CaseViewStore = {
    async context() { calls.push('context'); return []; },
    async list(owner, page) { calls.push(`list:${owner.id}:${page.offset}:${page.limit}`); return [row]; },
    async find() { return row; },
    async messages() { calls.push('messages'); return [{ id, case_id: id, sender_role: 'patient', content: 'Synthetic message', created_at: row.created_at }]; },
    async feedback() { return null; },
    async saveFeedback(caseId, doctorId, text) { calls.push(`save:${doctorId}:${text}`); return { id, case_id: caseId, doctor_id: doctorId, final_response: text, created_at: row.created_at }; },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/cases', createCaseViewsRouter({ store, authenticate: (_request, response, next) => {
    if (!user) { response.status(401).json({ error: 'Unauthorized' }); return; }
    response.locals.user = user; next();
  } }));
  app.get('/cases/:id', (_request, response) => response.json({ existingRoute: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/cases`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('case views require verified authentication', async () => fixture(null, async (url) => {
  assert.equal((await fetch(url)).status, 401);
}));
test('lists are scoped to the trusted user with bounded pagination', async () => fixture({ id: patient, role: 'patient' }, async (url, calls) => {
  const result = await fetch(`${url}?limit=10&offset=20`);
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [`list:${patient}:20:10`]);
  assert.equal((await fetch(`${url}?limit=101`)).status, 400);
  assert.equal((await fetch(`${url}?patientId=${doctor}`)).status, 400);
}));
test('an unrelated account cannot read messages or decisions', async () => fixture({ id: id, role: 'patient' }, async (url, calls) => {
  assert.equal((await fetch(`${url}/${id}/messages`)).status, 404);
  assert.equal((await fetch(`${url}/${id}/decision`)).status, 404);
  assert.equal((await fetch(`${url}/${id}/context`)).status, 404);
  assert.deepEqual(calls, []);
}));
test('the case participant can read messages and an empty feedback state', async () => fixture({ id: patient, role: 'patient' }, async (url) => {
  assert.equal((await (await fetch(`${url}/${id}/messages`)).json()).messages[0].content, 'Synthetic message');
  assert.deepEqual(await (await fetch(`${url}/${id}/decision`)).json(), { decision: null });
}));
test('patients cannot submit doctor feedback', async () => fixture({ id: patient, role: 'patient' }, async (url, calls) => {
  assert.equal((await fetch(`${url}/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finalResponse: 'test' }) })).status, 403);
  assert.deepEqual(calls, []);
}));
test('only the assigned doctor saves feedback, without caller role overrides', async () => fixture({ id: doctor, role: 'doctor' }, async (url, calls) => {
  const send = (body: unknown) => fetch(`${url}/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send({ finalResponse: ' test ', doctorId: patient })).status, 400);
  const response = await send({ finalResponse: ' Feedback sintetic ' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).decision.final_response, 'Feedback sintetic');
  assert.deepEqual(calls, [`save:${doctor}:Feedback sintetic`]);
}));
test('an unrelated doctor cannot save feedback', async () => fixture({ id: id, role: 'doctor' }, async (url) => {
  assert.equal((await fetch(`${url}/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finalResponse: 'test' }) })).status, 404);
}));
test('the router does not intercept existing case endpoints', async () => fixture(null, async (url) => {
  assert.deepEqual(await (await fetch(`${url}/${id}`)).json(), { existingRoute: true });
}));
test('database failures return a safe retryable response', async () => fixture({ id: patient, role: 'patient' }, async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'SERVICE_UNAVAILABLE');
  assert(!JSON.stringify(body).includes('sensitive'));
}, { async list() { throw new Error('sensitive upstream details'); } }));
test('invalid case ids and feedback are rejected before persistence', async () => fixture({ id: doctor, role: 'doctor' }, async (url, calls) => {
  assert.equal((await fetch(`${url}/not-a-uuid/messages`)).status, 400);
  for (const finalResponse of ['   ', 'x'.repeat(10001)]) {
    assert.equal((await fetch(`${url}/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finalResponse }) })).status, 400);
  }
  assert.deepEqual(calls, []);
}));
