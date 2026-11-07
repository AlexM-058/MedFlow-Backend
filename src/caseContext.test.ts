import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDocumentData } from './caseContext';

const extracted = { medications: [{ name: 'Amlodipină', dose: '5 mg', frequency: 'zilnic', duration: null }], warnings: [] };

test('an unreviewed document is labelled as unconfirmed and keeps the extracted data', () => {
  const text = describeDocumentData(extracted, null, null);
  assert.ok(text.includes('NECONFIRMAT'));
  assert.ok(text.includes('Amlodipină'));
});

test('a reviewed document shows the patient-confirmed medications, not the reader output', () => {
  const review = { medications: [{ name: 'Amlodipină', dose: '10 mg', frequency: 'zilnic', duration: null }] };
  const text = describeDocumentData(extracted, review, '2026-11-07T10:00:00Z');
  assert.ok(text.includes('confirmate de pacient'));
  assert.ok(text.includes('10 mg'));
  assert.ok(!text.includes('5 mg'));
  assert.ok(!text.includes('NECONFIRMAT'));
});

test('a broken review is never presented as confirmed, and missing data is stated explicitly', () => {
  assert.ok(describeDocumentData(extracted, { medications: [{ name: 'X' }] }, null).includes('NECONFIRMAT'));
  assert.ok(describeDocumentData(null, null, null).includes('fără date extrase'));
});
