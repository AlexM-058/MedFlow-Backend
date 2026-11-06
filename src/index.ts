import 'dotenv/config';
import express from 'express';
import { casesRouter } from './cases';

const app = express();
app.disable('x-powered-by');
// Transformă body-ul JSON al cererii în obiect JS (request.body).
app.use(express.json());
app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'medflow-backend' });
});
app.use('/cases', casesRouter);
// Handler de erori: Express ajunge aici când o rută aruncă o eroare
// (de ex. Supabase nu răspunde) sau când body-ul nu e JSON valid.
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof SyntaxError) {
    response.status(400).json({ error: 'Body-ul cererii nu este JSON valid' });
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  response.status(500).json({ error: 'Eroare internă a serverului' });
});
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const server = app.listen(port, host, () => console.log(`MedFlow Backend: http://${host}:${port}/health`));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
