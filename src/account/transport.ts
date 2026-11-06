import { createClient } from '@supabase/supabase-js';

export interface RpcResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

export interface AccountTransport {
  verifyToken(token: string): Promise<boolean>;
  rpc(name: string, parameters: Record<string, string>, token?: string): Promise<RpcResult>;
}

function publicClient(token?: string) {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new Error('Account service is not configured');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}),
  });
}

export const accountTransport: AccountTransport = {
  async verifyToken(token) {
    // Validate with Auth; local JWT decoding cannot establish a trusted identity.
    const { data, error } = await publicClient().auth.getUser(token);
    if (error) {
      if (error.status === 400 || error.status === 401 || error.status === 403) return false;
      throw new Error('Identity service unavailable');
    }
    return Boolean(data.user);
  },
  async rpc(name, parameters, token) {
    const { data, error } = await publicClient(token).rpc(name, parameters);
    return { data, error };
  },
};
