import { createHash, randomBytes } from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { createAccountLimiter } from '../account';
import { accountLink } from '../account/links';
import { accountTransport, type AccountTransport } from '../account/transport';

// Platform administrators invite and revoke doctors. The admin right is checked
// by the database functions from Database/migrations/007_platform_admins.sql,
// using the caller's verified JWT; this router never uses a secret key.

const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const invitation = z.object({
  id: z.uuid(), email: text, fullName: text, specialty: text, clinic: text,
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']),
  expiresAt: timestamp, acceptedAt: timestamp.nullable(), revokedAt: timestamp.nullable(),
});
const responses = {
  status: z.object({ isAdmin: z.boolean() }),
  invitation: z.object({ invitation }),
  invitations: z.object({ invitations: z.array(invitation) }),
};
const createBody = z.strictObject({
  // Pasted addresses often carry spaces or capitals; the database stores lower(btrim(email)).
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  fullName: z.string().trim().min(1).max(200),
  specialty: z.string().trim().min(1).max(200),
  clinic: z.string().trim().min(1).max(300),
});

const errors: Record<string, [number, string]> = {
  AUTH_REQUIRED: [401, 'Please sign in again.'],
  NOT_ADMIN: [403, 'This account is not a MedFlow administrator.'],
  NOT_FOUND: [404, 'The requested invitation is unavailable.'],
  INVALID_INPUT: [400, 'Invalid request.'],
};

function fail(response: Response, code: string): void {
  const [status, message] = errors[code] ?? [503, 'The admin service is temporarily unavailable.'];
  response.status(status).json({ error: message, code: errors[code] ? code : 'SERVICE_UNAVAILABLE' });
}

export interface AdminRouterOptions {
  transport?: AccountTransport;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam; production uses 32 random bytes like scripts/create-doctor-invitation.ts. */
  createToken?: () => string;
}

type Handler = (context: { token: string; request: Parameters<RequestHandler>[0]; response: Response }) => Promise<void>;

export function createAdminRouter(options: AdminRouterOptions = {}): Router {
  const router = Router();
  const transport = options.transport ?? accountTransport;
  const createToken = options.createToken ?? (() => randomBytes(32).toString('base64url'));
  const general = createAccountLimiter(120, options.now);
  const createLimit = createAccountLimiter(20, options.now);

  function authenticated(handler: Handler): RequestHandler {
    return async (request, response) => {
      response.set('Cache-Control', 'no-store');
      try {
        const match = request.headers.authorization?.match(/^Bearer ([^\s,]{1,8192})$/i);
        const token = match?.[1];
        if (!token || !await transport.verifyToken(token)) { fail(response, 'AUTH_REQUIRED'); return; }
        await handler({ token, request, response });
      } catch {
        fail(response, 'SERVICE_UNAVAILABLE');
      }
    };
  }

  async function call<T>(response: Response, token: string, rpc: string, parameters: Record<string, string>,
    schema: z.ZodType<T>): Promise<T | null> {
    const result = await transport.rpc(rpc, parameters, token);
    if (result.error) {
      fail(response, result.error.code === 'P0001' ? result.error.message : 'SERVICE_UNAVAILABLE');
      return null;
    }
    const parsed = schema.safeParse(result.data);
    if (!parsed.success) { fail(response, 'SERVICE_UNAVAILABLE'); return null; }
    return parsed.data;
  }

  router.get('/admin/status', general, authenticated(async ({ token, response }) => {
    const data = await call(response, token, 'medflow_admin_status', {}, responses.status);
    if (data) response.json(data);
  }));

  router.get('/admin/doctor-invitations', general, authenticated(async ({ token, response }) => {
    const data = await call(response, token, 'medflow_admin_list_doctor_invitations', {}, responses.invitations);
    if (data) response.json(data);
  }));

  router.post('/admin/doctor-invitations', general, createLimit, authenticated(async ({ token, request, response }) => {
    const body = createBody.safeParse(request.body);
    if (!body.success) { fail(response, 'INVALID_INPUT'); return; }
    const raw = createToken();
    // Build the link first: a configuration error must fail before anything is stored.
    const link = accountLink(`doctor/invite/${raw}`, options.environment);
    // Only the hash is stored; the raw token exists only in this response.
    const data = await call(response, token, 'medflow_admin_create_doctor_invitation', {
      p_email: body.data.email, p_full_name: body.data.fullName,
      p_specialty: body.data.specialty, p_clinic: body.data.clinic,
      p_token_hash: createHash('sha256').update(raw).digest('hex'),
    }, responses.invitation);
    if (!data) return;
    response.status(201).json({ ...data, link });
  }));

  router.post('/admin/doctor-invitations/:id/revoke', general, authenticated(async ({ token, request, response }) => {
    const id = z.uuid().safeParse(request.params.id);
    if (!id.success) { fail(response, 'INVALID_INPUT'); return; }
    const data = await call(response, token, 'medflow_admin_revoke_doctor_invitation', { p_id: id.data }, responses.invitation);
    if (data) response.json(data);
  }));

  return router;
}
