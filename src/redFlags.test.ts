// Teste pentru regulile de urgență (src/redFlags.ts). Doar texte sintetice.
// Rulare: npx tsx --test src/redFlags.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRedFlags, normalizeText } from './redFlags';

const EMERGENCY_MESSAGE =
  'ATENȚIE: Simptomele raportate pot indica o urgență medicală. Vă rugăm să contactați imediat serviciul de urgență 112.';
const SUICIDE_MESSAGE =
  'Vă rugăm să contactați imediat o linie de ajutor pentru prevenirea suicidului sau serviciul de urgență 112.';

// Verifică un text care TREBUIE să declanșeze avertismentul general (112).
function assertEmergency(text: string) {
  const result = detectRedFlags(text);
  assert.equal(result.isEmergency, true, 'ar fi trebuit să fie urgență: ' + text);
  assert.equal(result.message, EMERGENCY_MESSAGE);
}

test('normalizeText scoate diacriticele (ambele forme de ș/ț), punctuația și literele mari', () => {
  assert.equal(normalizeText('DURERE ÎN PIEPT!'), 'durere in piept');
  assert.equal(normalizeText('Mă doare pieptul'), 'ma doare pieptul');
  // ș/ț cu virgulă (U+0219, U+021B) și ş/ţ cu sedilă (U+015F, U+0163)
  assert.equal(normalizeText('șț şţ'), 'st st');
  assert.equal(normalizeText("  mi-am   pierdut, cunoștința.  "), 'mi am pierdut cunostinta');
});

test('durere în piept: cu și fără diacritice, singular/plural, majuscule', () => {
  assertEmergency('Am durere în piept de azi-dimineață.');
  assertEmergency('am durere in piept');
  assertEmergency('Am dureri în piept când urc scările');
  assertEmergency('DURERE ÎN PIEPT');
  assertEmergency('tensiune în piept');
});

test('dificultate de respirație și semne de AVC (RO)', () => {
  assertEmergency('Am dificultate de respirație');
  assertEmergency('am dificultate de respiratie de o ora');
  assertEmergency('Nu pot respira bine');
  assertEmergency('Bunicul are vorbire neclară și paralizie facială');
  assertEmergency('Cred că fac un AVC');
});

test('variantele românești noi', () => {
  assertEmergency('Mă doare pieptul foarte tare');
  assertEmergency('ma doare pieptul');
  assertEmergency('Nu mai pot respira');
  assertEmergency('Aseară am leșinat în baie');
  assertEmergency('simt că leșin');
  // ş cu sedilă (tastaturi mai vechi) trebuie tratat la fel ca ș cu virgulă
  assertEmergency('am leşinat');
});

test('reguli în engleză, verificate indiferent de limbă', () => {
  assertEmergency('I have chest pain');
  assertEmergency('Tightness in chest since morning');
  assertEmergency("I can't breathe");
  assertEmergency('difficulty breathing');
  assertEmergency('slurred speech and facial paralysis');
  assertEmergency('I fainted at work');
  // Text amestecat RO + EN
  assertEmergency('Doctore, am chest pain de ieri');
});

test('suicid: mesaj specific (linia de ajutor + 112), în RO și EN', () => {
  for (const text of [
    'Am idei suicidare',
    'Vreau să mă sinucid',
    'vreau sa mor',
    'Uneori VREAU SĂ MOR',
    'I want to kill myself',
    'I have suicidal thoughts',
  ]) {
    const result = detectRedFlags(text);
    assert.equal(result.isEmergency, true, 'ar fi trebuit să fie urgență: ' + text);
    assert.equal(result.message, SUICIDE_MESSAGE);
  }
});

test('dacă apar și suicid, și durere în piept, câștigă mesajul pentru suicid', () => {
  const result = detectRedFlags('Am dureri în piept și vreau să mor');
  assert.equal(result.message, SUICIDE_MESSAGE);
});

test('mesaje obișnuite NU declanșează avertismentul', () => {
  for (const text of [
    'Am avut dureri de cap ieri',
    'Am mâncat piept de pui la cină',
    'Respir normal, mă simt mai bine',
    'Am luat pastilele cum a zis doctorul',
    'Tusea s-a mai liniștit',
    'Analizele de sânge sunt atașate',
    'My headache is better today',
    '',
  ]) {
    const result = detectRedFlags(text);
    assert.deepEqual(result, { isEmergency: false, message: '' }, 'nu trebuia să fie urgență: ' + text);
  }
});

test('se potrivesc doar cuvinte întregi', () => {
  // „avc” apare în interiorul altui cuvânt inventat → nu e urgență
  assert.equal(detectRedFlags('codul avcx123 din rețetă').isEmergency, false);
  // „want to die” nu trebuie să se potrivească în „want to diet”
  assert.equal(detectRedFlags('I want to diet').isEmergency, false);
});
