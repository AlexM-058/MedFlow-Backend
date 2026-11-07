import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import {
  confirmedMedicationsFromReview,
  createDocumentReviewRouter,
  validateReview,
  type ReviewedFieldInput,
} from './documentReview';
import type { getAdminClient } from './supabaseAdmin';

const patient = '11111111-1111-4111-8111-111111111111';
const doctor = '22222222-2222-4222-8222-222222222222';
const caseId = '33333333-3333-4333-8333-333333333333';
const docId = '44444444-4444-4444-8444-444444444444';

const extracted = {
  medications: [
    { name: 'Amlodipină', dose: '5 mg', frequency: '1 cp dimineața', duration: '30 de zile' },
    { name: 'Metformin', dose: null, frequency: '2 cp/zi', duration: null },
  ],
  diagnoses: [],
  lab_results: [],
  dates: [],
  warnings: [],
};

const at = '2026-11-07T10:00:00.000Z';
function field(index: number, key: string, extractedValue: string | null, value: string | null): ReviewedFieldInput {
  return {
    path: `medications.${index}.${key}`,
    label: key,
    extracted: extractedValue,
    value,
    confirmation: { status: 'confirmed', by: 'patient', at },
  };
}

// Verificare completă și corectă: toate câmpurile confirmate, doza lipsă introdusă de pacient, durata absentă declarată.
function fullReview(): ReviewedFieldInput[] {
  return [
    field(0, 'name', 'Amlodipină', 'Amlodipină'),
    field(0, 'dose', '5 mg', '5 mg'),
    field(0, 'frequency', '1 cp dimineața', '1 cp dimineața'),
    field(0, 'duration', '30 de zile', '30 de zile'),
    field(1, 'name', 'Metformin', 'Metformin'),
    field(1, 'dose', null, '500 mg'),
    field(1, 'frequency', '2 cp/zi', '2 cp/zi'),
    field(1, 'duration', null, null),
  ];
}

test('a complete review keeps the patient values verbatim', () => {
  const result = validateReview(extracted, fullReview());
  assert.deepEqual(result, {
    ok: true,
    medications: [
      { name: 'Amlodipină', dose: '5 mg', frequency: '1 cp dimineața', duration: '30 de zile' },
      { name: 'Metformin', dose: '500 mg', frequency: '2 cp/zi', duration: null },
    ],
  });
});

test('an incomplete or duplicated review is rejected', () => {
  assert.equal(validateReview(extracted, fullReview().slice(1)).ok, false);
  const duplicated = fullReview();
  duplicated[7] = duplicated[0]!;
  assert.equal(validateReview(extracted, duplicated).ok, false);
});

test('the client cannot change what the reader saw', () => {
  const forged = fullReview();
  forged[1] = field(0, 'dose', '50 mg', '50 mg'); // serviciul a citit „5 mg”
  assert.equal(validateReview(extracted, forged).ok, false);
});

test('only the duration may be declared absent; an empty value is never accepted', () => {
  const noDose = fullReview();
  noDose[5] = field(1, 'dose', null, null);
  assert.equal(validateReview(extracted, noDose).ok, false);
  const blank = fullReview();
  blank[0] = field(0, 'name', 'Amlodipină', '   ');
  assert.equal(validateReview(extracted, blank).ok, false);
});

test('a document without medications, or a failed-extraction stub, cannot be reviewed', () => {
  assert.equal(validateReview({ medications: [] }, fullReview()).ok, false);
  assert.equal(validateReview({ extraction_status: 'unavailable', error: 'x' }, fullReview()).ok, false);
  assert.equal(validateReview(null, fullReview()).ok, false);
});

test('confirmedMedicationsFromReview returns null unless the review is complete', () => {
  assert.equal(confirmedMedicationsFromReview(null), null);
  assert.equal(confirmedMedicationsFromReview({}), null);
  assert.equal(confirmedMedicationsFromReview({ medications: [{ name: 'X', dose: null, frequency: 'zilnic' }] }), null);
  assert.deepEqual(
    confirmedMedicationsFromReview({ medications: [{ name: 'X', dose: '5 mg', frequency: 'zilnic', duration: null }] }),
    [{ name: 'X', dose: '5 mg', frequency: 'zilnic', duration: null }],
  );
});

async function fixture(
  settings: { role?: 'patient' | 'doctor'; stranger?: boolean; noDocument?: boolean; extractedData?: unknown; authenticated?: boolean },
  run: (url: string, calls: string[], updates: Record<string, unknown>[]) => Promise<void>,
) {
  const calls: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const query = {
        select() { return query; },
        eq() { return query; },
        update(value: Record<string, unknown>) { calls.push(`update:${table}`); updates.push(value); return query; },
        async maybeSingle() {
          if (table === 'cases') return { data: { patient_id: patient }, error: null };
          return settings.noDocument
            ? { data: null, error: null }
            : { data: { id: docId, extracted_data: settings.extractedData ?? extracted }, error: null };
        },
        async single() { return { data: { id: docId, ...updates[0] }, error: null }; },
      };
      return query;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/cases', createDocumentReviewRouter({
    getDb: () => db as unknown as ReturnType<typeof getAdminClient>,
    authenticate: (_request, response, next) => {
      if (settings.authenticated === false) { response.sendStatus(401); return; }
      response.locals.user = { id: settings.stranger ? doctor : patient, role: settings.role ?? 'patient' };
      next();
    },
    afterReview: async (patientId) => { calls.push(`summaries:${patientId}`); },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/cases/${caseId}/documents/${docId}/review`, calls, updates); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('anonymous users and doctors cannot save a review', async () => {
  await fixture({ authenticated: false }, async (url, calls) => {
    assert.equal((await post(url, { fields: fullReview() })).status, 401);
    assert.deepEqual(calls, []);
  });
  await fixture({ role: 'doctor' }, async (url, calls) => {
    assert.equal((await post(url, { fields: fullReview() })).status, 403);
    assert.deepEqual(calls, []);
  });
});

test('a patient who does not own the case gets 404 and nothing is written', async () => {
  await fixture({ stranger: true }, async (url, calls) => {
    assert.equal((await post(url, { fields: fullReview() })).status, 404);
    assert.deepEqual(calls, []);
  });
});

test('malformed bodies are rejected before any database write', async () => {
  await fixture({}, async (url, calls) => {
    assert.equal((await post(url, {})).status, 400);
    assert.equal((await post(url, { fields: [] })).status, 400);
    assert.equal((await post(url, { fields: fullReview(), extra: true })).status, 400);
    const unconfirmed = fullReview();
    unconfirmed[0] = { ...unconfirmed[0]!, confirmation: { status: 'unconfirmed' as 'confirmed', by: 'patient', at } };
    assert.equal((await post(url, { fields: unconfirmed })).status, 400);
    assert.deepEqual(calls, []);
  });
});

test('a missing document is 404 and an inconsistent review is 422 without writing', async () => {
  await fixture({ noDocument: true }, async (url, calls) => {
    assert.equal((await post(url, { fields: fullReview() })).status, 404);
    assert.deepEqual(calls, []);
  });
  await fixture({}, async (url, calls) => {
    assert.equal((await post(url, { fields: fullReview().slice(1) })).status, 422);
    assert.deepEqual(calls, []);
  });
});

test('a valid review is saved with the reviewer, keeps extracted_data untouched and refreshes the summaries', async () => {
  await fixture({}, async (url, calls, updates) => {
    const response = await post(url, { fields: fullReview() });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['update:medical_documents', `summaries:${patient}`]);
    const update = updates[0]!;
    assert.equal(update.reviewed_by, patient);
    assert.ok(typeof update.reviewed_at === 'string');
    assert.ok(!('extracted_data' in update), 'the extractor output must never be overwritten');
    assert.deepEqual((update.review as { medications: unknown[] }).medications.length, 2);
  });
});
