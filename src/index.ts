import 'dotenv/config';
import express from 'express';

const app = express();
app.disable('x-powered-by');
app.get('/health', (_request, response) => {
  response.json({ status: 'ok', service: 'medflow-backend' });
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
