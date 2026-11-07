// Reguli deterministe de urgență („red flags”) pentru mesajele pacientului.
//
// ORIGINE: regulile vin din MedFlow-AI/edge/safety/redflags.ts (detectRedFlags).
// Backend-ul NU importă fișiere din MedFlow-AI (sunt repo-uri și servicii separate),
// așa că am copiat regulile aici. Cele două liste TREBUIE ținute sincronizate:
// dacă adaugi sau scoți o regulă într-un loc, fă la fel și în celălalt.
//
// De ce verificarea stă în Backend și nu în serviciul AI:
// serviciul AI poate fi oprit sau lent la pornire (ex.: un agent local care nu rulează,
// sau un model care se încarcă ~1 minut). Avertismentul de urgență trebuie să ajungă la pacient imediat,
// chiar dacă AI-ul nu răspunde. De aceea aici NU există niciun LLM: doar o listă
// fixă de expresii, verificată cu cod simplu. Regulile nu pun diagnostice; doar
// îi spun pacientului să sune la 112.
//
// Cum funcționează (la fel ca în MedFlow-AI/edge/safety/redflags.ts, aceleași expresii):
// 1. Comparăm pe text „normalizat”: litere mici, fără diacritice, fără punctuație.
//    Astfel „DURERE ÎN PIEPT”, „durere in piept” și „dureri în piept,” se potrivesc.
// 2. Verificăm mereu și regulile în română, și pe cele în engleză (pacientul poate
//    scrie în orice limbă, indiferent de limba aleasă în aplicație).
// Singura diferență: aici mesajul e mereu în română; în AI poate fi și în engleză.

export interface RedFlagResult {
  isEmergency: boolean;
  // Avertismentul pentru pacient (în română). Gol când nu e urgență.
  message: string;
}

const EMERGENCY_MESSAGE =
  'ATENȚIE: Simptomele raportate pot indica o urgență medicală. Vă rugăm să contactați imediat serviciul de urgență 112.';

const SUICIDE_MESSAGE =
  'Vă rugăm să contactați imediat o linie de ajutor pentru prevenirea suicidului sau serviciul de urgență 112.';

// O regulă = un grup de expresii + mesajul afișat dacă oricare expresie apare în text.
// Expresiile se scriu fără diacritice și cu litere mici (oricum le normalizăm și pe ele).
// Se potrivesc doar cuvinte întregi: „lesin” NU se potrivește în „lesinat”,
// de aceea scriem explicit fiecare formă de care avem nevoie.
interface RedFlagRule {
  name: string; // doar ca să știe cine citește codul ce verifică regula
  phrases: string[];
  message: string;
}

// Ordinea contează: prima regulă găsită câștigă. Punem suicidul primul,
// pentru că are un mesaj specific (linia de ajutor), care pomenește și 112.
const RED_FLAG_RULES: RedFlagRule[] = [
  {
    name: 'suicid',
    phrases: [
      // RO
      'idei suicidare',
      'ganduri suicidare',
      'vreau sa ma sinucid',
      'vreau sa mor',
      'nu mai vreau sa traiesc',
      // EN
      'suicidal ideation',
      'suicidal thoughts',
      'want to kill myself',
      'want to die',
    ],
    message: SUICIDE_MESSAGE,
  },
  {
    name: 'durere in piept',
    phrases: [
      // RO
      'durere in piept',
      'dureri in piept',
      'durere la piept',
      'dureri la piept',
      'tensiune in piept',
      'apasare in piept',
      'ma doare pieptul',
      'ma doare in piept',
      // EN
      'chest pain',
      'tightness in chest',
      'my chest hurts',
    ],
    message: EMERGENCY_MESSAGE,
  },
  {
    name: 'dificultate de respiratie',
    phrases: [
      // RO
      'dificultate de respiratie',
      'dificultati de respiratie',
      'nu pot respira',
      'nu mai pot respira',
      'nu pot sa respir',
      'ma sufoc',
      // EN
      'difficulty breathing',
      'cannot breathe',
      "can't breathe",
    ],
    message: EMERGENCY_MESSAGE,
  },
  {
    name: 'semne de accident vascular cerebral',
    phrases: [
      // RO
      'accident vascular cerebral',
      'avc',
      'paralizie faciala',
      'vorbire neclara',
      // EN
      'stroke signs',
      'having a stroke',
      'facial paralysis',
      'slurred speech',
    ],
    message: EMERGENCY_MESSAGE,
  },
  {
    name: 'pierderea cunostintei',
    phrases: [
      // RO
      'am lesinat',
      'a lesinat',
      'lesin',
      'mi-am pierdut cunostinta',
      // EN
      'fainted',
      'passed out',
    ],
    message: EMERGENCY_MESSAGE,
  },
];

// Aduce textul la o formă comună, ca să comparăm „mere cu mere”.
// Exemplu: „Mă DOARE pieptul!!” → „ma doare pieptul”.
export function normalizeText(text: string): string {
  // 1. NFD desparte litera de semnul ei: „ă” devine „a” + „˘” (un caracter separat).
  //    Merge pentru ambele forme de ș/ț: cu virgulă (ș, ț) și cu sedilă (ş, ţ).
  let result = text.normalize('NFD');
  // 2. Ștergem semnele separate (caracterele Unicode U+0300–U+036F).
  result = result.replace(/[̀-ͯ]/g, '');
  // 3. Litere mici.
  result = result.toLowerCase();
  // 4. Orice nu e literă sau cifră (spații, punctuație, cratime, apostrofuri)
  //    devine un singur spațiu. „mi-am” → „mi am”, „can't” → „can t”.
  result = result.replace(/[^a-z0-9]+/g, ' ');
  // 5. Fără spații la capete.
  return result.trim();
}

// Verifică dacă mesajul pacientului conține un semnal de urgență.
// Întoarce { isEmergency: true, message: avertismentul } la prima regulă găsită,
// altfel { isEmergency: false, message: '' }.
export function detectRedFlags(text: string): RedFlagResult {
  // Punem câte un spațiu la capete, ca să căutăm „ expresie ” = cuvinte întregi.
  // Așa „avc” nu se potrivește într-un cuvânt mai lung care doar îl conține.
  const normalizedText = ' ' + normalizeText(text) + ' ';

  for (const rule of RED_FLAG_RULES) {
    for (const phrase of rule.phrases) {
      const normalizedPhrase = ' ' + normalizeText(phrase) + ' ';
      if (normalizedText.includes(normalizedPhrase)) {
        return { isEmergency: true, message: rule.message };
      }
    }
  }

  return { isEmergency: false, message: '' };
}
