# MedFlow Backend

Account authentication, invitation-only doctors and QR connection APIs are
documented in [AUTH_SETUP.md](AUTH_SETUP.md). These routes use the existing public
Supabase configuration and verified user JWTs; privileged medical-case routes
below still require a backend-only secret key.

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
| `MEDGEMMA_URL` | Backend `.env` | Local MedGemma extraction service (e.g. `http://127.0.0.1:8090`) |
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
| `POST /cases/{id}/documents` | raw file bytes (see below) | `201` + document | the case's patient or doctor |

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

### Medical documents

Requires migration `Database/migrations/002_post_consultation_fixes.sql` (category
CHECK and upload metadata columns on `medical_documents`).

`POST /cases/{id}/documents?documentType=<category>` takes the file itself as the
request body (not JSON, not multipart), with `Content-Type: image/jpeg`, `image/png`
or `application/pdf`, at most 10 MB. `documentType` is the medical category chosen
by the user: `prescription`, `lab_result`, `medical_letter` or `other` (default
`other` when omitted). From the Frontend:
`fetch(url + "?documentType=lab_result", { method: "POST", headers: { Authorization, "Content-Type": file.type }, body: file })`.

The type is checked from the file's first bytes, not only from `Content-Type`.
The file is sent to the local MedGemma service and **only the extracted result is
saved** in `medical_documents`, with upload metadata; the raw file is never stored.

Document: `{"id","case_id","uploaded_by","document_type","mime_type","size_bytes","extracted_data","created_at"}`;
`uploaded_by` is the caller, `document_type` the category, `mime_type` the format
detected from the file's bytes, `size_bytes` the file size.

Errors: `400` invalid id, invalid `documentType` or empty file; `401`/`404` as above; `413` file over
10 MB; `415` missing/unsupported `Content-Type` or content that is not a real
JPG/PNG/PDF; `502` MedGemma answered with an error or an invalid result; `503`
MedGemma not configured or unreachable; `504` MedGemma did not answer within
60 s. On `502`/`503`/`504` nothing is saved and the file can be sent again.

#### MedGemma contract (implemented by MedFlow-AI)

`POST {MEDGEMMA_URL}/extract` with the same `Content-Type` and raw file body.
Expected answer: `200` + `{"extracted_data": { ... }}`, where `extracted_data`
is a JSON object (stored as-is in the JSONB column). Any other status or shape
is treated as `502`.

The real service is `MedFlow-AI/edge/extraction_service` (Python + FastAPI + local
MedGemma via Ollama); start it as described in its README, on port 8090. Its
`extracted_data` has `medications`, `diagnoses`, `lab_results`, `dates`, `warnings`
and `source`. Values are text copied from the document; anything not in the document
is `null` or an empty list, and every value the service removed is listed in `warnings`
(show them to the doctor).

Without Ollama, run the mock instead (synthetic data, ignores the file, same port):

```sh
npx tsx scripts/mock-medgemma.ts
```
