import { resolveRoute, WORKER_ORIGIN } from './router';

/**
 * Published distribution point for proof-bundle Ed25519 verification keys
 * (referenced from services/worker verify-proof.ts). The shape IS the
 * verifier contract — `PublishedKeys` in packages/verifier-cli/src/types.ts
 * and packages/arkova-py/src/arkova/proofs.py: a top-level `keys` array of
 * {kid, alg, pem} entries that a signed bundle's `signing_key_id` resolves
 * against (unresolvable ids fail closed). The list is empty until
 * PROOF_SIGNING_* is configured on the production worker; publish the key
 * here in the same change that enables signing.
 */
const KEYS_JSON = {
  keys: [] as Array<{ kid: string; alg: 'Ed25519'; pem: string }>,
  updated: '2026-07-13',
  notice:
    'Verification keys for signed proof envelopes are published in the ' +
    '`keys` array as {kid, alg, pem}; a signed bundle\'s signing_key_id ' +
    'resolves against keys[].kid. No signing keys are currently published; ' +
    'signed proof envelopes (?format=signed) are not yet enabled in ' +
    'production. Unsigned proof bundles remain independently verifiable ' +
    'without any key.',
};

const API_INDEX = {
  service: 'arkova-api',
  versions: {
    v1: 'https://api.arkova.ai/v1',
    v2: 'https://api.arkova.ai/v2',
  },
  openapi: 'https://api.arkova.ai/openapi.json',
  health: 'https://api.arkova.ai/health',
  documentation: 'https://docs.arkova.ai/',
};

const DOCS_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arkova Developer Documentation</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #0f172a; }
  h1 { font-size: 1.5rem; } a { color: #0e7490; } li { margin: .5rem 0; }
</style>
</head>
<body>
<h1>Arkova Developer Documentation</h1>
<p>Resources for integrating with the Arkova verification platform:</p>
<ul>
  <li><a href="https://api.arkova.ai/openapi.json">OpenAPI specification</a> (Verification API)</li>
  <li><a href="https://api.arkova.ai/health">API health</a></li>
  <li><a href="/keys.json">Proof-signing verification keys</a> (keys.json)</li>
  <li><a href="https://app.arkova.ai">Dashboard &amp; API key management</a></li>
</ul>
<p>Integration guides are distributed to partners directly. Contact your Arkova integration manager for access.</p>
</body>
</html>
`;

function json(body: unknown, status = 200, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = resolveRoute(url.hostname, url.pathname);

    switch (route.kind) {
      case 'proxy': {
        const target = new URL(route.path + url.search, WORKER_ORIGIN);
        const headers = new Headers(request.headers);
        headers.set('X-Forwarded-Host', url.hostname);
        const clientIp = request.headers.get('CF-Connecting-IP');
        if (clientIp) headers.set('X-Forwarded-For', clientIp);
        const upstream = new Request(target.toString(), {
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
        });
        return fetch(upstream);
      }
      case 'index':
        return json(API_INDEX, 200, 'public, max-age=300');
      case 'keys':
        return json(KEYS_JSON, 200, 'public, max-age=300');
      case 'docs_index':
        return new Response(DOCS_INDEX_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      case 'not_found':
      default:
        return json({ error: 'not_found', message: 'Unknown path.' }, 404);
    }
  },
};
