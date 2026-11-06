import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { accountLink } from './links';
import { accountTransport, type AccountTransport } from './transport';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const text = z.string().min(1);
const doctor = z.object({ id: text, fullName: text, specialty: text, clinic: text });
const profile = z.object({ id: text, email: text, fullName: text,
  role: z.enum(['patient', 'doctor']), activeDoctors: z.array(doctor) });
const connection = z.object({ id: text, status: z.enum(['pending', 'accepted', 'rejected', 'cancelled']),
  createdAt: z.string().datetime({ offset: true }), doctor, patient: z.object({ id: text, fullName: text }) });
const responses = {
  profile: z.object({ profile }), doctor: z.object({ doctor }),
  requests: z.object({ requests: z.array(connection) }), request: z.object({ request: connection }),
  code: z.object({ connectionCode: z.object({ code: opaque }) }),
};
const errors: Record<string, [number, string]> = {
  AUTH_REQUIRED: [401, 'Vă rugăm să vă autentificați din nou.'], GOOGLE_REQUIRED: [403, 'Este necesar un cont Google verificat.'],
  FORBIDDEN: [403, 'Această operațiune nu este permisă.'],
  INVITATION_EMAIL_MISMATCH: [403, 'Autentificați-vă cu adresa de email la care ați primit invitația.'],
  INVITATION_EXPIRED: [410, 'Această invitație a expirat.'],
  INVITATION_REVOKED: [410, 'Această invitație a fost revocată.'],
  INVITATION_USED: [409, 'Această invitație a fost deja folosită.'],
  NOT_FOUND: [404, 'Resursa cerută nu este disponibilă.'],
  CONNECTION_NOT_PENDING: [409, 'Această cerere a fost deja procesată.'],
  CONNECTION_CODE_REVOKED: [410, 'Acest link de conectare nu mai este valid.'],
  INVALID_INPUT: [400, 'Cerere invalidă.'],
};

function fail(response: Response, code: string): void {
  const [status, message] = errors[code] ?? [503, 'Serviciul de conturi este temporar indisponibil.'];
  response.status(status).json({ error: message, code: errors[code] ? code : 'SERVICE_UNAVAILABLE' });
}

/** Bounded process-local throttle. Deployment proxies must also apply shared limits. */
export function createAccountLimiter(limit: number, now: () => number = Date.now): RequestHandler {
  const counters = new Map<string, { count: number; expires: number }>();
  const capacity = 10_000;
  return (request, response, next) => {
    const time = now();
    // Read the socket, not caller-controlled X-Forwarded-For headers.
    const key = request.socket.remoteAddress || 'unknown';
    const previous = counters.get(key);
    if (!previous || previous.expires <= time) {
      if (counters.size >= capacity) {
        for (const [ip, entry] of counters) if (entry.expires <= time) counters.delete(ip);
        if (counters.size >= capacity) {
          response.status(429).set('Retry-After', '60').json({ error: 'Vă rugăm să încercați din nou mai târziu.', code: 'RATE_LIMITED' });
          return;
        }
      }
      counters.set(key, { count: 1, expires: time + 60_000 });
      next(); return;
    }
    if (previous.count >= limit) {
      response.status(429).set('Retry-After', String(Math.max(1, Math.ceil((previous.expires - time) / 1000))))
        .json({ error: 'Vă rugăm să încercați din nou mai târziu.', code: 'RATE_LIMITED' });
      return;
    }
    counters.set(key, { ...previous, count: previous.count + 1 });
    next();
  };
}

export interface AccountRouterOptions {
  transport?: AccountTransport;
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function createAccountRouter(options: AccountRouterOptions = {}): Router {
  const router = Router();
  const transport = options.transport ?? accountTransport;
  const general = createAccountLimiter(120, options.now);
  const previewLimit = createAccountLimiter(60, options.now);
  const invitationLimit = createAccountLimiter(10, options.now);

  function endpoint(rpc: string, schema: z.ZodType, settings: {
    public?: boolean; body?: z.ZodType; parameter?: 'code' | 'id'; code?: boolean; created?: boolean;
  } = {}): RequestHandler {
    return async (request, response) => {
      response.set('Cache-Control', 'no-store');
      try {
        const parameters: Record<string, string> = {};
        if (settings.body) {
          const body = settings.body.safeParse(request.body);
          if (!body.success) { fail(response, 'INVALID_INPUT'); return; }
          for (const [key, value] of Object.entries(body.data as Record<string, string>)) parameters[`p_${key}`] = value;
        }
        if (settings.parameter) {
          const value = (settings.parameter === 'id' ? z.uuid() : opaque).safeParse(request.params[settings.parameter]);
          if (!value.success) { fail(response, 'INVALID_INPUT'); return; }
          parameters[`p_${settings.parameter}`] = value.data;
        }
        let token: string | undefined;
        if (!settings.public) {
          const header = request.headers.authorization;
          const match = header?.match(/^Bearer ([^\s,]{1,8192})$/i);
          token = match?.[1];
          if (!token || !await transport.verifyToken(token)) { fail(response, 'AUTH_REQUIRED'); return; }
        }
        const result = await transport.rpc(rpc, parameters, token);
        if (result.error) {
          fail(response, result.error.code === 'P0001' ? result.error.message : 'SERVICE_UNAVAILABLE');
          return;
        }
        const parsed = schema.safeParse(result.data);
        if (!parsed.success) { fail(response, 'SERVICE_UNAVAILABLE'); return; }
        if (settings.code) {
          const { connectionCode } = responses.code.parse(parsed.data);
          response.json({ connectionCode: { ...connectionCode, url: accountLink(`connect/${connectionCode.code}`, options.environment) } });
          return;
        }
        // SQL can return created:false for duplicate submissions; strip this internal marker.
        const created = settings.created && typeof result.data === 'object' && result.data !== null &&
          'created' in result.data && result.data.created === true;
        response.status(created ? 201 : 200).json(parsed.data);
      } catch {
        fail(response, 'SERVICE_UNAVAILABLE');
      }
    };
  }

  router.get('/me', general, endpoint('medflow_get_me', responses.profile));
  router.post('/doctor-invitations/accept', general, invitationLimit,
    endpoint('medflow_accept_doctor_invitation', responses.profile, { body: z.strictObject({ token: opaque }) }));
  router.get('/connect/:code', general, previewLimit,
    endpoint('medflow_preview_doctor', responses.doctor, { public: true, parameter: 'code' }));
  router.get('/connection-requests', general, endpoint('medflow_list_connection_requests', responses.requests));
  router.post('/connection-requests', general,
    endpoint('medflow_request_connection', responses.request, { body: z.strictObject({ code: opaque }), created: true }));
  router.patch('/connection-requests/:id', general,
    endpoint('medflow_update_connection', responses.request, {
      parameter: 'id', body: z.strictObject({ action: z.enum(['accept', 'reject', 'cancel']) }),
    }));
  router.get('/doctor/connection-code', general, endpoint('medflow_get_connection_code', responses.code, { code: true }));
  router.post('/doctor/connection-code/rotate', general,
    endpoint('medflow_rotate_connection_code', responses.code, { body: z.strictObject({}), code: true }));
  return router;
}
