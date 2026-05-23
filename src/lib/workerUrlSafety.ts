const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/;

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
