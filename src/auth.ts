import type { NextFunction, Request, Response } from 'express';
import { getAdminClient } from './supabaseAdmin';

// Utilizatorul care face cererea, după ce i-am verificat token-ul.
export type CurrentUser = {
  id: string;
  role: 'patient' | 'doctor';
};

// Middleware = o funcție care rulează ÎNAINTE de rută.
// Răspunde la întrebarea „cine ești?” (autentificare):
//   1. citește token-ul din header-ul Authorization: "Bearer <token>"
//   2. îl verifică la Supabase Auth -> aflăm id-ul utilizatorului
//   3. caută rolul lui (patient/doctor) în tabelul profiles
//   4. îl pune în response.locals.user, de unde îl citesc rutele
export async function requireUser(request: Request, response: Response, next: NextFunction) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    response.status(401).json({ error: 'Lipsește token-ul de autentificare' });
    return;
  }
  const token = header.slice('Bearer '.length);

  const supabase = getAdminClient();
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    response.status(401).json({ error: 'Token invalid sau expirat' });
    return;
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (profileError) {
    throw new Error('Nu am putut citi profilul: ' + profileError.message);
  }
  if (!profile) {
    response.status(403).json({ error: 'Utilizatorul nu are profil în MedFlow' });
    return;
  }

  const user: CurrentUser = { id: profile.id, role: profile.role };
  response.locals.user = user;
  next();
}
