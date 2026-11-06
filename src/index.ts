import "dotenv/config";
import express from "express";
import { casesRouter } from "./cases";
import { pingDatabase } from "./supabase.js";
import { createAccountRouter } from "./account";
import { createAdminRouter } from "./admin";
import { accountCors, allowedAppOrigins } from "./httpConfig";

const app = express();
app.disable("x-powered-by");
// CORS: doar adresele Frontend-ului din CORS_ORIGINS (sau APP_ORIGIN) au voie să apeleze Backend-ul
// din browser; cererile de la alte site-uri primesc 403 (src/httpConfig.ts).
// Atenție: CORS NU înlocuiește autentificarea. Rutele /cases cer în continuare token-ul Supabase.
app.use(...accountCors(allowedAppOrigins()));
// Transformă body-ul JSON al cererii în obiect JS (request.body).
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "medflow-backend" });
});

/** Checks Supabase using SUPABASE_URL + SUPABASE_SECRET_KEY from Backend/.env */
app.get("/health/db", async (_request, response) => {
  const result = await pingDatabase();
  if (!result.ok) {
    response.status(503).json({
      status: "error",
      service: "medflow-backend",
      database: "unreachable",
      error: result.error,
    });
    return;
  }
  response.json({
    status: "ok",
    service: "medflow-backend",
    database: "connected",
  });
});

app.use("/cases", casesRouter);
app.use(createAccountRouter());
app.use(createAdminRouter());

// Handler de erori: Express ajunge aici când o rută aruncă o eroare
// (de ex. Supabase nu răspunde) sau când body-ul nu e JSON valid.
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError) {
    response.status(400).json({ error: "Body-ul cererii nu este JSON valid" });
    return;
  }
  // express.raw / express.json aruncă eroarea asta când body-ul depășește `limit`.
  if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
    response.status(413).json({ error: "Conținutul trimis este prea mare (documentele pot avea maxim 10 MB)" });
    return;
  }
  // Do not log request bodies, bearer tokens or upstream error details.
  console.error('Unhandled backend request error.');
  response.status(500).json({ error: "Eroare internă a serverului" });
});

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be between 1 and 65535.");
}

const server = app.listen(port, host, () => {
  console.log(`MedFlow Backend: http://${host}:${port}/health`);
  console.log(`Database check:  http://${host}:${port}/health/db`);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
