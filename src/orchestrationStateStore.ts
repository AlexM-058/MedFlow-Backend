import type { OrchestrationState } from './aiClient';
import { getAdminClient } from './supabaseAdmin';

// Locul unde ținem starea analizei AI pentru medic între request-uri:
// coloana JSONB `cases.doctor_orchestration_state` (migrarea 003 din MedFlow-Database).
//
// Serviciul AI (MedFlow-AI/cloud/server.ts) nu are acces la baza de date. Ruta
// POST /cases/:id/analysis citește starea cu load(), i-o trimite serviciului AI
// și salvează cu save() starea nouă pe care o primește înapoi.
// Un caz = o sesiune de analiză AI (sessionId = id-ul cazului).
//
// Atenție: folosește cheia SECRETĂ (trece peste RLS). Nu verifică cine are voie;
// asta face ruta POST /cases/:id/analysis ÎNAINTE să citească sau să salveze starea.
export const supabaseStateStore = {
  // Citește starea salvată. Întoarce null dacă nu s-a salvat încă nimic (coloana e NULL).
  async load(caseId: string): Promise<OrchestrationState | null> {
    const { data, error } = await getAdminClient()
      .from('cases')
      .select('doctor_orchestration_state')
      .eq('id', caseId)
      .maybeSingle();
    if (error) {
      throw new Error('Nu am putut citi starea analizei AI: ' + error.message);
    }
    if (!data || data.doctor_orchestration_state === null) {
      return null;
    }
    return data.doctor_orchestration_state as OrchestrationState;
  },

  // Suprascrie starea cazului cu obiectul primit de la serviciul AI.
  async save(caseId: string, state: OrchestrationState): Promise<void> {
    const { data, error } = await getAdminClient()
      .from('cases')
      .update({ doctor_orchestration_state: state })
      .eq('id', caseId)
      .select('id');
    if (error) {
      throw new Error('Nu am putut salva starea analizei AI: ' + error.message);
    }
    // .update() pe un id inexistent NU dă eroare, doar modifică 0 rânduri.
    // Fără verificarea asta, contorul de runde s-ar pierde în tăcere.
    if (data.length === 0) {
      throw new Error('Nu am putut salva starea analizei AI: cazul ' + caseId + ' nu există');
    }
  },
};
