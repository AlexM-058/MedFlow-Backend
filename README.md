# MedFlow Backend

`npm ci`, then `npm run dev` starts the local server on `127.0.0.1:3001`.
Copy `.env.example` to `.env` and fill Supabase keys. `npm run build` emits `dist/`;
`npm start` runs the compiled server.

## Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Backend `.env` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Backend `.env` | User-scoped client (with JWT) |
| `SUPABASE_SECRET_KEY` | Backend `.env` only | Service role for trusted DB access |
| `HOST` / `PORT` | Backend `.env` | Listen address (default `127.0.0.1:3001`) |

Never put `SUPABASE_SECRET_KEY` in Frontend or commit `.env`.

## HTTP contract

`GET /health` returns HTTP 200 and
`{"status":"ok","service":"medflow-backend"}`. Process liveness only; no Supabase needed.

`GET /health/db` uses the service role key to ping `profiles`. Returns 200 when
connected, 503 if keys are missing or Supabase is unreachable.

No patient-data, diagnostic, or prescribing endpoints are implemented yet.
