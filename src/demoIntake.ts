import { Router } from 'express';
import { z } from 'zod';
import { createAccountLimiter } from './account';
import { createLocalAgentClient } from './localAgent';

const input = z.strictObject({
  messages: z.array(z.strictObject({ id: z.string().min(1).max(100), text: z.string().trim().min(1).max(1000) })).min(1).max(20),
  asked: z.array(z.enum(['onset', 'duration', 'severity', 'associated', 'medications', 'allergies', 'additional'])).max(7),
});
/** Public, bounded synthetic demo; never reads/writes patient data or exposes the agent token. */
export function createDemoIntakeRouter(agent = createLocalAgentClient()) {
  const router = Router();
  router.post('/local-intake', createAccountLimiter(10), async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const body = input.safeParse(request.body);
    if (!body.success) { response.status(400).json({ error: 'Folosiți mesaje sintetice de maximum 1000 de caractere, cel mult 20 de mesaje.' }); return; }
    const result = await agent('intake', body.data);
    if (!result.ok) { response.status(result.status).json({ error: result.error }); return; }
    const { text, questionId } = result.data;
    if (typeof text !== 'string' || !text.trim() || text.length > 500 || (questionId !== null && !input.shape.asked.element.safeParse(questionId).success)) {
      response.status(502).json({ error: 'Răspunsul agentului nu a putut fi verificat.' }); return;
    }
    response.json({ text, questionId });
  });
  return router;
}
