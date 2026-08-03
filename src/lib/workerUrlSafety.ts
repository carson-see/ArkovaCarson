const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;
const DEV_DEFAULT_WORKER_URL = 'http://localhost:3001';

/**
 * Resolve the worker base URL from a `VITE_WORKER_URL`-shaped value, WITHOUT
 * ever silently falling back to the developer default in a production build.
 *
 * Root cause this replaces: several call sites read
 * `import.meta.env.VITE_WORKER_URL || 'http://localhost:3001'` directly. When
 * VITE_WORKER_URL is unset at build time (e.g. not configured in Vercel
 * project settings), Vite bakes the localhost fallback into the production
 * bundle. Every browser that loads that bundle then silently POSTs worker
 * requests to `localhost:3001` on the USER'S OWN MACHINE — connection
 * refused client-side, zero requests ever reach the real worker, and prod
 * worker logs show nothing. The failure looks like "the email could not be
 * sent" with no trace anywhere it would get noticed.
 *
 * Call this INSIDE the function that performs the request (never at module
 * top level) so a misconfigured deployment fails loudly only when a worker
 * call is actually attempted, not on page load.
 */
export function resolveWorkerBaseUrl(configuredUrl: string | undefined): string {
  if (configuredUrl) return configuredUrl;

  if (import.meta.env.PROD) {
    const message =
      'Worker URL is not configured for this production build (VITE_WORKER_URL is unset). ' +
      'Set VITE_WORKER_URL in the deployment environment (Vercel project settings) to the ' +
      "worker URL and redeploy. Refusing to fall back to the developer default, which would " +
      "send requests to this browser's own machine instead of the production worker.";
    console.error(message);
    throw new Error(message);
  }

  return DEV_DEFAULT_WORKER_URL;
}

export function resolveSafeWorkerEndpoint(workerUrl: string, path: string): URL {
  let base: URL;
  let endpoint: URL;
  try {
    base = new URL(workerUrl.endsWith('/') ? workerUrl : `${workerUrl}/`);
    endpoint = new URL(path, base);
  } catch {
    throw new Error('Worker endpoint must be a valid URL.');
  }

  if (URL_SCHEME_RE.test(path) || endpoint.origin !== base.origin) {
    throw new Error('Worker endpoint path must stay on the configured worker origin.');
  }

  const isLocalHttp = endpoint.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Worker endpoint must use HTTPS outside localhost.');
  }

  return endpoint;
}
