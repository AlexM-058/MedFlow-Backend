import { z } from 'zod';

// Regulile pentru datele care vin de la Frontend.
// Le verificăm cu .safeParse(), care întoarce { success: true, data } sau { success: false, error }.
// Câmpurile care nu sunt descrise aici sunt eliminate din `data`
// (de ex. un `sender_role` trimis în body este ignorat).

// :id din URL, de ex. /cases/3f1c...  Cheile din tabelul `cases` sunt UUID-uri.
export const CaseIdParamsSchema = z.object({
  id: z.uuid('ID-ul cazului trebuie să fie un UUID valid'),
});

// Body pentru POST /cases. Pacientul NU vine din body, ci din token.
// doctorId e opțional: e nevoie de el doar dacă pacientul are mai mulți medici alocați.
export const CreateCaseBodySchema = z.object({
  doctorId: z.uuid('doctorId trebuie să fie un UUID valid').optional(),
});

// Body pentru POST /cases/:id/messages.
// Întâi .trim() (scoate spațiile de la capete), apoi .min(1):
// așa un mesaj format doar din spații devine "" și e respins.
export const MessageBodySchema = z.object({
  content: z
    .string('content trebuie să fie text')
    .trim()
    .min(1, 'Mesajul nu poate fi gol')
    .max(5000, 'Mesajul poate avea maxim 5000 de caractere'),
});
