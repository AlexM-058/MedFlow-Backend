# MedFlow Backend

`npm ci`, then `npm run dev` starts the local server on `127.0.0.1:3001`.
Copy `.env.example` to `.env` to change HOST/PORT. `npm run build` emits `dist/`;
`npm start` runs the compiled server.

## HTTP contract

`GET /health` returns HTTP 200 and
`{"status":"ok","service":"medflow-backend"}`. This is process liveness only:
it does not claim database or AI readiness and needs no Supabase credentials.
No patient-data, diagnostic, or prescribing endpoints are implemented.
