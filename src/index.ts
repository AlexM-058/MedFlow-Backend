import "dotenv/config";
import express from "express";
import { pingDatabase } from "./supabase.js";

const app = express();
app.disable("x-powered-by");

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
