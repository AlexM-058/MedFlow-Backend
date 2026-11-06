import { Router } from 'express';
import { z } from 'zod';
import { DoctorOrchestrator } from '../../MedFlow-AI/cloud/orchestration/doctor-orchestrator';
import { requireUser, type CurrentUser } from './auth';
import { supabaseStateStore } from './orchestrationStateStore';
import { AnalysisBodySchema, CaseIdParamsSchema, CreateCaseBodySchema, MessageBodySchema } from './schemas';
import { getAdminClient } from './supabaseAdmin';

export const casesRouter = Router();

// Toate rutele de mai jos cer un utilizator autentificat.
casesRouter.use(requireUser);

// Coloanele pe care le trimitem înapoi pentru un caz.
const CASE_COLUMNS = 'id, patient_id, doctor_id, status, created_at, updated_at';

// Caută cazul și verifică dacă utilizatorul e pacientul sau medicul lui (autorizare).
// Întoarce null dacă nu există SAU dacă utilizatorul n-are voie să-l vadă.
// În ambele situații răspundem 404, ca să nu dezvăluim că un caz cu acel id există.
async function findCaseForUser(caseId: string, user: CurrentUser) {
  const { data, error } = await getAdminClient()
    .from('cases')
    .select(CASE_COLUMNS)
    .eq('id', caseId)
    .maybeSingle();
  if (error) {
    throw new Error('Nu am putut citi cazul: ' + error.message);
  }
  if (!data) {
    return null;
  }
  if (data.patient_id !== user.id && data.doctor_id !== user.id) {
    return null;
  }
  return data;
}

// POST /cases — pacientul deschide un caz nou.
casesRouter.post('/', async (request, response) => {
  const user = response.locals.user as CurrentUser;
  if (user.role !== 'patient') {
    response.status(403).json({ error: 'Doar pacienții pot deschide un caz' });
    return;
  }

  // Fără body JSON, Express lasă request.body = undefined; îl tratăm ca {}.
  const body = CreateCaseBodySchema.safeParse(request.body ?? {});
  if (!body.success) {
    response.status(400).json({ error: 'Date invalide', details: z.flattenError(body.error).fieldErrors });
    return;
  }

  // Asocierea caz–pacient: pacientul e utilizatorul din token.
  // Medicul îl luăm din alocările ACTIVE ale pacientului (tabelul doctor_patient_assignments).
  const supabase = getAdminClient();
  let assignmentsQuery = supabase
    .from('doctor_patient_assignments')
    .select('doctor_id')
    .eq('patient_id', user.id)
    .eq('is_active', true);
  if (body.data.doctorId) {
    assignmentsQuery = assignmentsQuery.eq('doctor_id', body.data.doctorId);
  }
  const { data: assignments, error: assignmentsError } = await assignmentsQuery;
  if (assignmentsError) {
    throw new Error('Nu am putut citi medicii alocați: ' + assignmentsError.message);
  }

  if (assignments.length > 1) {
    response.status(400).json({ error: 'Ai mai mulți medici alocați: trimite doctorId în body' });
    return;
  }
  const assignment = assignments[0];
  if (!assignment) {
    response.status(409).json({ error: 'Nu există un medic alocat activ pentru acest pacient' });
    return;
  }

  // status nu îl trimitem: baza de date pune implicit 'draft'.
  const { data: newCase, error: insertError } = await supabase
    .from('cases')
    .insert({ patient_id: user.id, doctor_id: assignment.doctor_id })
    .select(CASE_COLUMNS)
    .single();
  if (insertError) {
    throw new Error('Nu am putut crea cazul: ' + insertError.message);
  }

  response.status(201).json(newCase);
});

// GET /cases/:id — statusul unui caz (doar pentru pacientul sau medicul lui).
casesRouter.get('/:id', async (request, response) => {
  const params = CaseIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    response.status(400).json({ error: 'Date invalide', details: z.flattenError(params.error).fieldErrors });
    return;
  }

  const user = response.locals.user as CurrentUser;
  const foundCase = await findCaseForUser(params.data.id, user);
  if (!foundCase) {
    response.status(404).json({ error: 'Cazul nu a fost găsit' });
    return;
  }

  response.json(foundCase);
});

// POST /cases/:id/messages — salvează un mesaj în caz.
casesRouter.post('/:id/messages', async (request, response) => {
  const params = CaseIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    response.status(400).json({ error: 'Date invalide', details: z.flattenError(params.error).fieldErrors });
    return;
  }
  const body = MessageBodySchema.safeParse(request.body ?? {});
  if (!body.success) {
    response.status(400).json({ error: 'Date invalide', details: z.flattenError(body.error).fieldErrors });
    return;
  }

  const user = response.locals.user as CurrentUser;
  const foundCase = await findCaseForUser(params.data.id, user);
  if (!foundCase) {
    response.status(404).json({ error: 'Cazul nu a fost găsit' });
    return;
  }

  // sender_role vine din profilul utilizatorului, NU din body:
  // un pacient nu poate trimite un mesaj ca „doctor” sau „ai”.
  const { data: message, error: insertError } = await getAdminClient()
    .from('case_messages')
    .insert({ case_id: foundCase.id, sender_role: user.role, content: body.data.content })
    .select('id, case_id, sender_role, content, created_at')
    .single();
  // Dacă salvarea eșuează, NU răspundem 201: eroarea ajunge la handler-ul de erori
  // și clientul primește 500. Mesajul pacientului nu se pierde în tăcere.
  if (insertError) {
    throw new Error('Nu am putut salva mesajul: ' + insertError.message);
  }

  response.status(201).json(message);
});

// Orchestratorul AI pentru medic. Îl creăm o singură dată și îi dăm locul unde
// își salvează starea (coloana cases.doctor_orchestration_state).
// Nu păstrează nimic în memorie între request-uri: tot ce trebuie ținut minte e în DB.
const doctorOrchestrator = new DoctorOrchestrator(supabaseStateStore);

// POST /cases/:id/analysis — analiza AI de suport decizional, DOAR pentru medicul cazului.
// Răspunsul e { status: 'FINAL', data: analiza } sau { status: 'CLARIFICATION_REQUIRED', data: întrebarea }.
// Pentru o rundă de clarificare, medicul trimite din nou cererea, cu patientResponse.
casesRouter.post('/:id/analysis', async (request, response) => {
  const params = CaseIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    response.status(400).json({ error: 'Date invalide', details: z.flattenError(params.error).fieldErrors });
    return;
  }
  const body = AnalysisBodySchema.safeParse(request.body ?? {});
  if (!body.success) {
    response.status(400).json({ error: 'Date invalide', details: z.flattenError(body.error).fieldErrors });
    return;
  }

  // Analiza conține opțiuni pentru medic: pacientul NU o primește
  // (AI-ul nu trimite nimic automat pacientului).
  const user = response.locals.user as CurrentUser;
  if (user.role !== 'doctor') {
    response.status(403).json({ error: 'Doar medicul cazului poate cere analiza AI' });
    return;
  }

  const foundCase = await findCaseForUser(params.data.id, user);
  if (!foundCase) {
    response.status(404).json({ error: 'Cazul nu a fost găsit' });
    return;
  }
  // DB nu verifică rolurile, așa că verificăm explicit că e medicul ACESTUI caz.
  if (foundCase.doctor_id !== user.id) {
    response.status(403).json({ error: 'Doar medicul cazului poate cere analiza AI' });
    return;
  }

  // Sumarul trebuie să fie despre pacientul acestui caz, nu despre altcineva.
  const { caseSummary, documentsContext, patientResponse } = body.data;
  if (caseSummary.metadata.patientId !== foundCase.patient_id) {
    response.status(400).json({ error: 'caseSummary.metadata.patientId nu este pacientul acestui caz' });
    return;
  }

  // sessionId = id-ul cazului: așa orchestratorul găsește starea în rândul corect din `cases`.
  const result = await doctorOrchestrator.processCase(caseSummary, foundCase.id, documentsContext, patientResponse);
  response.json(result);
});
