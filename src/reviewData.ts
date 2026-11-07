// Citirea datelor verificate de pacient (coloana medical_documents.review).
// Modul separat, ca records.ts și caseContext.ts să-l poată folosi fără import circular
// cu documentReview.ts (care la rândul lui actualizează sumarele din records.ts).

export type ReviewedMedication = {
  name: string;
  dose: string;
  frequency: string;
  duration: string | null;
};

export function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Medicamentele confirmate dintr-un document, sau null dacă pacientul nu l-a verificat încă.
// Defensiv: `review` vine din JSONB, deci nu presupunem forma.
export function confirmedMedicationsFromReview(review: unknown): ReviewedMedication[] | null {
  const medications = (review as { medications?: unknown } | null | undefined)?.medications;
  if (!Array.isArray(medications)) return null;
  const result: ReviewedMedication[] = [];
  for (const item of medications) {
    const row = (item ?? {}) as Record<string, unknown>;
    const name = textOrNull(row.name);
    const dose = textOrNull(row.dose);
    const frequency = textOrNull(row.frequency);
    if (!name || !dose || !frequency) return null; // un review stricat nu se prezintă ca „confirmat”
    result.push({ name, dose, frequency, duration: textOrNull(row.duration) });
  }
  return result;
}
