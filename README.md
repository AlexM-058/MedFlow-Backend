# MedFlow Backend

Account authentication, invitation-only doctors and QR connection APIs are
documented in [AUTH_SETUP.md](AUTH_SETUP.md). These routes use the existing public
Supabase configuration and verified user JWTs; privileged medical-case routes
below still require a backend-only secret key.

`npm ci`, then `npm run dev` starts the local server on `127.0.0.1:3001`.
Copy `.env.example` to `.env` and fill Supabase keys. `npm run build` emits `dist/`;
`npm start` runs the compiled server (`dist/index.js`).

The backend builds on its own: it does not import files from MedFlow-AI. The doctor
AI analysis is requested over HTTP from the MedFlow-AI cloud service
(`cloud/server.ts`, `npm run dev` in MedFlow-AI) at `AI_URL`, see `src/aiClient.ts`.

## Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Backend `.env` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Backend `.env` | User-scoped client (with JWT) |
| `SUPABASE_SECRET_KEY` | Backend `.env` only | Service role for trusted DB access |
| `AI_URL` | Backend `.env` | MedFlow-AI cloud service, used by `POST /cases/{id}/analysis` (e.g. `http://127.0.0.1:8091`). The Gemini key lives in MedFlow-AI's `.env`. |
| `AI_TOKEN` | Backend `.env` | Optional. Sent as `Authorization: Bearer` to `AI_URL` when that is the tunnel of the local gateway (`/analysis` and `/case-summary` are proxied there to the cloud service on 8091). Same value as `LOCAL_AGENT_TOKEN`. |
| `MEDGEMMA_URL` | Backend `.env` | Local MedGemma extraction service (e.g. `http://127.0.0.1:8090`) |
| `HOST` / `PORT` | Backend `.env` | Listen address (default `127.0.0.1:3001`; in a container `0.0.0.0`) |
| `CORS_ORIGINS` / `APP_ORIGIN` | Backend `.env` | Frontend origins allowed to call the API from a browser (`src/httpConfig.ts`, see `AUTH_SETUP.md`): exact HTTPS origins, HTTP only on localhost. Other origins get `403`. CORS does not replace the token check. |

Never put `SUPABASE_SECRET_KEY` in Frontend or commit `.env`.

## Docker (optional)

```sh
docker build -t medflow-backend .
docker run --rm --env-file .env -e HOST=0.0.0.0 -p 3001:3001 medflow-backend
```

Two stages: `npm ci` + `npm run build`, then a final `node:22-slim` image with only `dist/`
and production dependencies, running as the `node` user. `.dockerignore` keeps `.env` out
of the image: pass the variables above at run time (`--env-file` or `-e`) instead.

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
| `GET /cases?limit=&offset=` | none | `200` + `{"cases": [case]}` (newest first, `limit` 1-100, default 50) | patients (own cases) or doctors (their patients' cases) |
| `POST /cases` | `{}` or `{"doctorId": "<uuid>"}` | `201` + case | patients |
| `GET /cases/{id}` | none | `200` + case | the case's patient or doctor |
| `POST /cases/{id}/messages` | `{"content": "<1-5000 chars>"}` | `201` + message | the case's patient or doctor |
| `POST /cases/{id}/documents` | raw file bytes (see below) | `201` + document | the case's patient or doctor |
| `POST /cases/{id}/documents/{docId}/review` | `{"fields": [ReviewedField]}` (see below) | `200` + document | the case's patient only |

For a **doctor**, `GET /cases` adds three read-only fields to every case (additive; existing fields are unchanged, patients never receive them):
`last_message` (`{"sender_role","content" (max 140 chars),"created_at"}` or `null`; system messages are skipped),
`review_state` (`"new"` no patient/doctor message yet, `"needs_review"` the patient wrote after the doctor's latest message or saved feedback, `"up_to_date"` otherwise)
and `last_activity_at`. If these cannot be computed the plain list is returned without them, so clients must treat them as optional.

Case: `{"id","patient_id","doctor_id","status","created_at","updated_at"}`;
a new case starts with `status: "draft"`. The patient is the caller; the doctor is
the patient's active assignment in `doctor_patient_assignments` (send `doctorId`
only when the patient has several active doctors).

Message: `{"id","case_id","sender_role","content","created_at"}`; `sender_role`
is the caller's role. `content` is trimmed before saving.

Emergency check (patient messages only): after the message is saved, `src/redFlags.ts`
checks it with fixed rules (no AI, so it works even when the AI service is down): chest pain,
breathing difficulty, stroke signs, loss of consciousness, suicidal thoughts; Romanian and
English, with or without diacritics. The patient's answer gets `"safety": {"isEmergency": false}`
or `"safety": {"isEmergency": true, "message": "<112 warning in Romanian>"}`; on an emergency a
second `case_messages` row with `sender_role: "system"` and the warning is added (if that insert
fails the answer is still `201` with `safety`). Doctors' messages are not checked. The rules are a
copy of `MedFlow-AI/edge/safety/redflags.ts`: keep both in sync. Test: `npx tsx --test src/redFlags.test.ts`.

Errors are JSON `{"error": "...", "details"?: {...}}`:
`400` invalid JSON, id or body (with `details` per field) or several assigned
doctors without `doctorId`; `401` missing or invalid token; `403` no profile, or
a non-patient creating a case; `404` case missing or not accessible to the caller;
`409` no active assigned doctor; `500` server or database error. A message is
answered with `201` only after it is saved.

### AI case analysis (doctor decision support)

> **Off by default (GDPR).** This route sends the patient's raw text to the cloud AI. It answers `503` unless `ALLOW_RAW_CLOUD_ANALYSIS=true` is set, and should be enabled only for synthetic data. Use [Control questions](#control-questions-cloud-ai-sees-only-an-anonymized-summary) for real data.

Requires migration `Database/migrations/003_doctor_orchestration_state.sql` and the
MedFlow-AI cloud service running at `AI_URL`. Decision support only: the AI does not
diagnose or prescribe, and nothing is sent to the patient automatically.

| Method and path | Body | Success | Who |
| --- | --- | --- | --- |
| `POST /cases/{id}/analysis` | `{"caseSummary"?: CaseSummary, "language"?: "ro" \| "en", "documentsContext"?: "...", "patientResponse"?: "<1-5000 chars>"}` | `200` + result | only the case's doctor |

`CaseSummary` is the shape from `MedFlow-AI/core/schemas/case-summary.ts`. Both inputs are
now built automatically (`src/caseContext.ts`):
- **Case summary:** without `caseSummary`, Backend reads the case's `case_messages` (chronological,
  `system` rows excluded) and asks the AI service (`POST /case-summary`) to build it, in `language`
  (default `ro`); no messages yet → `400`. If you send `caseSummary`, its `metadata.patientId` must
  be the case's patient.
- **Documents:** the case's `medical_documents` (category, date, `extracted_data`) always go into
  `documentsContext`; text you send is appended after them. Capped at 20000 characters with an
  explicit note.

Result: `{"status": "CLARIFICATION_REQUIRED", "data": "<question>", "analysisId", "caseSummaryGenerated", "documentsContextTruncated"}` or
`{"status": "FINAL", "data": {"options": [...], "missingInformation": [...], "contradictions": [...]}, "analysisId", "caseSummaryGenerated", "documentsContextTruncated"}`.
The clarification question is in the case's language (`caseSummary.metadata.language`, Romanian by default).

Every result is saved in `ai_analyses` (its id is `analysisId`): `FINAL` as `status: "completed"`
with `proposed_options` = options, `follow_up_questions` = missing information and
`context_relevance` = `{"contradictions": [...]}`; `CLARIFICATION_REQUIRED` as `status: "pending"`
with `follow_up_questions` = `[question]`; `model_name` = the model reported by the AI service;
`case_summary` = JSON text of the summary used; `summarized_until_message_id` = last message used
(only when the summary was generated).

Rounds are tracked per case in `cases.doctor_orchestration_state` (JSONB), so they
survive across requests and server restarts. The AI service has no database access:
Backend reads this column, sends it with the request (`state`) and saves the `state`
it gets back (contract in `MedFlow-AI/README.md`). First call: send `caseSummary`. If the
answer is `CLARIFICATION_REQUIRED`, call again with the same `caseSummary` plus the
patient's answer in `patientResponse`. After 2 clarification rounds the answer is
always `FINAL`. `GET /cases/{id}` never returns `doctor_orchestration_state`.

Errors: `400` invalid body or a summary for another patient; `401` no/invalid token;
`403` caller is not the case's doctor; `404` case missing or not accessible;
`500` database error; `502` the AI service answered with an error (privacy scrubbing or
Gemini failure) or an invalid result; `503` `AI_URL` missing or the AI service unreachable;
`504` the AI service did not answer within 120 s. On `502`/`503`/`504` the saved state is
not changed and the request can be sent again.

### Control questions (cloud AI sees only an anonymized summary)

Privacy rule: **no patient text, document or identifier goes to the cloud AI.** The Backend sends the medical file
only to the local gateway (`LOCAL_AGENT_URL`, the project's laptop). The gateway projects it into a closed
*anonymized summary* (age band, conditions, allergies and active substances from fixed vocabularies, lab levels
low/normal/high, a count of omitted items; no names, addresses, dates or free text) and only that summary reaches
Gemini. Gemini answers with a short summary and control questions, which are checked with fixed rules (no doses,
advice or diagnosis) before anything is stored. The local agent then asks the patient those questions.

| Method and path | Body | Success | Who |
| --- | --- | --- | --- |
| `POST /cases/{id}/control-questions` | `{}` | `201` + `{"controlQuestions": {summary, questions, model, generatedAt, sentToCloud}}` | the case's doctor only |
| `GET /cases/{id}/control-questions` | none | `200` + `{"controlQuestions": {...} \| null}` | the case's patient or doctor |

- `questions`: `[{"id", "text", "answerType": "yes_no" | "number" | "short_text"}]`, 1-8, `text` 8-200 chars.
- `sentToCloud` is exactly what left for the cloud (the anonymized summary), shown to the doctor for transparency.
- Stored per patient in `medical_records` (`record_type = control_questions_v1`): summary, questions, model, hash and
  `sentToCloud`; never the patient's text. `cloud_disclosures` gets one row (case, provider `gemini`, model,
  SHA-256 of the summary): the hash, never the content.
- Only medicines from documents the patient reviewed count; diagnoses and lab results from documents are not sent
  until a review exists for them. Unreviewed or unknown items stay local and are only counted (`omittedItemCount`).
- Errors: `400` body not `{}` / invalid id, `403` not a doctor, `404` case not the caller's, `502` invalid answer from
  the gateway, `503` gateway unreachable/busy or the AI failed (nothing is stored or logged then).
- `POST /cases/{id}/intake-question` (patient, local agent) now also sends the stored control questions as
  `questions`; the local model only picks which id to ask, it never writes the question. Without stored questions
  the agent's fixed list is used, exactly as before.
- Requires `LOCAL_AGENT_URL` + `LOCAL_AGENT_TOKEN` (the gateway) and, on the laptop, the AI cloud service
  (`GEMINI_API_KEY`). `AI_URL`/`AI_TOKEN` are not used by this flow.

### Medical documents

Requires migration `Database/migrations/002_post_consultation_fixes.sql` (category
CHECK and upload metadata columns on `medical_documents`) and
`008_document_review.sql` (columns `review`, `reviewed_by`, `reviewed_at`). **Apply 008 before
deploying this Backend version**: the document queries select those columns.

`POST /cases/{id}/documents?documentType=<category>` takes the file itself as the
request body (not JSON, not multipart), with `Content-Type: image/jpeg`, `image/png`
or `application/pdf`, at most 10 MB. `documentType` is the medical category chosen
by the user: `prescription`, `lab_result`, `medical_letter` or `other` (default
`other` when omitted). From the Frontend:
`fetch(url + "?documentType=lab_result", { method: "POST", headers: { Authorization, "Content-Type": file.type }, body: file })`.

The type is checked from the file's first bytes, not only from `Content-Type`.
The file is sent to the local MedGemma service and **only the extracted result is
saved** in `medical_documents`, with upload metadata; the raw file is never stored.

Document: `{"id","case_id","uploaded_by","document_type","mime_type","size_bytes","extracted_data","review","reviewed_by","reviewed_at","created_at"}`
(`review`, `reviewed_by`, `reviewed_at` are `null` until the patient reviews the document);
`uploaded_by` is the caller, `document_type` the category, `mime_type` the format
detected from the file's bytes, `size_bytes` the file size.

Errors: `400` invalid id, invalid `documentType` or empty file; `401`/`404` as above; `413` file over
10 MB; `415` missing/unsupported `Content-Type` or content that is not a real
JPG/PNG/PDF; `422` the file is valid but has no readable text (damaged or password-protected
PDF, no pages): the extraction service's Romanian message is passed through; `502` the service
answered with another error or an invalid result; `503` service not configured, unreachable, or
its model/OCR is unavailable; `504` the document took too long (the service stops at its own
`EXTRACTION_TIME_BUDGET_SECONDS`, default 100 s; Backend waits at most 120 s — keep the budget
below that). On `422`/`502`/`503`/`504` **nothing is saved** (no row, no placeholder) and the body is
`{"error": "<Romanian message>", "code": "EXTRACTION_FAILED"}`; the file stays on the patient's device
and can be sent again. (Earlier versions answered `201` with an `extraction_status: unavailable` stub; clients
should still treat such old rows as "not read".)

#### Patient review of a prescription

The extraction can misread a photo, so the patient checks every medication against the paper
prescription. `POST /cases/{id}/documents/{docId}/review` with
`{"fields": [{"path": "medications.0.dose", "label", "extracted", "value", "confirmation": {"status": "confirmed", "by": "patient", "at": "<ISO>"}, "sourceQuote"?}]}`
saves the result in `medical_documents.review` (`extracted_data` is never overwritten):

- every medication of the document needs all four fields (`name`, `dose`, `frequency`, `duration`);
- `extracted` must equal what the service read (the client cannot change it);
- `value` is the patient's text, kept verbatim; only `duration` may be `null` ("not on the prescription");
- an unreadable field (`extracted: null`) needs a `value` typed from the paper prescription.

Errors: `400` malformed body, `403` not a patient, `404` case/document not available to the caller,
`422` the review does not match the document (missing/duplicate/forged field, empty value).
Only medications from a reviewed document appear in the **active treatment** summary
(`prescriptions` medical record) and are marked as confirmed in the AI `documentsContext`;
unreviewed documents are labelled `NECONFIRMAT` there.

#### MedGemma contract (implemented by MedFlow-AI)

`POST {MEDGEMMA_URL}/extract` with the same `Content-Type` and raw file body.
Expected answer: `200` + `{"extracted_data": { ... }}`, where `extracted_data` has the shape below
(validated; stored as-is in the JSONB column, unknown extra fields are kept). Any other status
or shape is treated as `502`:
`medications[{name,dose,frequency,duration}]`, `diagnoses[]`, `lab_results[{test,value,unit,reference_range}]`,
`dates[{label,value}]`, `warnings[]` (values are text or `null`).

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
