import assert from 'node:assert/strict';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { createAccountRouter } from './index';
import { accountLink } from './links';
import type { AccountTransport, RpcResult } from './transport';

const id = '12345678-1234-4234-8234-123456789012';
const code = 'synthetic_connection_code_12345';
const doctor = { id, fullName: 'Synthetic Doctor', specialty: 'General practice', clinic: 'Synthetic Clinic' };
const profile = { id, fullName: 'Synthetic Patient', email: 'patient@example.test', role: 'patient', activeDoctors: [] };
const connection = { id, status: 'pending', createdAt: '2026-11-06T12:00:00.000Z',
  doctor, patient: { id, fullName: 'Synthetic Patient' } };

async function fixture(t: TestContext, result: RpcResult = { data: { profile }, error: null }) {
  const calls: { name: string; parameters: Record<string, string>; token?: string }[] = [];
  let verificationError = false;
  const transport: AccountTransport = {
    async verifyToken(token) { if (verificationError) throw new Error('private upstream detail'); return token === 'valid-token'; },
    async rpc(name, parameters, token) {
      calls.push({ name, parameters, ...(token ? { token } : {}) });
      return result;
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createAccountRouter({ transport, environment: { APP_ORIGIN: 'https://medflow.example', APP_BASE_PATH: '/app/' } }));
  app.get('/unrelated', (_request, response) => response.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { calls, setVerificationError: () => { verificationError = true; },
    request: (path: string, method = 'GET', body?: unknown, token: string | null = 'valid-token', headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, { method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  };
}

test('requires validated bearer identity; missing, expired and malformed tokens never call RPC', async t => {
  const f = await fixture(t);
  for (const token of [null, 'expired-token', 'valid-token,extra']) {
    const response = await f.request('/me', 'GET', undefined, token);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  }
  assert.equal(f.calls.length, 0);
});

test('forwards validated user JWT and derives profile only from server response', async t => {
  const f = await fixture(t);
  const response = await f.request('/me');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { profile });
  assert.deepEqual(f.calls, [{ name: 'medflow_get_me', parameters: {}, token: 'valid-token' }]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('preview is public and strips all nonprofessional fields', async t => {
  const f = await fixture(t, { data: { doctor: { ...doctor, email: 'private@example.test', patients: ['private'] } }, error: null });
  const response = await f.request(`/connect/${code}`, 'GET', undefined, null);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { doctor });
  assert.deepEqual(f.calls, [{ name: 'medflow_preview_doctor', parameters: { p_code: code } }]);
});

test('rejects client identity/role overrides and invalid path/body before calling RPC', async t => {
  const f = await fixture(t);
  const attempts: [string, string, unknown][] = [
    ['/connection-requests', 'POST', { code, role: 'doctor' }],
    ['/doctor-invitations/accept', 'POST', { token: code, userId: id }],
    ['/doctor/connection-code/rotate', 'POST', { doctorId: id }],
    ['/connection-requests/not-a-uuid', 'PATCH', { action: 'accept' }],
    [`/connection-requests/${id}`, 'PATCH', { action: 'accepted' }],
    ['/connect/short', 'GET', undefined],
  ];
  for (const [path, method, body] of attempts) assert.equal((await f.request(path, method, body)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('invitation acceptance sends only token to the guarded database function', async t => {
  const f = await fixture(t, { data: { profile: { ...profile, role: 'doctor' } }, error: null });
  assert.equal((await f.request('/doctor-invitations/accept', 'POST', { token: code })).status, 200);
  assert.deepEqual(f.calls[0], { name: 'medflow_accept_doctor_invitation', parameters: { p_token: code }, token: 'valid-token' });
});

for (const [machineCode, status] of Object.entries({ FORBIDDEN: 403, GOOGLE_REQUIRED: 403,
  INVITATION_EMAIL_MISMATCH: 403, INVITATION_EXPIRED: 410, INVITATION_REVOKED: 410,
  INVITATION_USED: 409, CONNECTION_NOT_PENDING: 409, NOT_FOUND: 404 })) {
  test(`maps guarded database ${machineCode} to ${status}`, async t => {
    const f = await fixture(t, { data: null, error: { code: 'P0001', message: machineCode } });
    const response = await f.request(`/connection-requests/${id}`, 'PATCH', { action: 'accept' });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, machineCode);
  });
}

test('unknown database errors and malformed success payloads fail closed without details', async t => {
  for (const result of [{ data: null, error: { code: '42P01', message: 'private SQL information' } },
    { data: { profile: { ...profile, role: 'admin' } }, error: null }]) {
    const f = await fixture(t, result);
    const response = await f.request('/me');
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private|SQL|admin/);
  }
});

test('identity service outages are retryable and never call RPC', async t => {
  const f = await fixture(t);
  f.setVerificationError();
  assert.equal((await f.request('/me')).status, 503);
  assert.equal(f.calls.length, 0);
});

test('connection creation preserves persisted idempotency and sends no caller IDs', async t => {
  for (const created of [true, false]) {
    const f = await fixture(t, { data: { request: connection, created }, error: null });
    const response = await f.request('/connection-requests', 'POST', { code });
    assert.equal(response.status, created ? 201 : 200);
    assert.deepEqual(await response.json(), { request: connection });
    assert.deepEqual(f.calls[0]?.parameters, { p_code: code });
  }
});

test('canonical QR links ignore hostile request headers', async t => {
  const f = await fixture(t, { data: { connectionCode: { code } }, error: null });
  const response = await f.request('/doctor/connection-code', 'GET', undefined, 'valid-token', { Origin: 'https://attacker.example' });
  assert.deepEqual(await response.json(), { connectionCode: { code, url: `https://medflow.example/app/#/connect/${code}` } });
});

test('list, cancellation and rotation use scoped RPCs with exactly the permitted arguments', async t => {
  const list = await fixture(t, { data: { requests: [connection] }, error: null });
  assert.equal((await list.request('/connection-requests')).status, 200);
  assert.deepEqual(list.calls[0], { name: 'medflow_list_connection_requests', parameters: {}, token: 'valid-token' });
  const cancel = await fixture(t, { data: { request: { ...connection, status: 'cancelled' } }, error: null });
  assert.equal((await cancel.request(`/connection-requests/${id}`, 'PATCH', { action: 'cancel' })).status, 200);
  assert.deepEqual(cancel.calls[0], { name: 'medflow_update_connection', parameters: { p_action: 'cancel', p_id: id }, token: 'valid-token' });
  const rotate = await fixture(t, { data: { connectionCode: { code } }, error: null });
  assert.equal((await rotate.request('/doctor/connection-code/rotate', 'POST', {})).status, 200);
  assert.deepEqual(rotate.calls[0], { name: 'medflow_rotate_connection_code', parameters: {}, token: 'valid-token' });
});

test('invitation attempts have a stricter independent throttle', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 10; index++) {
    assert.equal((await f.request('/doctor-invitations/accept', 'POST', { token: code })).status, 200);
  }
  assert.equal((await f.request('/doctor-invitations/accept', 'POST', { token: code })).status, 429);
  assert.equal((await f.request('/me')).status, 200);
  assert.equal(f.calls.length, 11);
});

test('link configuration rejects credentials, arbitrary HTTP, queries and traversal', () => {
  for (const origin of ['http://medflow.example', 'https://user:pass@medflow.example', 'https://medflow.example/?x=1', 'https://medflow.example/path']) {
    assert.throws(() => accountLink('connect/test', { APP_ORIGIN: origin }));
  }
  for (const base of ['//evil.example/', '/../', '/app?x=1/', '/app']) {
    assert.throws(() => accountLink('connect/test', { APP_BASE_PATH: base }));
  }
});

test('preview throttle ignores spoofed forwarded addresses and does not limit unrelated routes', async t => {
  const f = await fixture(t, { data: { doctor }, error: null });
  for (let index = 0; index < 60; index++) {
    assert.equal((await f.request(`/connect/${code}`, 'GET', undefined, null, { 'X-Forwarded-For': `192.0.2.${index}` })).status, 200);
  }
  const limited = await f.request(`/connect/${code}`, 'GET', undefined, null, { 'X-Forwarded-For': '192.0.2.250' });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  assert.equal((await f.request('/unrelated')).status, 200);
});
