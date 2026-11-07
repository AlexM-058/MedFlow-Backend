import express, { Router } from 'express';
import { z } from 'zod';
import { DoctorOrchestrator } from '../../AI/cloud/orchestration/doctor-orchestrator';
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
import { CreateMedicalRecordBodySchema } from './schemas';
import {
  getPatientRecords,
  updatePatientSummariesFromDocuments,
  upsertMedicalRecord,
} from './records';
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

    // Încercăm extragerea automată cu MedGemma dacă este disponibil serviciul.
    // Dacă serviciul e offline sau indisponibil, documentul se salvează oricum în DB
    // pentru a nu pierde fișierul și metadatele pacientului.
    const extraction = await extractWithMedGemma(file, mimeType);
    const extractedData = extraction.ok
      ? extraction.extractedData
      : { extraction_status: 'unavailable', error: extraction.error };

    // Salvăm rezultatul extras + metadate despre fișier.
    const { data: document, error: insertError } = await getAdminClient()
      .from('medical_documents')
      .insert({
        case_id: foundCase.id,
        uploaded_by: user.id,
        document_type: query.data.documentType,
        mime_type: mimeType,
        size_bytes: file.length,
        extracted_data: extractedData,
      })
      .select('id, case_id, uploaded_by, document_type, mime_type, size_bytes, extracted_data, created_at')
      .single();
    if (insertError) {
      throw new Error('Nu am putut salva documentul: ' + insertError.message);
    }

    // Actualizăm sumarul de rețete și sumarul dosarului dacă avem date extrase
    if (extraction.ok) {
      try {
        await updatePatientSummariesFromDocuments(foundCase.patient_id);
      } catch (sumError) {
        console.error('Nu am putut actualiza sumarele pacientului:', sumError);
      }
    }

    response.status(201).json(document);
  },
);

// GET /cases/:id/documents — lista documentelor medicale încărcate pentru acest caz
casesRouter.get('/:id/documents', async (request, response) => {
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

  const { data: docs, error } = await getAdminClient()
    .from('medical_documents')
    .select('id, case_id, uploaded_by, document_type, mime_type, size_bytes, extracted_data, created_at')
    .eq('case_id', foundCase.id)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error('Nu am putut citi documentele cazului: ' + error.message);
  }

  response.json(docs || []);
});

// GET /cases/:id/records — citește rețetele, sumarul de rețetă și sumarul clinic al pacientului (No-AI)
casesRouter.get('/:id/records', async (request, response) => {
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

  const recordsData = await getPatientRecords(foundCase.patient_id);
  response.json(recordsData);
});

// POST /cases/:id/records — introducere manuală direct în dosarul pacientului (No-AI)
casesRouter.post('/:id/records', async (request, response) => {
  const params = CaseIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    response.status(400).json({ error: 'Date invalide', details: z.flattenError(params.error).fieldErrors });
    return;
  }
  const body = CreateMedicalRecordBodySchema.safeParse(request.body ?? {});
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

  const recordId = await upsertMedicalRecord(
    foundCase.patient_id,
    body.data.recordType,
    body.data.clinicalData,
  );

  response.status(201).json({ id: recordId, status: 'saved' });
});
