# Account authentication and doctor connections

This module extends the existing medical-case APIs. It does not change AI,
document extraction or the requirement for a backend-only privileged key on
medical-case routes. Use synthetic data during development.

## Local startup

Keep the existing Backend/.env values for HOST, PORT, SUPABASE_URL and
SUPABASE_PUBLISHABLE_KEY. Account routes use verified user JWTs and narrowly
granted database functions, so they do not require a secret key. Do not copy a
service-role key to the frontend. The operator invitation commands and existing
medical APIs require a separate, current backend-only SUPABASE_SECRET_KEY.

```sh
npm ci
npm run dev
npm run build
npm run test:account
```

The current backend also imports the sibling AI module; run `npm ci` in AI once.
AI calls and their provider keys are not needed to authenticate or connect users.

Development defaults are APP_ORIGIN=http://127.0.0.1:5173 and APP_BASE_PATH=/.
For deployment configure APP_ORIGIN to the exact HTTPS frontend origin and
APP_BASE_PATH if hosted under a path. CORS_ORIGINS optionally supplies a comma-
separated list of exact allowed origins. No wildcard or arbitrary reflected origin.
The defaults allow 127.0.0.1:5173 and localhost:5173 for local development only.

## Database and contract

Apply Database/migrations/004_auth_connections.sql after the existing migrations.
Also apply 005_auth_code_validation.sql and 006_auth_lock_order.sql; these retain
the restricted grants while correcting PostgreSQL regex limits and row-lock order.
Run the corresponding verify_004_checks.sql in a transaction which rolls back
its synthetic fixtures. The root AUTH_INTEGRATION.md defines request/response
shapes; API errors expose safe messages and codes rather than upstream details.

- `/me` provisions a patient's first profile from the verified Google identity.
- Doctor invitations are created only by MedFlow operators and accepted by the
  invited, verified Google email. Raw invitation tokens are not stored in DB.
- Public QR preview exposes professional identity only. A patient explicitly
  requests a connection; a doctor explicitly accepts or rejects it.
- Accepting a request creates the active assignment atomically; scans and login
  never create assignments. Multiple active doctors per patient remain supported.

Anonymous and authenticated users have no direct grants on the new tables.
Database functions enforce caller identity and transitions even if called outside
the Express API. Only the public doctor preview is executable anonymously.

## Operator tooling

Use `npm run invite:doctor -- email "Full name" "Specialty" "Clinic"` and
`npm run invite:revoke -- invitation-uuid`. Creation returns a one-time link for the operator to send
manually. This is the only intended output containing the raw invitation token:
do not paste it into issue trackers, logs or chat. No emails are sent by the tool.

Never auto-promote a user by editing metadata, selecting the doctor page or
supplying a doctor ID in a request. Do not reuse a previously exposed secret key.
