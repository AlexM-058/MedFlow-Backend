import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrescriptionSummary, generateClinicalSummary } from './records';

test('generatePrescriptionSummary with no medications returns clear message', () => {
  const result = generatePrescriptionSummary([]);
  assert.equal(result, 'Nu există rețete sau medicamente înregistrate în dosar.');
});

test('generatePrescriptionSummary correctly formats multiple medications and details', () => {
  const result = generatePrescriptionSummary([
    {
      documentId: 'doc-1',
      documentType: 'prescription',
      date: '14.03.2025',
      medications: [
        { name: 'Amlodipină', dose: '5 mg', frequency: '1 cp dimineața', duration: '30 zile' },
        { name: 'Metformin', dose: '1000 mg', frequency: '2 cp/zi', duration: null },
      ],
    },
  ]);

  assert.ok(result.includes('Tratament activ (2 medicamente)'));
  assert.ok(result.includes('Amlodipină (5 mg, 1 cp dimineața, 30 zile)'));
  assert.ok(result.includes('Metformin (1000 mg, 2 cp/zi)'));
});

test('generateClinicalSummary handles empty documents gracefully', () => {
  const result = generateClinicalSummary(0, [], 0, 0);
  assert.equal(result, 'Dosar medical nou. Nu au fost încărcate documente sau antecedente medicale.');
});

test('generateClinicalSummary synthesizes diagnoses, treatments and lab tests', () => {
  const result = generateClinicalSummary(
    2,
    ['Hipertensiune arterială', 'Diabet zaharat tip 2'],
    3,
    5,
  );

  assert.ok(result.includes('Dosar clinic actualizat pe baza a 2 documente.'));
  assert.ok(result.includes('Hipertensiune arterială, Diabet zaharat tip 2'));
  assert.ok(result.includes('Tratamente prescrise: 3 produse.'));
  assert.ok(result.includes('Analize de laborator: 5 parametri înregistrați.'));
});
