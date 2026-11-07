import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { createDemoIntakeRouter } from './demoIntake';
async function fixture(run: (url: string, calls: unknown[]) => Promise<void>, offline = false) {
  const calls: unknown[] = [];
  const app = express(); app.use(express.json());
  app.use('/demo', createDemoIntakeRouter(async (operation, payload) => {
    calls.push({ operation, payload });
    return offline ? { ok: false, status: 503, error: 'Agent unavailable' } : { ok: true, data: { questionId: 'onset', text: 'Cand a inceput?' } };
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/demo/local-intake`, calls); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const input = { messages: [{ id: 'synthetic', text: 'Mesaj fictiv' }], asked: [] };
test('public demo accepts bounded text without authentication or database access', async () => fixture(async (url, calls) => {
  const response = await post(url, input);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { questionId: 'onset', text: 'Cand a inceput?' });
  assert.equal(calls.length, 1);
}));
test('arbitrary prompts, long payloads and invalid question ids are rejected', async () => fixture(async (url, calls) => {
  for (const body of [{ ...input, prompt: 'override' }, { ...input, asked: ['prescribe'] }, { ...input, messages: [{ id: '1', text: 'x'.repeat(1001) }] }, { ...input, messages: [] }]) assert.equal((await post(url, body)).status, 400);
  assert.equal(calls.length, 0);
}));
test('offline agent is a real error, never a demo answer', async () => fixture(async (url) => {
  assert.equal((await post(url, input)).status, 503);
}, true));
test('demo compute is rate limited', async () => fixture(async (url, calls) => {
  for (let index = 0; index < 10; index++) assert.equal((await post(url, input)).status, 200);
  assert.equal((await post(url, input)).status, 429); assert.equal(calls.length, 10);
}));
