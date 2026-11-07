import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import express from 'express';
import { requestAnalysis, requestCaseSummary } from './aiClient';

const summary = {
  metadata: { patientId: '11111111-1111-4111-8111-111111111111', language: 'ro' },
};

async function withAi(
  respond: (response: express.Response) => void,
  run: (seen: { auth?: string | undefined; paths: string[] }) => Promise<void>,
) {
  const seen: { auth?: string | undefined; paths: string[] } = { paths: [] };
  const app = express();
  app.use(express.json());
  app.post(['/analysis', '/case-summary'], (request, response) => {
    seen.auth = request.headers.authorization;
    seen.paths.push(request.path);
    respond(response);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  process.env.AI_URL = `http://127.0.0.1:${address.port}`;
  try { await run(seen); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

const analysisRequest = {
  caseId: '33333333-3333-4333-8333-333333333333',
  caseSummary: summary as never,
  state: null,
};
const summaryRequest = {
  caseId: analysisRequest.caseId,
  patientId: summary.metadata.patientId,
  language: 'ro' as const,
  messages: [{ sender_role: 'patient', content: 'Mesaj sintetic', created_at: '2026-11-07T10:00:00Z' }],
};

afterEach(() => { delete process.env.AI_URL; delete process.env.AI_TOKEN; });

test('without AI_TOKEN no Authorization header is sent (local service, as before)', async () => {
  await withAi((response) => { response.json({ result: { status: 'CLARIFICATION_REQUIRED', data: 'Care e durata?' }, state: null }); }, async (seen) => {
    const result = await requestAnalysis(analysisRequest);
    assert.equal(result.ok, true);
    assert.equal(seen.auth, undefined);
  });
});

test('with AI_TOKEN both AI calls send it as a Bearer header', async () => {
  process.env.AI_TOKEN = 'synthetic-ai-token';
  await withAi((response) => { response.status(500).json({ error: 'x' }); }, async (seen) => {
    await requestAnalysis(analysisRequest);
    assert.equal(seen.auth, 'Bearer synthetic-ai-token');
    seen.auth = undefined;
    await requestCaseSummary(summaryRequest);
    assert.equal(seen.auth, 'Bearer synthetic-ai-token');
    assert.deepEqual(seen.paths, ['/analysis', '/case-summary']);
  });
});

test('a failing AI service is a generic 502 that never repeats the service error text', async () => {
  await withAi((response) => { response.status(502).json({ error: 'AI_CLOUD_FAILED key AIza-secret' }); }, async () => {
    const result = await requestAnalysis(analysisRequest);
    assert.deepEqual(result, { ok: false, status: 502, error: 'Analiza AI a eșuat' });
  });
});

test('without AI_URL the analysis is reported unavailable (503)', async () => {
  delete process.env.AI_URL;
  const result = await requestAnalysis(analysisRequest);
  assert.equal(result.ok ? null : result.status, 503);
});
