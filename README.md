# MedFlow Backend

`npm ci`, then `npm run dev` starts the local server on `127.0.0.1:3001`.
Copy `.env.example` to `.env` to change HOST/PORT. `npm run build` emits `dist/`;
`npm start` runs the compiled server.

## HTTP contract

`GET /health` returns HTTP 200 and
`{"status":"ok","service":"medflow-backend"}`. This is process liveness only:
it does not claim database or AI readiness and needs no Supabase credentials.
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
