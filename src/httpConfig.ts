import type { RequestHandler } from 'express';
import cors from 'cors';

/** Exact origin allowlist; never reflect arbitrary request origins with credentials. */
export function accountCors(origins: readonly string[]): RequestHandler[] {
  const allowed = new Set(origins);
  const check: RequestHandler = (request, response, next) => {
    const origin = request.headers.origin;
    if (origin && !allowed.has(origin)) {
      response.status(403).json({ error: 'This application origin is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
      return;
    }
    next();
  };
  return [check, cors({
    origin: (origin, callback) => callback(null, !origin || allowed.has(origin)),
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  })];
}

export function allowedAppOrigins(): string[] {
  const appOrigin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
  const raw = process.env.CORS_ORIGINS ?? (appOrigin === 'http://127.0.0.1:5173' ? `${appOrigin},http://localhost:5173` : appOrigin);
  return raw.split(',').map(value => {
    const origin = new URL(value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || (origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))) throw new Error('CORS_ORIGINS must contain exact HTTPS origins (HTTP allowed on loopback).');
    return origin.origin;
  });
}
