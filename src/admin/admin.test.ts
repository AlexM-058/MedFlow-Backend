import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import express from 'express';
import { createAdminRouter } from './index';
import type { AccountTransport, RpcResult } from '../account/transport';

const id = '12345678-1234-4234-8234-123456789012';
const rawToken = 'synthetic_invitation_token_0123456789abcdefghijk';
const invitation = {
  id, email: 'doctor@example.test', fullName: 'Synthetic Doctor', specialty: 'Family medicine',
  clinic: 'Synthetic Clinic', status: 'pending', expiresAt: '2026-11-13T12:00:00.000000+00:00',
  acceptedAt: null, revokedAt: null,
};
const validBody = { email: ' Doctor@Example.test ', fullName: 'Synthetic Doctor', specialty: 'Family medicine', clinic: 'Synthetic Clinic' };

type Rpc = (name: string, parameters: Record<string, string>) => RpcResult;

async function fixture(t: TestContext, rpc: Rpc, environment: NodeJS.ProcessEnv = { APP_ORIGIN: 'https://medflow.example', APP_BASE_PATH: '/app/' }) {
  const calls: { name: string; parameters: Record<string, string>; token?: string }[] = [];
  let verificationError = false;
  const transport: AccountTransport = {
    async verifyToken(token) { if (verificationError) throw new Error('private upstream detail'); return token === 'valid-token'; },
    async rpc(name, parameters, token) {
      calls.push({ name, parameters, ...(token ? { token } : {}) });
      return rpc(name, parameters);
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createAdminRouter({ transport, environment, createToken: () => rawToken }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    calls, setVerificationError: () => { verificationError = true; },
    request: (path: string, method = 'GET', body?: unknown, token: string | null = 'valid-token') =>
      fetch(`http://127.0.0.1:${address.port}${path}`, { method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
  };
}

const ok = (data: unknown): RpcResult => ({ data, error: null });
const sqlError = (message: string): RpcResult => ({ data: null, error: { code: 'P0001', message } });

test('requires a verified bearer token; never calls the database without one', async t => {
  const f = await fixture(t, () => ok({ isAdmin: true }));
  for (const token of [null, 'expired-token', 'valid-token,extra']) {
    const response = await f.request('/admin/status', 'GET', undefined, token);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  }
  assert.equal(f.calls.length, 0);
});

test('identity service failure is a safe 503 without upstream details', async t => {
  const f = await fixture(t, () => ok({ isAdmin: true }));
  f.setVerificationError();
  const response = await f.request('/admin/status');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(body), /private upstream/);
});

test('status reports the database answer and forwards the user JWT', async t => {
  const f = await fixture(t, () => ok({ isAdmin: false }));
  const response = await f.request('/admin/status');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { isAdmin: false });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.calls, [{ name: 'medflow_admin_status', parameters: {}, token: 'valid-token' }]);
});

test('non-admin gets 403 NOT_ADMIN on every admin operation', async t => {
  const f = await fixture(t, name => name === 'medflow_admin_status' ? ok({ isAdmin: false }) : sqlError('NOT_ADMIN'));
  const responses = await Promise.all([
    f.request('/admin/doctor-invitations'),
    f.request('/admin/doctor-invitations', 'POST', validBody),
    f.request(`/admin/doctor-invitations/${id}/revoke`, 'POST', {}),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, 'NOT_ADMIN');
    assert.equal('link' in body, false);
  }
});

test('create stores only the hash and returns the one-time link', async t => {
  const f = await fixture(t, () => ok({ invitation }));
  const response = await f.request('/admin/doctor-invitations', 'POST', validBody);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.invitation, invitation);
  assert.equal(body.link, `https://medflow.example/app/#/doctor/invite/${rawToken}`);
  const call = f.calls[0];
  assert.ok(call);
  assert.equal(call.name, 'medflow_admin_create_doctor_invitation');
  assert.equal(call.token, 'valid-token');
  assert.equal(call.parameters.p_email, 'doctor@example.test');
  assert.equal(call.parameters.p_token_hash, createHash('sha256').update(rawToken).digest('hex'));
  assert.doesNotMatch(JSON.stringify(call.parameters), new RegExp(rawToken), 'raw token never sent to the database');
  assert.doesNotMatch(JSON.stringify(body), /hash/i);
});

test('invalid create bodies are rejected before the database', async t => {
  const f = await fixture(t, () => ok({ invitation }));
  for (const body of [
    {}, { ...validBody, email: 'not-an-email' }, { ...validBody, fullName: '  ' },
    { ...validBody, clinic: 'x'.repeat(301) }, { ...validBody, role: 'doctor' },
  ]) {
    const response = await f.request('/admin/doctor-invitations', 'POST', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, 'INVALID_INPUT');
  }
  assert.equal(f.calls.length, 0);
});

test('misconfigured app origin fails before the invitation is stored', async t => {
  const f = await fixture(t, () => ok({ invitation }), { APP_ORIGIN: 'http://medflow.example' });
  const response = await f.request('/admin/doctor-invitations', 'POST', validBody);
  assert.equal(response.status, 503);
  assert.equal(f.calls.length, 0);
});

test('list and revoke return validated server records', async t => {
  const revoked = { ...invitation, status: 'revoked', revokedAt: '2026-11-06T23:00:00+00:00' };
  const f = await fixture(t, name => name === 'medflow_admin_list_doctor_invitations'
    ? ok({ invitations: [invitation] }) : ok({ invitation: revoked }));
  const list = await f.request('/admin/doctor-invitations');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { invitations: [invitation] });
  const revoke = await f.request(`/admin/doctor-invitations/${id}/revoke`, 'POST', {});
  assert.equal(revoke.status, 200);
  assert.deepEqual(await revoke.json(), { invitation: revoked });
  assert.deepEqual(f.calls[1], { name: 'medflow_admin_revoke_doctor_invitation', parameters: { p_id: id }, token: 'valid-token' });
});

test('revoke validates the id and maps NOT_FOUND', async t => {
  const f = await fixture(t, () => sqlError('NOT_FOUND'));
  const bad = await f.request('/admin/doctor-invitations/not-a-uuid/revoke', 'POST', {});
  assert.equal(bad.status, 400);
  assert.equal(f.calls.length, 0);
  const missing = await f.request(`/admin/doctor-invitations/${id}/revoke`, 'POST', {});
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'NOT_FOUND');
});

test('malformed database responses and unknown errors are not passed through', async t => {
  const f = await fixture(t, name => name === 'medflow_admin_status'
    ? ok({ isAdmin: 'yes' }) : { data: null, error: { code: '42501', message: 'permission denied for table secret_detail' } });
  const status = await f.request('/admin/status');
  assert.equal(status.status, 503);
  const list = await f.request('/admin/doctor-invitations');
  assert.equal(list.status, 503);
  assert.doesNotMatch(JSON.stringify(await list.json()), /secret_detail/);
});
