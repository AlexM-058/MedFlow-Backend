// Recunoaște tipul REAL al unui fișier după primii lui octeți („magic bytes”).
// Nu ne bazăm pe numele fișierului sau pe header-ul Content-Type, pentru că
// pe acestea le poate scrie oricine: un `virus.exe` redenumit `analize.png`
// are tot octeții unui .exe, deci aici e respins.

// Tipul MIME = numele standard al unui format de fișier (ex. 'image/png').
// Exact aceste trei valori sunt permise în coloana medical_documents.mime_type
// (CHECK din migrarea 002 a Database).
export type FileMimeType = 'image/jpeg' | 'image/png' | 'application/pdf';

// Tipurile de Content-Type pe care le acceptăm la upload.
export const ACCEPTED_CONTENT_TYPES: FileMimeType[] = ['image/jpeg', 'image/png', 'application/pdf'];

// Semnăturile (primii octeți) fiecărui format.
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // ‰PNG + 4 octeți de control
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // textul "%PDF-"

// Verifică dacă fișierul începe cu octeții din semnătură, unul câte unul.
function startsWith(file: Buffer, signature: number[]): boolean {
  if (file.length < signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i++) {
    if (file[i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

// Întoarce tipul MIME real ('image/jpeg', 'image/png' sau 'application/pdf'),
// ori null dacă fișierul nu e niciunul dintre ele.
export function detectMimeType(file: Buffer): FileMimeType | null {
  if (startsWith(file, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (startsWith(file, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (startsWith(file, PDF_SIGNATURE)) {
    return 'application/pdf';
  }
  return null;
}
