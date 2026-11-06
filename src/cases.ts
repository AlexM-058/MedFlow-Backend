import express, { Router } from 'express';
import { z } from 'zod';
import { requestAnalysis } from './aiClient';
import { requireUser, type CurrentUser } from './auth';
import { ACCEPTED_CONTENT_TYPES, detectMimeType } from './fileType';
import { extractWithMedGemma } from './medgemma';
import { supabaseStateStore } from './orchestrationStateStore';
import {
  AnalysisBodySchema,
  CaseIdParamsSchema,
  CreateCaseBodySchema,
  DocumentUploadQuerySchema,
  MessageBodySchema,
} from './schemas';
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

  // Analiza o face serviciul AI (MedFlow-AI/cloud/server.ts), care NU are acces la baza de date.
  // 1. citim starea rundelor de clarificare din cases.doctor_orchestration_state
  // 2. i-o trimitem serviciului AI, împreună cu datele cazului
  // 3. salvăm starea nouă pe care ne-o întoarce (null = nu s-a salvat nimic încă)
  const state = await supabaseStateStore.load(foundCase.id);
  const analysis = await requestAnalysis({
    caseId: foundCase.id,
    caseSummary,
    documentsContext,
    patientResponse,
    state,
  });
  if (!analysis.ok) {
    response.status(analysis.status).json({ error: analysis.error });
    return;
  }
  if (analysis.state !== null) {
    await supabaseStateStore.save(foundCase.id, analysis.state);
  }

  // Clientul primește aceeași formă ca înainte: { status, data }.
  response.json(analysis.result);
});

// Dimensiunea maximă a unui document încărcat. Peste ea, express.raw aruncă
// o eroare cu type 'entity.too.large', pe care handler-ul din index.ts o transformă în 413.
const MAX_DOCUMENT_SIZE = '10mb';

// POST /cases/:id/documents?documentType=lab_result — încarcă un document medical (JPG, PNG sau PDF).
// Body-ul cererii ESTE fișierul (nu JSON), iar header-ul Content-Type spune ce tip are.
// express.raw citește body-ul ca Buffer (o listă de octeți), dar DOAR pentru tipurile
// din ACCEPTED_CONTENT_TYPES. Pentru orice alt tip, request.body rămâne undefined.
casesRouter.post(
  '/:id/documents',
  express.raw({ type: ACCEPTED_CONTENT_TYPES, limit: MAX_DOCUMENT_SIZE }),
  async (request, response) => {
    const params = CaseIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      response.status(400).json({ error: 'Date invalide', details: z.flattenError(params.error).fieldErrors });
      return;
    }
    // Categoria documentului (rețetă, analize...), aleasă de utilizator în Frontend.
    const query = DocumentUploadQuerySchema.safeParse(request.query);
    if (!query.success) {
      response.status(400).json({ error: 'Date invalide', details: z.flattenError(query.error).fieldErrors });
      return;
    }

    const file: unknown = request.body;
    if (!Buffer.isBuffer(file)) {
      response.status(415).json({
        error: 'Trimite fișierul în body, cu Content-Type: image/jpeg, image/png sau application/pdf',
      });
      return;
    }
    if (file.length === 0) {
      response.status(400).json({ error: 'Fișierul este gol' });
      return;
    }

    // Tipul declarat în Content-Type poate fi fals; ne uităm la octeții reali.
    const mimeType = detectMimeType(file);
    if (!mimeType) {
      response.status(415).json({ error: 'Conținutul fișierului nu este un JPG, PNG sau PDF valid' });
      return;
    }

    const user = response.locals.user as CurrentUser;
    const foundCase = await findCaseForUser(params.data.id, user);
    if (!foundCase) {
      response.status(404).json({ error: 'Cazul nu a fost găsit' });
      return;
    }

    // Trimitem fișierul la MedGemma. Dacă extragerea eșuează, NU salvăm nimic
    // și îi spunem clientului, ca documentul să poată fi retrimis (nu se pierde în tăcere).
    const extraction = await extractWithMedGemma(file, mimeType);
    if (!extraction.ok) {
      response.status(extraction.status).json({ error: extraction.error });
      return;
    }

    // Salvăm DOAR rezultatul extras + metadate despre fișier (migrarea 002 cere metadatele
    // la fiecare upload). Fișierul brut (variabila `file`) nu ajunge în baza de date.
    const { data: document, error: insertError } = await getAdminClient()
      .from('medical_documents')
      .insert({
        case_id: foundCase.id,
        uploaded_by: user.id, // din token, nu din cerere: nimeni nu poate încărca „în numele” altcuiva
        document_type: query.data.documentType,
        mime_type: mimeType, // tipul REAL, detectat din octeți, nu cel declarat în Content-Type
        size_bytes: file.length,
        extracted_data: extraction.extractedData,
      })
      .select('id, case_id, uploaded_by, document_type, mime_type, size_bytes, extracted_data, created_at')
      .single();
    if (insertError) {
      throw new Error('Nu am putut salva documentul: ' + insertError.message);
    }

    response.status(201).json(document);
  },
);
