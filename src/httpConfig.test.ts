import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { accountCors } from './httpConfig';

test('CORS permits configured preflight and rejects unrelated origins', async () => {
  const app = express();
  app.use(...accountCors(['http://127.0.0.1:5173']));
  app.get('/me', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/me`;
  try {
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    const denied = await fetch(url, { headers: { Origin: 'https://unrelated.example' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(url)).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
