# MedFlow Backend

`npm ci`, then `npm run dev` starts the local server on `127.0.0.1:3001`.
Copy `.env.example` to `.env` and fill Supabase keys. `npm run build` emits `dist/`;
`npm start` runs the compiled server (`dist/Backend/src/index.js`).

The backend imports the AI orchestrator (`DoctorOrchestrator`) from `../AI`, the AI
module folder in the MedFlow superproject (`git clone --recurse-submodules`), so
**AI needs its own `npm ci`** too (`cd AI && npm ci`). Because of that import,
`tsconfig.json` uses `rootDir: ".."` and the build writes both `dist/Backend/...`
and `dist/AI/...`.

## Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Backend `.env` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Backend `.env` | User-scoped client (with JWT) |
| `SUPABASE_SECRET_KEY` | Backend `.env` only | Service role for trusted DB access |
| `GEMINI_API_KEY` | Backend `.env` only | Used by `POST /cases/{id}/analysis` (DoctorOrchestrator) |
| `HOST` / `PORT` | Backend `.env` | Listen address (default `127.0.0.1:3001`) |

Never put `SUPABASE_SECRET_KEY` in Frontend or commit `.env`.

## HTTP contract

`GET /health` returns HTTP 200 and
`{"status":"ok","service":"medflow-backend"}`. This is process liveness only:
it does not claim database or AI readiness and needs no Supabase credentials.

`GET /health/db` uses the service role key to ping `profiles`. Returns 200 when
connected, 503 if keys are missing or Supabase is unreachable.

No diagnostic or prescribing endpoints are implemented.

### Patient cases

Requires `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`, and the tables from
`Database/migrations/001_initial_schema.sql` (branch `feat/db`) applied in Supabase.
The server uses the secret key, which bypasses RLS, so every route checks access
in code. Request bodies are JSON (`Content-Type: application/json`).

Every `/cases` request needs `Authorization: Bearer <Supabase access token>`.
The caller's id and role (`patient`/`doctor`) come from the token and the
`profiles` table, never from the request body.

| Method and path | Body | Success | Who |
| --- | --- | --- | --- |
| `POST /cases` | `{}` or `{"doctorId": "<uuid>"}` | `201` + case | patients |
| `GET /cases/{id}` | none | `200` + case | the case's patient or doctor |
| `POST /cases/{id}/messages` | `{"content": "<1-5000 chars>"}` | `201` + message | the case's patient or doctor |

Case: `{"id","patient_id","doctor_id","status","created_at","updated_at"}`;
a new case starts with `status: "draft"`. The patient is the caller; the doctor is
the patient's active assignment in `doctor_patient_assignments` (send `doctorId`
only when the patient has several active doctors).

Message: `{"id","case_id","sender_role","content","created_at"}`; `sender_role`
is the caller's role. `content` is trimmed before saving.

Errors are JSON `{"error": "...", "details"?: {...}}`:
`400` invalid JSON, id or body (with `details` per field) or several assigned
doctors without `doctorId`; `401` missing or invalid token; `403` no profile, or
a non-patient creating a case; `404` case missing or not accessible to the caller;
`409` no active assigned doctor; `500` server or database error. A message is
answered with `201` only after it is saved.

### AI case analysis (doctor decision support)

Requires migration `Database/migrations/003_doctor_orchestration_state.sql` and
`GEMINI_API_KEY`. Decision support only: the AI does not diagnose or prescribe, and
nothing is sent to the patient automatically.

| Method and path | Body | Success | Who |
| --- | --- | --- | --- |
| `POST /cases/{id}/analysis` | `{"caseSummary": CaseSummary, "documentsContext"?: "...", "patientResponse"?: "<1-5000 chars>"}` | `200` + result | only the case's doctor |

`CaseSummary` is the shape from `MedFlow-AI/core/schemas/case-summary.ts`;
`caseSummary.metadata.patientId` must be the case's patient.

Result: `{"status": "CLARIFICATION_REQUIRED", "data": "<question>"}` or
`{"status": "FINAL", "data": {"options": [...], "missingInformation": [...], "contradictions": [...]}}`.

Rounds are tracked per case in `cases.doctor_orchestration_state` (JSONB), so they
survive across requests and server restarts. First call: send `caseSummary`. If the
answer is `CLARIFICATION_REQUIRED`, call again with the same `caseSummary` plus the
patient's answer in `patientResponse`. After 2 clarification rounds the answer is
always `FINAL`. `GET /cases/{id}` never returns `doctor_orchestration_state`.

Errors: `400` invalid body or a summary for another patient; `401` no/invalid token;
`403` caller is not the case's doctor; `404` case missing or not accessible;
`500` database, privacy-scrubbing or AI (Gemini) failure.
