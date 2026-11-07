import type { AnalysisOutcome } from './aiClient';
import type { CaseSummary } from './schemas';
import { getAdminClient } from './supabaseAdmin';

// Salvează fiecare răspuns al analizei AI în tabelul `ai_analyses` (migrările 001 + 002
// din MedFlow-Database), ca medicul să-l poată revedea, nu doar o dată, în răspunsul HTTP.
//
// Cum se potrivesc câmpurile:
//   mereu                  -> case_summary = JSON.stringify(caseSummary) (sumarul folosit)
//   FINAL                 -> status 'completed'
//                             proposed_options    = cele 3 opțiuni (data.options)
//                             follow_up_questions = informațiile lipsă (data.missingInformation)
//                             context_relevance   = { contradictions: data.contradictions }
//   CLARIFICATION_REQUIRED -> status 'pending' (așteptăm răspunsul pacientului)
//                             follow_up_questions = [întrebarea de clarificare]
//
// Atenție: folosește cheia SECRETĂ (trece peste RLS). Ruta POST /cases/:id/analysis
// verifică ÎNAINTE că utilizatorul e medicul cazului.

// Ia o listă din răspunsul AI. Dacă LLM-ul a trimis altceva decât o listă, salvăm [] (nu ghicim).
function listFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Întoarce id-ul rândului salvat.
//
// caseSummary = sumarul pe care s-a făcut analiza (trimis de medic sau generat din mesaje).
//   Îl salvăm ca text JSON în case_summary (coloana e TEXT), ca medicul să vadă mereu
//   pe ce date a lucrat AI-ul.
// summarizedUntilMessageId = id-ul ultimului mesaj folosit la sumar, DOAR dacă sumarul
//   a fost generat din case_messages (altfel undefined și coloana rămâne NULL).
export async function saveAnalysis(
  caseId: string,
  outcome: AnalysisOutcome,
  model: string | undefined,
  caseSummary: CaseSummary,
  summarizedUntilMessageId: string | undefined,
): Promise<string> {
  // model_name e obligatoriu în tabel. Un serviciu AI mai vechi nu trimite modelul.
  const row: Record<string, unknown> = {
    case_id: caseId,
    model_name: model ?? 'necunoscut',
    case_summary: JSON.stringify(caseSummary),
  };
  if (summarizedUntilMessageId !== undefined) {
    row.summarized_until_message_id = summarizedUntilMessageId;
  }

  if (outcome.status === 'FINAL') {
    // `data` vine de la LLM, deci nu ne bazăm pe forma lui: citim câmpurile cu grijă.
    const data = typeof outcome.data === 'object' && outcome.data !== null ? (outcome.data as Record<string, unknown>) : {};
    row.status = 'completed';
    row.proposed_options = listFrom(data.options);
    row.follow_up_questions = listFrom(data.missingInformation);
    row.context_relevance = { contradictions: listFrom(data.contradictions) };
  } else {
    row.status = 'pending';
    row.follow_up_questions = typeof outcome.data === 'string' ? [outcome.data] : [];
  }

  const { data: saved, error } = await getAdminClient().from('ai_analyses').insert(row).select('id').single();
  if (error) {
    throw new Error('Nu am putut salva analiza AI: ' + error.message);
  }
  return saved.id as string;
}
