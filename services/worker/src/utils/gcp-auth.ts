/**
 * GCP access-token provider — no SDK dependency.
 *
 * Resolves an OAuth2 access token for calling Google Cloud REST APIs from
 * either:
 *   (a) Cloud Run's metadata server (production), or
 *   (b) a service-account JSON in GCP_SA_KEY_JSON (local dev + tests).
 *
 * Cached with a safety margin so we don't burn tokens on every call. Never
 * logs the token; exposes only a boolean `hasCredential()` for health checks.
 *
 * Used by GCP-MAX-03 (Cloud Logging audit pipe) and GCP-MAX-02 (BigQuery
 * warehouse) — neither needs @google-cloud/* npm packages.
 */

import { logger } from './logger.js';

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/** Refresh slightly before expiry so the request doesn't race the token TTL. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * True iff we have some way to get a token. Used by health checks without
 * triggering an actual token exchange.
 */
export function hasGcpCredential(): boolean {
  return (
    // Cloud Run sets K_SERVICE; the metadata server is always reachable there.
    Boolean(process.env.K_SERVICE) ||
    Boolean(process.env.GCP_SA_KEY_JSON) ||
    Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  );
}

/**
 * Get a valid GCP access token. Cached until just before expiry.
 *
 * Prefers metadata server on Cloud Run (no secret on disk). Falls back to
 * GCP_SA_KEY_JSON for local dev. GOOGLE_APPLICATION_CREDENTIALS path-based
 * auth is NOT supported here — use `@google-cloud/auth` if you need that;
 * this util is intentionally dep-free.
 */
export async function getGcpAccessToken(scope = 'https://www.googleapis.com/auth/cloud-platform'): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - REFRESH_MARGIN_MS > now) {
    return cachedToken.token;
  }

  if (process.env.K_SERVICE) {
    cachedToken = await fetchFromMetadataServer();
    return cachedToken.token;
  }

  const keyJson = process.env.GCP_SA_KEY_JSON;
  if (keyJson) {
    cachedToken = await fetchFromServiceAccountJson(keyJson, scope);
    return cachedToken.token;
  }

  throw new Error(
    'GCP credential missing. In production, worker must run on Cloud Run (K_SERVICE). ' +
      'For local dev, set GCP_SA_KEY_JSON to a JSON-stringified service-account key.',
  );
}

async function fetchFromMetadataServer(): Promise<CachedToken> {
  // Cloud Run injects the metadata server at this host. The Workload Identity
  // path auto-selects the bound service account.
  const url =
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
  const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) {
    throw new Error(`Metadata server token fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token || !body.expires_in) {
    throw new Error('Metadata server returned malformed token response');
  }
  return {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

async function fetchFromServiceAccountJson(keyJson: string, scope: string): Promise<CachedToken> {
  let key: { client_email?: string; private_key?: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    throw new Error('GCP_SA_KEY_JSON is not valid JSON');
  }
  if (!key.client_email || !key.private_key) {
    throw new Error('GCP_SA_KEY_JSON missing client_email or private_key');
  }

  // JWT bearer flow per https://developers.google.com/identity/protocols/oauth2/service-account
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const jwt = await signJwt(header, payload, key.private_key);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn({ status: res.status, text: text.slice(0, 200) }, 'GCP SA token exchange failed');
    throw new Error(`SA token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token || !body.expires_in) {
    throw new Error('SA token exchange returned malformed response');
  }
  return {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

async function signJwt(
  header: Record<string, string>,
  payload: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> {
  const { createSign } = await import('node:crypto');
  const b64url = (b: Buffer | string): string =>
    Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const encoded = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(encoded);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${encoded}.${b64url(signature)}`;
}

/** Clear the cache. Tests only. */
export function _resetGcpTokenCache(): void {
  cachedToken = null;
}
