import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Clientul Supabase al serverului. Folosește cheia SECRETĂ (service_role),
// care trece peste RLS: vede toate rândurile din toate tabelele.
// De aceea, fiecare rută care îl folosește TREBUIE să verifice singură cine are voie.
// Cheia stă doar în Backend/.env și nu ajunge niciodată în Frontend.

let adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  // Îl creăm o singură dată, la prima cerere care are nevoie de el.
  // Nu îl creăm la pornirea serverului, ca /health să meargă și fără chei Supabase.
  if (adminClient !== null) {
    return adminClient;
  }

  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error('Supabase nu e configurat: completează SUPABASE_URL și SUPABASE_SECRET_KEY în Backend/.env');
  }

  adminClient = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}
