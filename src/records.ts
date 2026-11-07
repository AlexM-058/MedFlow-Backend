import { getAdminClient } from './supabaseAdmin';

export interface MedicationItem {
  name: string;
  dose?: string | null;
  frequency?: string | null;
  duration?: string | null;
}

export interface PrescriptionRecordData {
  prescriptions: Array<{
    documentId: string;
    documentType: string;
    date?: string | null;
    medications: MedicationItem[];
  }>;
  prescriptionSummary: string;
  sourceDocumentCount: number;
  lastUpdatedAt: string;
}

export interface ClinicalSummaryRecordData {
  summary: string;
  diagnoses: string[];
  labTests: string[];
  sourceDocumentCount: number;
  lastUpdatedAt: string;
}

/**
 * Generează un sumar în limba română pentru rețetele medicale existente.
 * Deterministic (No-AI), rapid și sigur.
 */
export function generatePrescriptionSummary(
  prescriptions: PrescriptionRecordData['prescriptions'],
): string {
  const allMeds: MedicationItem[] = [];
  for (const p of prescriptions) {
    for (const m of p.medications) {
      if (m.name && m.name.trim().length > 0) {
        allMeds.push(m);
      }
    }
  }

  if (allMeds.length === 0) {
    return 'Nu există rețete sau medicamente înregistrate în dosar.';
  }

  const items = allMeds.map((m) => {
    const details = [m.dose, m.frequency, m.duration].filter(Boolean).join(', ');
    return details ? `${m.name} (${details})` : m.name;
  });

  return `Tratament activ (${allMeds.length} ${allMeds.length === 1 ? 'medicament' : 'medicamente'}): ${items.join('; ')}.`;
}

/**
 * Generează sumarul dosarului clinic al pacientului pe baza documentelor încărcate.
 * Deterministic (No-AI), fără halucinații.
 */
export function generateClinicalSummary(
  documentCount: number,
  diagnoses: string[],
  medicationCount: number,
  labCount: number,
): string {
  if (documentCount === 0) {
    return 'Dosar medical nou. Nu au fost încărcate documente sau antecedente medicale.';
  }

  const parts: string[] = [
    `Dosar clinic actualizat pe baza a ${documentCount} ${documentCount === 1 ? 'document' : 'documente'}.`,
  ];

  if (diagnoses.length > 0) {
    parts.push(`Diagnostice înregistrate: ${diagnoses.join(', ')}.`);
  } else {
    parts.push('Nu sunt diagnostice menționate explicit.');
  }

  if (medicationCount > 0) {
    parts.push(`Tratamente prescrise: ${medicationCount} produse.`);
  }

  if (labCount > 0) {
    parts.push(`Analize de laborator: ${labCount} parametri înregistrați.`);
  }

  return parts.join(' ');
}

/**
 * Salvează sau actualizează o înregistrare în tabelul `medical_records`.
 */
export async function upsertMedicalRecord(
  patientId: string,
  recordType: string,
  clinicalData: Record<string, unknown>,
): Promise<string> {
  const supabase = getAdminClient();

  const { data: existing, error: selectError } = await supabase
    .from('medical_records')
    .select('id')
    .eq('patient_id', patientId)
    .eq('record_type', recordType)
    .maybeSingle();

  if (selectError) {
    throw new Error('Eroare la căutarea înregistrării medicale: ' + selectError.message);
  }

  if (existing) {
    const { data: updated, error: updateError } = await supabase
      .from('medical_records')
      .update({ clinical_data: clinicalData })
      .eq('id', existing.id)
      .select('id')
      .single();

    if (updateError) {
      throw new Error('Eroare la actualizarea înregistrării medicale: ' + updateError.message);
    }
    return updated.id as string;
  }

  const { data: inserted, error: insertError } = await supabase
    .from('medical_records')
    .insert({
      patient_id: patientId,
      record_type: recordType,
      clinical_data: clinicalData,
    })
    .select('id')
    .single();

  if (insertError) {
    throw new Error('Eroare la salvarea înregistrării medicale: ' + insertError.message);
  }

  return inserted.id as string;
}

/**
 * Citește toate documentele pacientului și actualizează sumarul de rețete și sumarul clinic.
 * Se apelează DOAR la evenimentul de upload / modificare a unui document nou.
 */
export async function updatePatientSummariesFromDocuments(
  patientId: string,
): Promise<{ prescriptionSummaryId: string; clinicalSummaryId: string }> {
  const supabase = getAdminClient();

  // 1. Găsim cazurile pacientului
  const { data: cases, error: casesError } = await supabase
    .from('cases')
    .select('id')
    .eq('patient_id', patientId);

  if (casesError) {
    throw new Error('Eroare la citirea cazurilor pacientului: ' + casesError.message);
  }

  const caseIds = (cases || []).map((c) => c.id);

  // 2. Citim documentele pacientului (după case_id sau uploaded_by)
  let documentsQuery = supabase
    .from('medical_documents')
    .select('id, case_id, document_type, extracted_data, created_at')
    .order('created_at', { ascending: false });

  if (caseIds.length > 0) {
    documentsQuery = documentsQuery.or(`uploaded_by.eq.${patientId},case_id.in.(${caseIds.join(',')})`);
  } else {
    documentsQuery = documentsQuery.eq('uploaded_by', patientId);
  }

  const { data: documents, error: docsError } = await documentsQuery;
  if (docsError) {
    throw new Error('Eroare la citirea documentelor medicale: ' + docsError.message);
  }

  const docList = documents || [];
  const prescriptionsList: PrescriptionRecordData['prescriptions'] = [];
  const allDiagnoses = new Set<string>();
  const allLabTests = new Set<string>();
  let totalMedsCount = 0;

  for (const doc of docList) {
    const rawData = doc.extracted_data as Record<string, unknown> | null;
    if (!rawData || typeof rawData !== 'object') continue;

    // Extragem rețetele
    const rawMeds = Array.isArray(rawData.medications) ? rawData.medications : [];
    if (rawMeds.length > 0) {
      const docDate = Array.isArray(rawData.dates) && rawData.dates[0] && typeof rawData.dates[0] === 'object'
        ? (rawData.dates[0] as { value?: string }).value ?? null
        : null;

      const medications: MedicationItem[] = rawMeds.map((m: any) => ({
        name: String(m.name ?? '').trim(),
        dose: m.dose ? String(m.dose).trim() : null,
        frequency: m.frequency ? String(m.frequency).trim() : null,
        duration: m.duration ? String(m.duration).trim() : null,
      })).filter((m) => m.name.length > 0);

      if (medications.length > 0) {
        totalMedsCount += medications.length;
        prescriptionsList.push({
          documentId: doc.id,
          documentType: doc.document_type,
          date: docDate,
          medications,
        });
      }
    }

    // Extragem diagnosticele
    if (Array.isArray(rawData.diagnoses)) {
      for (const diag of rawData.diagnoses) {
        if (typeof diag === 'string' && diag.trim()) {
          allDiagnoses.add(diag.trim());
        }
      }
    }

    // Extragem analizele de laborator
    if (Array.isArray(rawData.lab_results)) {
      for (const lab of rawData.lab_results) {
        if (lab && typeof lab === 'object' && 'test' in lab && typeof lab.test === 'string' && lab.test.trim()) {
          allLabTests.add(lab.test.trim());
        }
      }
    }
  }

  const now = new Date().toISOString();

  // 3. Salvează sumarul rețetelor
  const prescriptionSummaryText = generatePrescriptionSummary(prescriptionsList);
  const prescriptionData: PrescriptionRecordData = {
    prescriptions: prescriptionsList,
    prescriptionSummary: prescriptionSummaryText,
    sourceDocumentCount: docList.length,
    lastUpdatedAt: now,
  };

  const prescriptionSummaryId = await upsertMedicalRecord(
    patientId,
    'prescriptions',
    prescriptionData as unknown as Record<string, unknown>,
  );

  // 4. Salvează sumarul clinic al dosarului
  const diagnosesArray = Array.from(allDiagnoses);
  const labTestsArray = Array.from(allLabTests);
  const clinicalSummaryText = generateClinicalSummary(
    docList.length,
    diagnosesArray,
    totalMedsCount,
    labTestsArray.length,
  );

  const clinicalData: ClinicalSummaryRecordData = {
    summary: clinicalSummaryText,
    diagnoses: diagnosesArray,
    labTests: labTestsArray,
    sourceDocumentCount: docList.length,
    lastUpdatedAt: now,
  };

  const clinicalSummaryId = await upsertMedicalRecord(
    patientId,
    'clinical_summary',
    clinicalData as unknown as Record<string, unknown>,
  );

  return { prescriptionSummaryId, clinicalSummaryId };
}

/**
 * Citește dosarul și sumarele pacientului din `medical_records`.
 */
export async function getPatientRecords(patientId: string) {
  const supabase = getAdminClient();

  const { data: records, error } = await supabase
    .from('medical_records')
    .select('id, patient_id, record_type, clinical_data, created_at')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error('Eroare la citirea înregistrărilor medicale: ' + error.message);
  }

  const list = records || [];
  const prescriptionsRecord = list.find((r) => r.record_type === 'prescriptions');
  const clinicalSummaryRecord = list.find((r) => r.record_type === 'clinical_summary');

  return {
    prescriptions: prescriptionsRecord?.clinical_data ?? null,
    clinicalSummary: clinicalSummaryRecord?.clinical_data ?? null,
    records: list,
  };
}
