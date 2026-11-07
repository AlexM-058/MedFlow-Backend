import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser, type CurrentUser } from './auth';
import { getAdminClient } from './supabaseAdmin';
import { createLocalAgentClient } from './localAgent';
import { CONTROL_QUESTIONS_RECORD, parseStoredQuestions } from './controlQuestions';

/** Patient messages are saved by the existing message API before requesting AI. */
export function createLocalAgentRouter(options: { authenticate?: RequestHandler; getDb?: typeof getAdminClient; agent?: ReturnType<typeof createLocalAgentClient> } = {}) {
  const router = Router();
  for (const operation of ['intake-question', 'summary'] as const) {
    router.post(`/:id/${operation}`, options.authenticate ?? requireUser, async (request, response) => {
      response.set('Cache-Control', 'no-store');
      const id = z.uuid().safeParse(request.params.id);
      if (!id.success || !z.strictObject({}).safeParse(request.body ?? {}).success) {
        response.status(400).json({ error: 'Cerere invalidă.' }); return;
      }
      const user = response.locals.user as CurrentUser;
      const expectedRole = operation === 'summary' ? 'doctor' : 'patient';
      if (user.role !== expectedRole) { response.status(403).json({ error: 'Acces nepermis.' }); return; }
      try {
        const db = (options.getDb ?? getAdminClient)();
        const found = await db.from('cases').select('patient_id,doctor_id').eq('id', id.data).maybeSingle();
        if (found.error) throw found.error;
        if (!found.data || found.data[user.role === 'doctor' ? 'doctor_id' : 'patient_id'] !== user.id) {
          response.status(404).json({ error: 'Dosarul nu este disponibil.' }); return;
        }
        const history = await db.from('case_messages').select('id,sender_role,content').eq('case_id', id.data)
          .order('created_at').order('id').limit(101);
        if (history.error) throw history.error;
        const patientMessages = history.data.filter((message) => message.sender_role === 'patient');
        if (history.data.length > 100 || patientMessages.length > 40) {
          response.status(409).json({ error: 'Conversația depășește limita agentului local. Originalul rămâne disponibil.' }); return;
        }
        if (!patientMessages.length) { response.status(409).json({ error: 'Salvați mai întâi un mesaj pentru medic.' }); return; }
        // Control questions proposed by the cloud AI for this patient (from the anonymized summary), when the
        // doctor generated them. The local agent only picks which one to ask; without them it uses its fixed list.
        let questions: ReturnType<typeof parseStoredQuestions> = null;
        if (operation === 'intake-question') {
          const record = await db.from('medical_records').select('clinical_data').eq('patient_id', found.data.patient_id)
            .eq('record_type', CONTROL_QUESTIONS_RECORD).maybeSingle();
          if (record.error) throw record.error;
          questions = parseStoredQuestions((record.data as { clinical_data?: unknown } | null)?.clinical_data);
        }
        const result = await (options.agent ?? createLocalAgentClient())(operation === 'summary' ? 'summary' : 'intake', {
          messages: patientMessages.map((message) => ({ id: message.id, text: message.content })),
          ...(questions ? { questions } : {}),
          ...(operation === 'intake-question' ? { askedTexts: history.data.filter((message) => message.sender_role === 'ai').slice(-7).map((message) => message.content) } : {}),
        });
        if (!result.ok) { response.status(result.status).json({ error: result.error }); return; }
        if (operation === 'summary') {
          response.json({ summary: result.data }); return;
        }
        if (typeof result.data.text !== 'string' || !result.data.text.trim() || result.data.text.length > 500) throw new Error('Invalid response');
        if (result.data.questionId === null) { response.json({ message: null, notice: result.data.text }); return; }
        const saved = await db.from('case_messages').insert({ case_id: id.data, sender_role: 'ai', content: result.data.text })
          .select('id,case_id,sender_role,content,created_at').single();
        if (saved.error) throw saved.error;
        response.status(201).json({ message: saved.data });
      } catch { response.status(503).json({ error: 'Agentul local nu a putut finaliza operațiunea. Mesajele salvate rămân disponibile.' }); }
    });
  }
  return router;
}
