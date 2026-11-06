import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

// Fresh synthetic fixtures only. Never print manifest contents or Auth responses.
const fixtureUser = z.object({ id: z.uuid(), email: z.email(), password: z.string().min(1) });
const manifestSchema = z.object({ patient: fixtureUser, doctor: fixtureUser, other: fixtureUser,
  invitationToken: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/) });
const profileSchema = z.object({ profile: z.object({ id: z.uuid(), role: z.enum(['patient', 'doctor']),
  activeDoctors: z.array(z.object({ id: z.uuid() })) }) });
const requestSchema = z.object({ request: z.object({ id: z.uuid(),
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled']) }) });
const codeSchema = z.object({ connectionCode: z.object({ code: z.string(), url: z.url() }) });

let currentCase = 'Load synthetic fixture manifest';
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('Verification failed');
}
async function runCase(name: string, work: () => Promise<void>): Promise<void> {
  currentCase = name;
  await work();
  process.stdout.write(`PASS ${name}\n`);
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  check(manifestPath);
  const fixture = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  check(supabaseUrl && publishableKey);
  const apiBase = process.env.MEDFLOW_API_URL?.trim() || 'http://127.0.0.1:3001';
  const sessions: string[] = [];

  async function signIn(user: z.infer<typeof fixtureUser>): Promise<string> {
    const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: publishableKey!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: user.password }), signal: AbortSignal.timeout(15_000),
    });
    check(response.ok);
    const data = z.object({ access_token: z.string().min(1), user: z.object({ id: z.uuid() }) }).parse(await response.json());
    check(data.user.id === user.id);
    sessions.push(data.access_token);
    return data.access_token;
  }

  async function api(path: string, token?: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${apiBase}${path}`, {
      method, redirect: 'error', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    const data: unknown = await response.json();
    return { status: response.status, data };
  }
  const patch = (id: string, token: string, action: string) => api(`/connection-requests/${id}`, token, 'PATCH', { action });

  try {
    currentCase = 'Authenticate synthetic fixture sessions';
    const [patientToken, doctorToken, otherToken] = await Promise.all([
      signIn(fixture.patient), signIn(fixture.doctor), signIn(fixture.other),
    ]);
    process.stdout.write(`PASS ${currentCase}\n`);

    await runCase('First login provisions patients and ignores doctor metadata', async () => {
      for (const [token, id] of [[patientToken, fixture.patient.id], [doctorToken, fixture.doctor.id], [otherToken, fixture.other.id]]) {
        const response = await api('/me', token);
        check(response.status === 200);
        const { profile } = profileSchema.parse(response.data);
        check(profile.id === id && profile.role === 'patient' && profile.activeDoctors.length === 0);
      }
    });

    await runCase('Wrong-email invitation cannot promote a patient', async () => {
      const response = await api('/doctor-invitations/accept', patientToken, 'POST', { token: fixture.invitationToken });
      check(response.status === 403);
      check(z.object({ code: z.literal('INVITATION_EMAIL_MISMATCH') }).safeParse(response.data).success);
    });

    await runCase('Invited doctor promotion and same-user retry are durable', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await api('/doctor-invitations/accept', doctorToken, 'POST', { token: fixture.invitationToken });
        check(response.status === 200);
        const { profile } = profileSchema.parse(response.data);
        check(profile.id === fixture.doctor.id && profile.role === 'doctor');
      }
    });

    let activeCode = '';
    await runCase('Doctor QR has canonical link and minimal public preview', async () => {
      const response = await api('/doctor/connection-code', doctorToken);
      check(response.status === 200);
      const { connectionCode } = codeSchema.parse(response.data);
      activeCode = connectionCode.code;
      const url = new URL(connectionCode.url);
      check(url.hash === `#/connect/${activeCode}` && !url.search && !url.username && !url.password);
      const preview = await api(`/connect/${activeCode}`);
      check(preview.status === 200);
      const publicResult = z.strictObject({ doctor: z.strictObject({ id: z.literal(fixture.doctor.id),
        fullName: z.string().min(1), specialty: z.string().min(1), clinic: z.string().min(1) }) });
      check(publicResult.safeParse(preview.data).success);
    });

    let pendingId = '';
    await runCase('Concurrent patient submissions persist exactly one pending request', async () => {
      const responses = await Promise.all([0, 1].map(() => api('/connection-requests', patientToken, 'POST', { code: activeCode })));
      check(responses.filter(response => response.status === 201).length === 1);
      check(responses.filter(response => response.status === 200).length === 1);
      const requests = responses.map(response => requestSchema.parse(response.data).request);
      check(requests[0]?.status === 'pending' && requests[1]?.status === 'pending' && requests[0].id === requests[1].id);
      pendingId = requests[0].id;
    });

    await runCase('Patients and unrelated users cannot approve or cancel another request', async () => {
      check((await patch(pendingId, patientToken, 'accept')).status === 403);
      check((await patch(pendingId, otherToken, 'accept')).status === 403);
      check((await patch(pendingId, otherToken, 'cancel')).status === 403);
      check((await patch(pendingId, doctorToken, 'cancel')).status === 403);
    });

    await runCase('Doctor list includes only their pending connection', async () => {
      const response = await api('/connection-requests', doctorToken);
      check(response.status === 200);
      const data = z.object({ requests: z.array(z.object({ id: z.uuid(), status: z.string(),
        doctor: z.object({ id: z.uuid() }) })) }).parse(response.data);
      check(data.requests.some(request => request.id === pendingId && request.status === 'pending'));
      check(data.requests.every(request => request.doctor.id === fixture.doctor.id));
    });

    await runCase('Concurrent rotation and old-code request complete without deadlock', async () => {
      const oldCode = activeCode;
      const [rotated, requested] = await Promise.all([
        api('/doctor/connection-code/rotate', doctorToken, 'POST', {}),
        api('/connection-requests', patientToken, 'POST', { code: oldCode }),
      ]);
      check(rotated.status === 200);
      activeCode = codeSchema.parse(rotated.data).connectionCode.code;
      check(activeCode !== oldCode);
      check(requested.status === 200 || requested.status === 404);
      if (requested.status === 200) {
        const { request } = requestSchema.parse(requested.data);
        check(request.id === pendingId && request.status === 'pending');
      }
      check((await api(`/connect/${oldCode}`)).status === 404);
    });

    await runCase('Doctor acceptance activates care team and remains idempotent', async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const accepted = await patch(pendingId, doctorToken, 'accept');
        check(accepted.status === 200 && requestSchema.parse(accepted.data).request.status === 'accepted');
      }
      const me = await api('/me', patientToken);
      check(me.status === 200);
      const { profile } = profileSchema.parse(me.data);
      check(profile.activeDoctors.filter(doctor => doctor.id === fixture.doctor.id).length === 1);
      const repeated = await api('/connection-requests', patientToken, 'POST', { code: activeCode });
      check(repeated.status === 200);
      const { request } = requestSchema.parse(repeated.data);
      check(request.id === pendingId && request.status === 'accepted');
      check((await patch(pendingId, doctorToken, 'reject')).status === 409);
    });

    await runCase('Rejection permits an explicit new request which the patient can cancel', async () => {
      const first = await api('/connection-requests', otherToken, 'POST', { code: activeCode });
      check(first.status === 201);
      const firstId = requestSchema.parse(first.data).request.id;
      const rejected = await patch(firstId, doctorToken, 'reject');
      check(rejected.status === 200 && requestSchema.parse(rejected.data).request.status === 'rejected');
      check((await patch(firstId, doctorToken, 'accept')).status === 409);
      const second = await api('/connection-requests', otherToken, 'POST', { code: activeCode });
      check(second.status === 201);
      const secondId = requestSchema.parse(second.data).request.id;
      check(secondId !== firstId);
      const cancelled = await patch(secondId, otherToken, 'cancel');
      check(cancelled.status === 200 && requestSchema.parse(cancelled.data).request.status === 'cancelled');
      const me = await api('/me', otherToken);
      check(me.status === 200 && profileSchema.parse(me.data).profile.activeDoctors.length === 0);
    });

    await runCase('Forged bearer identity is rejected', async () => {
      check((await api('/me', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmb3JnZWQifQ.invalid')).status === 401);
    });
  } finally {
    // Session credentials remain in memory. Fixture deletion belongs to the caller.
    await Promise.allSettled(sessions.map(token => fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
      method: 'POST', headers: { apikey: publishableKey!, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })));
  }
}

void main().catch(() => {
  process.stderr.write(`FAIL ${currentCase}\n`);
  process.exitCode = 1;
});
