import express, { Router } from 'express';
import { z } from 'zod';
import { saveAnalysis } from './aiAnalyses';
import { requestAnalysis, requestCaseSummary } from './aiClient';
import { requireUser, type CurrentUser } from './auth';
import { buildDocumentsContext, loadCaseMessages } from './caseContext';
import { ACCEPTED_CONTENT_TYPES, detectMimeType } from './fileType';
import { extractWithMedGemma } from './medgemma';
import { supabaseStateStore } from './orchestrationStateStore';
import { detectRedFlags } from './redFlags';
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

// Coloanele unui document medical (review = verificarea pacientului, vezi documentReview.ts).
const DOCUMENT_COLUMNS =
  'id, case_id, uploaded_by, document_type, mime_type, size_bytes, extracted_data, review, reviewed_by, reviewed_at, created_at';

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

  // De aici, mesajul e deja salvat. Abia acum verificăm dacă e o urgență.
  // Mesajele medicului nu le verificăm: regulile sunt pentru simptomele raportate de pacient.
  if (user.role !== 'patient') {
    response.status(201).json(message);
    return;
  }

  // Reguli fixe (src/redFlags.ts), fără AI: merg chiar dacă serviciul AI e oprit.
  const redFlag = detectRedFlags(body.data.content);
  if (!redFlag.isEmergency) {
    response.status(201).json({ ...message, safety: { isEmergency: false } });
    return;
  }

  // E urgență: salvăm avertismentul ca mesaj „system” în caz,
  // ca să-l vadă și medicul, și pacientul în istoricul cazului.
  try {
    const { error: warningError } = await getAdminClient()
      .from('case_messages')
      .insert({ case_id: foundCase.id, sender_role: 'system', content: redFlag.message });
    if (warningError) {
      console.error('Nu am putut salva avertismentul de urgență pentru cazul', foundCase.id, '-', warningError.message);
    }
  } catch (error) {
    console.error('Nu am putut salva avertismentul de urgență pentru cazul', foundCase.id, '-', error instanceof Error ? error.message : 'eroare necunoscută');
  }
  // Chiar dacă avertismentul nu s-a salvat, răspundem 201: mesajul pacientului e deja salvat
  // (dacă am răspunde cu eroare, pacientul l-ar retrimite), iar avertismentul ajunge
  // oricum la el, în câmpul `safety`. În log NU scriem conținutul mesajului (date medicale).
  response.status(201).json({ ...message, safety: { isEmergency: true, message: redFlag.message } });
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

  // Pasul A: sumarul cazului (CaseSummary).
  //   - dacă medicul l-a trimis, îl folosim, dar doar dacă e despre pacientul ACESTUI caz;
  //   - dacă nu, îl cerem serviciului AI, construit din mesajele cazului (case_messages).
  let caseSummary = body.data.caseSummary;
  let caseSummaryGenerated = false;
  let summarizedUntilMessageId: string | undefined = undefined;
  if (caseSummary !== undefined) {
    if (caseSummary.metadata.patientId !== foundCase.patient_id) {
      response.status(400).json({ error: 'caseSummary.metadata.patientId nu este pacientul acestui caz' });
      return;
    }
  } else {
    const messages = await loadCaseMessages(foundCase.id);
    const lastMessage = messages[messages.length - 1];
    if (lastMessage === undefined) {
      response.status(400).json({
        error: 'Cazul nu are încă mesaje. Analiza AI are nevoie de mesajele pacientului (sau trimite caseSummary în body).',
      });
      return;
    }
    // patientId vine din caz (din DB), nu din cerere: sumarul e mereu despre pacientul cazului.
    const summary = await requestCaseSummary({
      caseId: foundCase.id,
      patientId: foundCase.patient_id,
      language: body.data.language,
      messages,
    });
    if (!summary.ok) {
      response.status(summary.status).json({ error: summary.error });
      return;
    }
    caseSummary = summary.caseSummary;
    caseSummaryGenerated = true;
    summarizedUntilMessageId = lastMessage.id; // până unde am citit conversația
  }

  // Pasul B: documentele cazului (medical_documents) devin text pentru analiză,
  // plus textul trimis de medic în documentsContext (dacă există), pus la final.
  const documents = await buildDocumentsContext(foundCase.id, body.data.documentsContext);

  // Pasul C: analiza o face serviciul AI (MedFlow-AI/cloud/server.ts), care NU are acces la baza de date.
  // 1. citim starea rundelor de clarificare din cases.doctor_orchestration_state
  // 2. i-o trimitem serviciului AI, împreună cu datele cazului
  // 3. salvăm analiza în ai_analyses (cu sumarul folosit), ca medicul s-o poată revedea
  // 4. salvăm starea nouă pe care ne-o întoarce (null = nu s-a salvat nimic încă)
  const state = await supabaseStateStore.load(foundCase.id);
  const analysis = await requestAnalysis({
    caseId: foundCase.id,
    caseSummary,
    documentsContext: documents.text,
    patientResponse: body.data.patientResponse,
    state,
  });
  if (!analysis.ok) {
    response.status(analysis.status).json({ error: analysis.error });
    return;
  }
  // Întâi analiza, apoi starea: dacă salvarea analizei eșuează, starea rămâne neschimbată
  // și medicul poate repeta cererea pentru aceeași rundă (nimic nu se pierde în tăcere).
  const analysisId = await saveAnalysis(
    foundCase.id,
    analysis.result,
    analysis.model,
    caseSummary,
    summarizedUntilMessageId,
  );
  if (analysis.state !== null) {
    await supabaseStateStore.save(foundCase.id, analysis.state);
  }

  // Clientul primește { status, data } ca înainte, plus id-ul analizei salvate și două informații:
  //   caseSummaryGenerated      = true dacă sumarul a fost făcut de AI din mesajele cazului
  //   documentsContextTruncated = true dacă textul documentelor a fost tăiat (nu tot a ajuns la AI)
  response.json({
    ...analysis.result,
    analysisId,
    caseSummaryGenerated,
    documentsContextTruncated: documents.truncated,
  });
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

    // Extragerea automată (OCR + model local). Dacă nu reușește, NU salvăm niciun rând: documentul
    // rămâne pe dispozitivul pacientului, care poate reîncerca (un rând „gol” ar părea o rețetă citită,
    // iar reîncercarea ar crea duplicate). Răspundem cu codul real: 422, 502, 503 sau 504.
    const extraction = await extractWithMedGemma(file, mimeType);
    if (!extraction.ok) {
      response.status(extraction.status).json({ error: extraction.error, code: 'EXTRACTION_FAILED' });
      return;
    }
    const extractedData = extraction.extractedData;

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
      .select(DOCUMENT_COLUMNS)
      .single();
    if (insertError) {
      throw new Error('Nu am putut salva documentul: ' + insertError.message);
    }

    // Actualizăm sumarul dosarului (diagnostice, analize). „Tratament activ” se schimbă abia după
    // ce pacientul verifică rețeta (POST /cases/:id/documents/:docId/review).
    try {
      await updatePatientSummariesFromDocuments(foundCase.patient_id);
    } catch (sumError) {
      console.error('Nu am putut actualiza sumarele pacientului:', sumError);
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
    .select(DOCUMENT_COLUMNS)
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
