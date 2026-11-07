import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { createPatientContextRouter, type ContextRow, type PatientContextStore } from './patientContext';
import { CreateMedicalRecordBodySchema } from './schemas';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const fixedTime = '2026-11-07T02:00:00.000Z';
async function fixture(run: (url: string, rows: ContextRow[]) => Promise<void>, settings: { role?: string; authenticated?: boolean; conflict?: boolean } = {}) {
  const rows: ContextRow[] = [];
  const repository: PatientContextStore = {
    async list(patientId) { return structuredClone(rows.filter((row) => row.patient_id === patientId)); },
    async find(patientId, id) { return structuredClone(rows.find((row) => row.id === id && row.patient_id === patientId) ?? null); },
    async insert(row) { rows.push(structuredClone(row)); return structuredClone(row); },
    async update(row, revision) {
      const index = rows.findIndex((value) => value.id === row.id && value.patient_id === row.patient_id && value.clinical_data.revision === revision);
      if (index < 0 || settings.conflict) return null;
      rows[index] = structuredClone(row); return structuredClone(row);
    },
  };
  const app = express(); app.use(express.json());
  app.use('/patient/context', createPatientContextRouter({ store: repository, now: () => new Date(fixedTime), authenticate: (_request, response, next) => {
    if (settings.authenticated === false) { response.sendStatus(401); return; }
    response.locals.user = { id: owner, role: settings.role ?? 'patient' }; next();
  } }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/patient/context`, rows); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function add(url: string) {
  const response = await post(`${url}/items`, { kind: 'allergy', text: ' Alergie sintetica declarata ' });
  assert.equal(response.status, 201); return (await response.json()).item;
}

test('signed-out users and doctors cannot use the patient context mutation API', async () => {
  await fixture(async (url) => { assert.equal((await fetch(url)).status, 401); }, { authenticated: false });
  await fixture(async (url) => { assert.equal((await post(`${url}/items`, { kind: 'allergy', text: 'test' })).status, 403); }, { role: 'doctor' });
});
test('source, identity, timestamps and initial status come from the server', async () => fixture(async (url, rows) => {
  const item = await add(url);
  assert.equal(rows[0]?.patient_id, owner);
  assert.equal(item.confirmation.status, 'unconfirmed');
  assert.deepEqual(item.source, { kind: 'patient-input', at: fixedTime });
  assert.equal(item.history[0].actorId, owner);
  assert.equal(item.text, 'Alergie sintetica declarata');
}));
test('caller-supplied identity, source, confirmation and invalid values are rejected', async () => fixture(async (url, rows) => {
  for (const body of [
    { kind: 'allergy', text: 'test', patientId: other },
    { kind: 'allergy', text: 'test', confirmation: { status: 'confirmed', by: 'doctor' } },
    { kind: 'allergy', text: 'test', source: { kind: 'doctor' } },
    { kind: 'diagnosis', text: 'test' }, { kind: 'allergy', text: ' ' }, { kind: 'medication', text: 'x'.repeat(301) },
  ]) assert.equal((await post(`${url}/items`, body)).status, 400);
  assert.equal(rows.length, 0);
}));
test('confirmation retains original source/text and appends history; retry is idempotent', async () => fixture(async (url, rows) => {
  const added = await add(url);
  const response = await post(`${url}/items/${added.id}/confirm`);
  const item = (await response.json()).item;
  assert.equal(item.confirmation.status, 'confirmed'); assert.equal(item.confirmation.by, 'patient');
  assert.deepEqual(item.source, added.source); assert.equal(item.text, added.text);
  assert.equal(item.revision, 1); assert.equal(item.history.length, 2);
  await post(`${url}/items/${added.id}/confirm`);
  assert.equal(rows[0]?.clinical_data.history.length, 2);
  assert.equal((await post(`${url}/items/${added.id}/unknown`)).status, 409);
}));
test('unknown remains stored, and can later be confirmed', async () => fixture(async (url, rows) => {
  const item = await add(url);
  const response = await post(`${url}/items/${item.id}/unknown`);
  assert.equal((await response.json()).item.confirmation.status, 'unknown');
  assert.equal(rows.length, 1); assert.equal(rows[0]?.clinical_data.text, item.text);
  assert.equal((await post(`${url}/items/${item.id}/confirm`)).status, 200);
}));
test('other patients records are neither listed nor modified', async () => fixture(async (url, rows) => {
  const item = await add(url); rows[0]!.patient_id = other;
  assert.deepEqual(await (await fetch(url)).json(), { items: [] });
  assert.equal((await post(`${url}/items/${item.id}/confirm`)).status, 404);
  assert.equal(rows[0]?.clinical_data.revision, 0);
}));
test('concurrent changes return conflict instead of overwriting history', async () => fixture(async (url, rows) => {
  const item = await add(url);
  const response = await post(`${url}/items/${item.id}/confirm`);
  assert.equal(response.status, 409); assert.equal(rows[0]?.clinical_data.history.length, 1);
}, { conflict: true }));
test('action endpoints validate UUID, action and body', async () => fixture(async (url, rows) => {
  const item = await add(url);
  assert.equal((await post(`${url}/items/invalid/confirm`)).status, 400);
  assert.equal((await post(`${url}/items/${item.id}/erase`)).status, 400);
  assert.equal((await post(`${url}/items/${item.id}/confirm`, { by: 'doctor' })).status, 400);
  assert.equal((await post(`${url}/items/${item.id}/confirm`, [])).status, 400);
  assert.equal(rows[0]?.clinical_data.revision, 0);
}));
test('the generic records API cannot overwrite reserved patient context records', () => {
  assert.equal(CreateMedicalRecordBodySchema.safeParse({ recordType: 'patient_context_v1', clinicalData: {} }).success, false);
  assert.equal(CreateMedicalRecordBodySchema.safeParse({ recordType: 'manual_history', clinicalData: {} }).success, true);
});
