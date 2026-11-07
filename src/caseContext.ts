import { getAdminClient } from './supabaseAdmin';

// Citește din baza de date ce are nevoie analiza AI despre un caz:
//   - mesajele cazului (case_messages), din care serviciul AI face sumarul cazului
//   - documentele cazului (medical_documents), din care facem textul `documentsContext`
//
// Atenție: folosește cheia SECRETĂ (trece peste RLS) și NU verifică cine are voie.
// Ruta POST /cases/:id/analysis verifică ÎNAINTE că utilizatorul e medicul cazului.

// Un mesaj din case_messages, cu coloanele de care avem nevoie.
export type CaseMessageRow = {
  id: string;
  sender_role: string;
  content: string;
  created_at: string;
};

// Mesajele cazului pentru sumar, în ordine cronologică (cel mai vechi primul).
// Întoarce [] dacă nu există niciun mesaj.
//
// NU luăm mesajele cu sender_role = 'system': acelea sunt avertismente puse de aplicație
// (de ex. „sunați la 112”, adăugat de ruta POST /cases/:id/messages când găsește o urgență),
// nu lucruri spuse de pacient sau de medic. Altfel ar apărea în sumar ca și cum le-ar fi spus cineva.
// Urgența nu se pierde: serviciul AI verifică din nou, cu reguli fixe, mesajele pacientului.
export async function loadCaseMessages(caseId: string): Promise<CaseMessageRow[]> {
  const { data, error } = await getAdminClient()
    .from('case_messages')
    .select('id, sender_role, content, created_at')
    .eq('case_id', caseId)
    .neq('sender_role', 'system')
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error('Nu am putut citi mesajele cazului: ' + error.message);
  }
  return data as CaseMessageRow[];
}

// Cât text despre documente trimitem, cel mult, la analiza AI. Peste limită tăiem textul
// și adăugăm o notă clară, ca medicul (și AI-ul) să știe că nu au văzut tot.
export const MAX_DOCUMENTS_CONTEXT_CHARS = 20_000;

const TRUNCATED_NOTE =
  `[ATENȚIE: Contextul documentelor a fost tăiat la ${MAX_DOCUMENTS_CONTEXT_CHARS} de caractere. ` +
  'Unele documente sau părți din ele NU au fost incluse în analiză; medicul trebuie să le verifice direct.]';

// Ce întoarce buildDocumentsContext.
export type DocumentsContext = {
  text: string | undefined; // undefined = nu avem nimic de trimis (nici documente, nici text de la medic)
  documentCount: number; // câte documente are cazul
  truncated: boolean; // true = textul a fost tăiat la MAX_DOCUMENTS_CONTEXT_CHARS
};

// Construiește textul `documentsContext` pentru analiza AI:
//   1. citim documentele cazului, în ordinea în care au fost încărcate
//   2. pentru fiecare document scriem un bloc: categoria, data încărcării și datele extrase (JSON)
//   3. dacă medicul a trimis și el `documentsContext`, îl adăugăm la final
//   4. dacă textul e prea lung, îl tăiem și adăugăm nota TRUNCATED_NOTE
//
// Exemplu de bloc:
//   --- Document 1 din 2 ---
//   Categorie: lab_result
//   Încărcat la: 2026-11-05T10:00:00+00:00
//   Date extrase (JSON):
//   { "lab_results": [ ... ] }
export async function buildDocumentsContext(caseId: string, extraContext: string | undefined): Promise<DocumentsContext> {
  const { data, error } = await getAdminClient()
    .from('medical_documents')
    .select('document_type, created_at, extracted_data')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error('Nu am putut citi documentele cazului: ' + error.message);
  }

  const blocks: string[] = [];
  let documentNumber = 0;
  for (const document of data) {
    documentNumber++;
    // extracted_data e NULL dacă nu s-a extras nimic; scriem asta explicit, nu sărim documentul.
    let extracted = '(fără date extrase)';
    if (document.extracted_data !== null && document.extracted_data !== undefined) {
      extracted = JSON.stringify(document.extracted_data, null, 2);
    }
    blocks.push(
      `--- Document ${documentNumber} din ${data.length} ---\n` +
        `Categorie: ${document.document_type}\n` +
        `Încărcat la: ${document.created_at}\n` +
        `Date extrase (JSON):\n${extracted}`,
    );
  }

  // Textul trimis de medic (dacă există și nu e gol) vine după documente.
  if (extraContext !== undefined && extraContext.trim() !== '') {
    blocks.push(`--- Context suplimentar trimis de medic ---\n${extraContext.trim()}`);
  }

  if (blocks.length === 0) {
    return { text: undefined, documentCount: 0, truncated: false };
  }

  let text = blocks.join('\n\n');
  let truncated = false;
  if (text.length > MAX_DOCUMENTS_CONTEXT_CHARS) {
    text = text.slice(0, MAX_DOCUMENTS_CONTEXT_CHARS) + '\n\n' + TRUNCATED_NOTE;
    truncated = true;
  }
  return { text, documentCount: data.length, truncated };
}
