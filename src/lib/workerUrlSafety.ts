const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function resolveSafeWorkerEndpoint(workerUrl: string, path: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(path, workerUrl.endsWith('/') ? workerUrl : `${workerUrl}/`);
  } catch {
    throw new Error('Worker endpoint must be a valid URL.');
  }

  const isLocalHttp = endpoint.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Worker endpoint must use HTTPS outside localhost.');
  }

  return endpoint;
}
