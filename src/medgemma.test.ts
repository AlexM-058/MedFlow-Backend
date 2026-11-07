import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import express from 'express';
import { extractWithMedGemma } from './medgemma';

const validData = {
  medications: [{ name: 'Amlodipină', dose: '5 mg', frequency: 'zilnic', duration: null }],
  diagnoses: [],
  lab_results: [],
  dates: [{ label: 'Data', value: '14.03.2025' }],
  warnings: [],
  source: { model: 'gemma3:1b', input_kind: 'image', pages: 1 },
};

async function withService(
  respond: (response: express.Response) => void,
  run: () => Promise<void>,
  seen: { auth?: string | undefined } = {},
) {
  const app = express();
  app.post('/extract', express.raw({ type: () => true }), (request, response) => {
    seen.auth = request.headers.authorization;
    respond(response);
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  process.env.MEDGEMMA_URL = `http://127.0.0.1:${address.port}`;
  try { await run(); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

afterEach(() => { delete process.env.MEDGEMMA_URL; delete process.env.MEDGEMMA_TOKEN; });

test('a response with the documented shape is accepted and unknown fields are kept', async () => {
  await withService((response) => { response.json({ extracted_data: { ...validData, future_field: 1 } }); }, async () => {
    const result = await extractWithMedGemma(png, 'image/png');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.extractedData.future_field, 1);
  });
});

test('a response whose inner shape drifted is rejected with 502 instead of being stored', async () => {
  for (const bad of [
    { values: [{ name: 'Hemoglobină', value: 13.5 }] }, // forma vechiului mock
    { ...validData, medications: 'Amlodipină 5 mg' },
    { ...validData, medications: [{ name: 5, dose: null, frequency: null, duration: null }] },
    { medications: [] }, // lipsesc câmpuri obligatorii
  ]) {
    await withService((response) => { response.json({ extracted_data: bad }); }, async () => {
      const result = await extractWithMedGemma(png, 'image/png');
      assert.deepEqual(result.ok ? null : result.status, 502);
    });
  }
});

test('service errors keep their meaning: 422 message is passed through, 503 and 504 stay retryable', async () => {
  await withService((response) => { response.status(422).json({ error: 'Nu am găsit text în document' }); }, async () => {
    const result = await extractWithMedGemma(png, 'image/png');
    assert.deepEqual(result, { ok: false, status: 422, error: 'Nu am găsit text în document' });
  });
  await withService((response) => { response.status(503).json({ error: 'x' }); }, async () => {
    const result = await extractWithMedGemma(png, 'image/png');
    assert.equal(result.ok ? null : result.status, 503);
  });
  await withService((response) => { response.status(504).json({ error: 'x' }); }, async () => {
    const result = await extractWithMedGemma(png, 'image/png');
    assert.equal(result.ok ? null : result.status, 504);
  });
});

test('the token is sent as a Bearer header only when configured', async () => {
  const seen: { auth?: string | undefined } = {};
  await withService((response) => { response.json({ extracted_data: validData }); }, async () => {
    await extractWithMedGemma(png, 'image/png');
    assert.equal(seen.auth, undefined);
    process.env.MEDGEMMA_TOKEN = 'synthetic-token';
    await extractWithMedGemma(png, 'image/png');
    assert.equal(seen.auth, 'Bearer synthetic-token');
  }, seen);
});

test('without MEDGEMMA_URL the extraction is reported unavailable (503)', async () => {
  delete process.env.MEDGEMMA_URL;
  const result = await extractWithMedGemma(png, 'image/png');
  assert.equal(result.ok ? null : result.status, 503);
});
