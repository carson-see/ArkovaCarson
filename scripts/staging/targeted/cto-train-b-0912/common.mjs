// Shared helpers for the cto-train-b-0912 targeted train driver.
// Self-contained on purpose; only @supabase/supabase-js is external (repo root).
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const RIG_REF = process.env.TRAIN_RIG_REF ?? 'xhvasifpunswhsgfsstd';
export const SUPABASE_URL = `https://${RIG_REF}.supabase.co`;
export const SERVICE = process.env.TRAIN_SERVICE ?? 'arkova-worker-cto-train-b-0912-staging';
export const REGION = 'us-central1';
export const TAG_URL = process.env.TRAIN_TAG_URL
  ?? 'https://arkova-worker-cto-train-b-0912-staging-270018525501.us-central1.run.app';
// The soaked head. Set by supervisor.sh from the admitted candidate; never hardcode.
export const CANDIDATE_SHA = process.env.TRAIN_CANDIDATE_SHA ?? '';
export const PREFIX = 'cto-train-b-0912';

export function iamToken() {
  return execFileSync('gcloud', ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim();
}

// Mirrors services/worker/src/auth/apiKeys.ts: HMAC-SHA256(rawKey) hex under API_KEY_HMAC_SECRET.
export function hashApiKey(rawKey, secret) {
  return createHmac('sha256', secret).update(rawKey).digest('hex');
}

/** probe(name, expected, actual, {detail, pass}) -> {name, expected, actual, pass, detail} */
export function probe(name, expected, actual, opts = {}) {
  const exp = Array.isArray(expected) ? expected : [expected];
  const pass = opts.pass ?? exp.includes(actual);
  return { name, expected: exp.length === 1 ? exp[0] : exp, actual, pass, detail: opts.detail ?? null };
}

export async function workerFetch(path, { method = 'GET', headers = {}, body, apiKeyRaw, jwt } = {}) {
  const h = { 'X-Serverless-Authorization': `Bearer ${iamToken()}`, ...headers };
  if (apiKeyRaw) h.Authorization = `Bearer ${apiKeyRaw}`;
  if (jwt) h.Authorization = `Bearer ${jwt}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30_000);
  try {
    const r = await fetch(`${TAG_URL}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: r.status, headers: Object.fromEntries(r.headers.entries()), body: json, text };
  } catch (e) {
    return { status: 0, headers: {}, body: null, text: String(e) };
  } finally { clearTimeout(t); }
}

export async function restFetch(path, { apikey, jwt, method = 'GET', body, headers = {} } = {}) {
  const h = { apikey, Authorization: `Bearer ${jwt ?? apikey}`, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: json, text };
}
