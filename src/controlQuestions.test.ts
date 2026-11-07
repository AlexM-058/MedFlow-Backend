import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { buildDossier, createControlQuestionsRouter, parseStoredQuestions, toIsoDate, type ContextRow } from './controlQuestions';
import { createLocalAgentRouter } from './localAgentRoutes';
import type { getAdminClient } from './supabaseAdmin';

const patient = '11111111-1111-4111-8111-111111111111';
const doctor = '22222222-2222-4222-8222-222222222222';
const stranger = '44444444-4444-4444-8444-444444444444';
const caseId = '33333333-3333-4333-8333-333333333333';
const hash = 'a'.repeat(64);

// ---------- pure parts ----------

test('toIsoDate converts the dates found in documents and refuses impossible or ambiguous ones', () => {
  assert.equal(toIsoDate('14.03.2025'), '2025-03-14');
  assert.equal(toIsoDate('2/11/2025'), '2025-11-02');
  assert.equal(toIsoDate('2025-03-14'), '2025-03-14');
  assert.equal(toIsoDate('31.02.2025'), null);
  assert.equal(toIsoDate('14.03.25'), null);
  assert.equal(toIsoDate('martie 2025'), null);
  assert.equal(toIsoDate(null), null);
});

const reviewedDoc = {
  document_type: 'prescription',
  extracted_data: { medications: [{ name: 'Amlodipină', dose: '5 mg' }], diagnoses: ['Hipertensiune arterială'], lab_results: [{ test: 'Glicemie', value: '130', reference_range: '70 - 110' }], dates: [{ label: 'Data emiterii', value: '14.03.2025' }] },
  review: { medications: [{ name: 'Amlodipină', dose: '10 mg', frequency: 'zilnic', duration: null }] },
};
const unreviewedDoc = { document_type: 'prescription', extracted_data: { medications: [{ name: 'Metformin' }], diagnoses: [], lab_results: [], dates: [] }, review: null };

test('buildDossier marks a document reviewed only when the patient confirmed its medicines', () => {
  const dossier = buildDossier([reviewedDoc, unreviewedDoc], []);
  assert.equal(dossier.documents.length, 2);
  assert.deepEqual(dossier.documents.map((document) => document.reviewed), [true, false]);
  assert.deepEqual(dossier.documents[0]!.medications, [{ name: 'Amlodipină' }]); // the confirmed list, not the reader output
  assert.deepEqual(dossier.documents[1]!.medications, [{ name: 'Metformin' }]); // unreviewed: kept only so the gateway can count it
  assert.equal(dossier.documents[0]!.documentDate, '2025-03-14');
  assert.ok(dossier.documents.every((document) => !('diagnosesAndLabsConfirmed' in document)), 'diagnoses and labs are never marked confirmed');
});

test('buildDossier skips failed readings and malformed rows, and keeps only supported context items', () => {
  const context: ContextRow[] = [
    { kind: 'condition', text: 'diabet', confirmation: { status: 'confirmed' } },
    { kind: 'allergy', text: 'penicilină', confirmation: { status: 'unconfirmed' } },
    { kind: 'medication', text: 'metformin', confirmation: null },
    { kind: 'address', text: 'Str. Florilor 12', confirmation: { status: 'confirmed' } },
  ];
  const dossier = buildDossier([
    { document_type: 'prescription', extracted_data: { extraction_status: 'unavailable', error: 'x' }, review: null },
    { document_type: 'prescription', extracted_data: null, review: null },
    { document_type: 'prescription', extracted_data: { medications: 'not a list', lab_results: [5, null] }, review: null },
  ], context);
  assert.equal(dossier.documents.length, 1);
  assert.deepEqual(dossier.contextItems, [
    { kind: 'condition', text: 'diabet', confirmed: true },
    { kind: 'allergy', text: 'penicilină', confirmed: false },
    { kind: 'medication', text: 'metformin', confirmed: false },
  ]);
});

test('parseStoredQuestions accepts only well-formed stored questions', () => {
  const good = { questions: [{ id: 'q1', text: 'Cum vă simțiți azi?', answerType: 'short_text' }] };
  assert.deepEqual(parseStoredQuestions(good), good.questions);
  assert.equal(parseStoredQuestions(null), null);
  assert.equal(parseStoredQuestions({}), null);
  assert.equal(parseStoredQuestions({ questions: [] }), null);
  assert.equal(parseStoredQuestions({ questions: [{ id: 'Q 1', text: 'Cum vă simțiți azi?', answerType: 'yes_no' }] }), null);
  assert.equal(parseStoredQuestions({ questions: [{ id: 'q1', text: 'Cum vă simțiți azi?', answerType: 'yes_no', extra: 1 }] }), null);
});

// ---------- route ----------

const gatewayResult = {
  summary: 'Interval de vârstă 40-49 ani; afecțiuni: diabet zaharat.',
  questions: [{ id: 'q1', text: 'Ați observat sete mai mare?', answerType: 'yes_no' }],
  anonymizedSummary: { version: 1, ageBand: null, sex: null, conditions: ['diabet zaharat'], allergies: [], medications: [], labFindings: [], omittedItemCount: 0 },
  payloadHash: hash, model: 'gemini-3-flash-preview', rejectedQuestionCount: 1,
};

async function fixture(
  settings: { role?: 'patient' | 'doctor'; userId?: string; authenticated?: boolean; agent?: 'ok' | 'down' | 'invalid'; stored?: unknown },
  run: (base: string, spy: { agentCalls: unknown[]; saved: unknown[]; disclosures: unknown[] }) => Promise<void>,
) {
  const spy = { agentCalls: [] as unknown[], saved: [] as unknown[], disclosures: [] as unknown[] };
  const db = {
    from(table: string) {
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; },
        async limit() { return { data: [reviewedDoc, unreviewedDoc], error: null }; },
        async maybeSingle() {
          if (table === 'medical_records') return { data: settings.stored === undefined ? null : { clinical_data: settings.stored }, error: null };
          return { data: { patient_id: patient, doctor_id: doctor }, error: null };
        },
        async insert(value: unknown) { spy.disclosures.push({ table, value }); return { error: null }; },
      };
      return query;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/cases', createControlQuestionsRouter({
    getDb: () => db as unknown as ReturnType<typeof getAdminClient>,
    authenticate: (_request, response, next) => {
      if (settings.authenticated === false) { response.sendStatus(401); return; }
      response.locals.user = { id: settings.userId ?? doctor, role: settings.role ?? 'doctor' };
      next();
    },
    loadContext: async () => [{ kind: 'condition', text: 'Ionescu Maria are diabet, Str. Florilor 12, CNP 2850101223344', confirmation: { status: 'confirmed' } }],
    agent: async (operation, payload) => {
      spy.agentCalls.push({ operation, payload });
      if (settings.agent === 'down') return { ok: false, status: 503, error: 'Agentul local este indisponibil sau ocupat.' };
      if (settings.agent === 'invalid') return { ok: true, data: { summary: 'x' } };
      return { ok: true, data: gatewayResult };
    },
    save: async (patientId, data) => { spy.saved.push({ patientId, data }); },
    now: () => new Date('2026-11-07T10:00:00Z'),
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/cases/${caseId}/control-questions`, spy); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('only the case doctor can generate control questions', async () => {
  await fixture({ authenticated: false }, async (url, spy) => { assert.equal((await post(url)).status, 401); assert.deepEqual(spy.agentCalls, []); });
  await fixture({ role: 'patient', userId: patient }, async (url, spy) => { assert.equal((await post(url)).status, 403); assert.deepEqual(spy.agentCalls, []); });
  await fixture({ userId: stranger }, async (url, spy) => { assert.equal((await post(url)).status, 404); assert.deepEqual(spy.agentCalls, []); });
  await fixture({}, async (url, spy) => { assert.equal((await post(url, { caseSummary: {} })).status, 400); assert.deepEqual(spy.agentCalls, []); });
});

test('the Backend sends the dossier to the LOCAL gateway only, then saves the questions and logs the disclosure', async () => fixture({}, async (url, spy) => {
  const response = await post(url);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(body.controlQuestions.questions, gatewayResult.questions);
  assert.deepEqual(body.controlQuestions.sentToCloud, gatewayResult.anonymizedSummary); // the doctor sees what left
  assert.equal(spy.agentCalls.length, 1);
  assert.equal((spy.agentCalls[0] as { operation: string }).operation, 'control-questions');
  const sentToGateway = JSON.stringify(spy.agentCalls[0]);
  assert.ok(sentToGateway.includes(caseId) && sentToGateway.includes('"reviewed":true'));
  // what is stored and what is logged contain no patient text, only the cloud-bound summary and the hash
  assert.equal(spy.saved.length, 1);
  assert.equal((spy.saved[0] as { patientId: string }).patientId, patient);
  const saved = JSON.stringify(spy.saved[0]);
  for (const secret of ['Ionescu', 'Maria', 'Florilor', '2850101223344']) assert.ok(!saved.includes(secret), `${secret} must not be stored`);
  assert.deepEqual(spy.disclosures, [{ table: 'cloud_disclosures', value: { case_id: caseId, provider: 'gemini', model_name: 'gemini-3-flash-preview', payload_hash: hash } }]);
}));

test('a gateway failure or an invalid answer saves nothing and logs nothing', async () => {
  await fixture({ agent: 'down' }, async (url, spy) => {
    assert.equal((await post(url)).status, 503);
    assert.deepEqual([spy.saved, spy.disclosures], [[], []]);
  });
  await fixture({ agent: 'invalid' }, async (url, spy) => {
    assert.equal((await post(url)).status, 502);
    assert.deepEqual([spy.saved, spy.disclosures], [[], []]);
  });
});

test('the patient and the doctor of the case can read the stored questions, nobody else', async () => {
  const stored = { summary: 'Rezumat.', questions: gatewayResult.questions, model: 'm', generatedAt: '2026-11-07T10:00:00.000Z', sentToCloud: gatewayResult.anonymizedSummary };
  await fixture({ role: 'patient', userId: patient, stored }, async (url) => {
    const body = await (await fetch(url)).json();
    assert.deepEqual(body.controlQuestions.questions, gatewayResult.questions);
  });
  await fixture({ stored }, async (url) => assert.equal((await fetch(url)).status, 200));
  await fixture({ userId: stranger, stored }, async (url) => assert.equal((await fetch(url)).status, 404));
  await fixture({}, async (url) => assert.deepEqual(await (await fetch(url)).json(), { controlQuestions: null }));
  await fixture({ stored: { summary: 'x', questions: [{ id: 'BAD' }] } }, async (url) => assert.deepEqual(await (await fetch(url)).json(), { controlQuestions: null }));
});

// ---------- the local agent asks the stored questions ----------

async function intakeFixture(stored: unknown, run: (url: string, payloads: Record<string, unknown>[]) => Promise<void>) {
  const payloads: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const query = {
        select() { return query; }, eq() { return query; }, order() { return query; },
        async maybeSingle() {
          if (table === 'medical_records') return { data: stored === undefined ? null : { clinical_data: stored }, error: null };
          return { data: { patient_id: patient, doctor_id: doctor }, error: null };
        },
        async limit() { return { data: [{ id: 'm1', sender_role: 'patient', content: 'Am sete.' }, { id: 'a1', sender_role: 'ai', content: 'Prima întrebare?' }], error: null }; },
        insert(value: unknown) { return { select() { return { async single() { return { data: value, error: null }; } }; } }; },
      };
      return query;
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/cases', createLocalAgentRouter({
    getDb: () => db as unknown as ReturnType<typeof getAdminClient>,
    authenticate: (_request, response, next) => { response.locals.user = { id: patient, role: 'patient' }; next(); },
    agent: async (_operation, payload) => { payloads.push(payload as Record<string, unknown>); return { ok: true, data: { questionId: 'q1', text: 'Ați observat sete mai mare?' } }; },
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/cases/${caseId}/intake-question`, payloads); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('the patient agent gets the stored control questions, and the fixed list when there are none', async () => {
  await intakeFixture({ questions: gatewayResult.questions }, async (url, payloads) => {
    assert.equal((await post(url)).status, 201);
    assert.deepEqual(payloads[0]!.questions, gatewayResult.questions);
    assert.deepEqual(payloads[0]!.askedTexts, ['Prima întrebare?']);
  });
  await intakeFixture(undefined, async (url, payloads) => {
    assert.equal((await post(url)).status, 201);
    assert.ok(!('questions' in payloads[0]!));
  });
  await intakeFixture({ questions: [{ id: 'BAD', text: 'x', answerType: 'yes_no' }] }, async (url, payloads) => {
    assert.equal((await post(url)).status, 201);
    assert.ok(!('questions' in payloads[0]!), 'a malformed stored record is ignored, never forwarded');
  });
});
