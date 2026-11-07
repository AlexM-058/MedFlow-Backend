type AgentResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: 502 | 503 | 504; error: string };

/** Server-to-server only. Never forward this credential to a browser. */
export function createLocalAgentClient(environment: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  return async (operation: 'ready' | 'intake' | 'summary' | 'control-questions', payload?: unknown): Promise<AgentResult> => {
    const configured = environment.LOCAL_AGENT_URL?.trim();
    const token = environment.LOCAL_AGENT_TOKEN?.trim();
    if (!configured || !token || token.length < 32) return { ok: false, status: 503, error: 'Agentul local nu este configurat.' };
    let url: URL;
    try {
      url = new URL(configured);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error();
    } catch { return { ok: false, status: 503, error: 'Adresa agentului local nu este validă.' }; }
    try {
      const response = await fetcher(new URL(`/${operation}`, url), {
        method: operation === 'ready' ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(operation === 'ready' ? {} : { 'Content-Type': 'application/json' }) },
        ...(operation === 'ready' ? {} : { body: JSON.stringify(payload) }),
        redirect: 'error', signal: AbortSignal.timeout(operation === 'ready' ? 10000 : 100000),
      });
      if (!response.ok) return { ok: false, status: 503, error: 'Agentul local este indisponibil sau ocupat.' };
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, status: 502, error: 'Răspuns invalid de la agentul local.' };
      return { ok: true, data: data as Record<string, unknown> };
    } catch (error) {
      return { ok: false, status: error instanceof Error && error.name === 'TimeoutError' ? 504 : 503, error: 'Conexiunea cu agentul local a eșuat.' };
    }
  };
}
