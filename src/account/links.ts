/** Build share links only from deployment configuration, never request headers. */
export function accountLink(path: string, environment: NodeJS.ProcessEnv = process.env): string {
  const origin = new URL(environment.APP_ORIGIN?.trim() || 'http://127.0.0.1:5173');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) ||
      origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('Invalid application origin configuration');
  }
  const base = environment.APP_BASE_PATH?.trim() || '/';
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
    throw new Error('Invalid application base path configuration');
  }
  return `${origin.origin}${base}#/${path}`;
}
