import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy Backend/.env.example to Backend/.env and fill Supabase keys.`,
    );
  }
  return value;
}

/** Trusted backend client (service role). Bypasses RLS — authorize in code. */
export function createServiceSupabaseClient(): SupabaseClient {
  const url = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");
  return createClient(url, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/** User-scoped client (publishable key + JWT). Respects RLS if policies exist. */
export function createUserSupabaseClient(accessToken: string): SupabaseClient {
  const url = requireEnv("SUPABASE_URL");
  const publishableKey = requireEnv("SUPABASE_PUBLISHABLE_KEY");
  return createClient(url, publishableKey, {
    accessToken: async () => accessToken,
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

/** Lightweight connectivity check against public.profiles. */
export async function pingDatabase(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = createServiceSupabaseClient();
    const { error } = await client.from("profiles").select("id").limit(1);
    if (error) {
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown database error";
    return { ok: false, error: message };
  }
}
