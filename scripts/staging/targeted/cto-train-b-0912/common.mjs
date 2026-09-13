// Shared helpers for the cto-train-b-0912 targeted train driver.
// Self-contained on purpose; only @supabase/supabase-js is external (repo root).
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const RIG_REF = process.env.TRAIN_RIG_REF ?? 'xhvasifpunswhsgfsstd';
export const SUPABASE_URL = `https://${RIG_REF}.supabase.co`;
export const SERVICE = process.env.TRAIN_SERVICE ?? 'arkova-worker-cto-train-b-0912-staging';
export const REGION = 'us-central1';
export const TAG_URL = process.env.TRAIN_TAG_URL
  ?? 'https://arkova-worker-cto-train-b-0912-staging-270018525501.us-central1.run.app';
// The soaked head. Set by supervisor.sh from the admitted candidate; never hardcode.
export const CANDIDATE_SHA = process.env.TRAIN_CANDIDATE_SHA ?? '';
export const PREFIX = 'cto-train-b-0912';
// Mirrors setup.mjs / train-cycle.mjs's own default — kept in sync deliberately
// so signInMfa() persists TOTP secrets to the same file those scripts read.
export const FIXTURE_STATE_PATH = process.env.FIXTURE_STATE
  ?? '/Volumes/Extreme/offload/cto-soak-2026-09-12/train-b/state/fixtures.json';

export function iamToken() {
  return execFileSync('gcloud', ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim();
}

// Mirrors services/worker/src/auth/apiKeys.ts: HMAC-SHA256(rawKey) hex under API_KEY_HMAC_SECRET.
export function hashApiKey(rawKey, secret) {
  return createHmac('sha256', secret).update(rawKey).digest('hex');
}

// Short, non-secret fingerprint of the API_KEY_HMAC_SECRET a fixture key was
// minted under. This driver's own env sources the secret by NAME, not value
// (gcloud secrets versions access --secret=<name>), and different rigs/deploys
// reference different secret names (e.g. the standing rig's Cloud Run service
// mounts `api-key-hmac-secret`, not the isolated Train B rig's
// `api-key-hmac-secret-staging` — confirmed different values 2026-09-13).
// Persisting this fingerprint alongside a minted key lets seed() detect "this
// key was hashed under a secret that is no longer the one this run has" and
// re-mint, instead of trusting a raw key that will 401 invalid_api_key against
// whichever worker is actually being driven this run.
export function apiKeyHmacFingerprint(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
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

// ─────────────────────────────────────────────────────────────────────────
// MFA-capable sign-in (0451_uat04_mandatory_mfa.sql).
//
// Since 0451, a fresh password-grant session is AAL1. The custom
// access-token hook (when Auth config has it enabled) relabels an AAL1
// session's role to `arkova_mfa_pending`; either way — hook enabled or not —
// PostgREST's pre-request hook (`private.enforce_human_mfa_pre_request`)
// rejects any `authenticated`/`arkova_mfa_pending` role whose JWT `aal` is
// not `aal2`, and a RESTRICTIVE RLS policy (`mfa_verified_authenticated`)
// requires `private.is_human_mfa_verified()` (aal2) on every RLS table. The
// worker's own session-JWT auth path (extractAuthUserId) sits in front of
// that and answers "Authentication required" once its own downstream lookups
// hit the same AAL2 wall. None of this blocks GoTrue's own
// enroll/challenge/verify endpoints — 0451's own migration comment: "GoTrue's
// MFA enroll/challenge/verify endpoints remain available to complete the
// gate" — because those are authenticated by the JWT's user id/signature,
// not by the Postgres role PostgREST would have assumed.
// ─────────────────────────────────────────────────────────────────────────

/** Decode a JWT's payload without verifying the signature (local, read-only introspection). */
export function decodeJwt(token) {
  try {
    const part = token.split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return {}; }
}

function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32.replace(/=+$/, '').toUpperCase()) {
    const val = alphabet.indexOf(ch);
    if (val === -1) continue; // tolerate stray whitespace/hyphens some issuers add
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP: SHA1, 30s step, 6 digits (RFC 4226 HOTP under the hood). No external dependency. */
export function totpCode(secretBase32, { step = 30, digits = 6, at = Date.now() } = {}) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(at / 1000 / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** digits).padStart(digits, '0');
}

/** GoTrue password grant. Same shape #2841/#2845/#2911 each hand-rolled; kept low-level on purpose. */
export async function passwordGrant(supabaseUrl, anonKey, email, password) {
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => null);
  return {
    status: r.status,
    accessToken: body?.access_token ?? null,
    refreshToken: body?.refresh_token ?? null,
    error: body?.error_description ?? body?.msg ?? null,
  };
}

async function gotrue(supabaseUrl, anonKey, accessToken, path, { method = 'GET', body } = {}) {
  const r = await fetch(`${supabaseUrl}/auth/v1${path}`, {
    method,
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: r.status, body: json, text };
}

/** Read-modify-write FIXTURE_STATE so a TOTP secret enrolled this cycle survives into the next
 * (train-cycle.mjs re-reads the file fresh every 5-minute cycle; it never sees this process's
 * in-memory mutation otherwise). Re-reads from disk first so a sibling probe's own write in the
 * same cycle — or another session's — is not clobbered; only this stateKey's totp fields change. */
function persistTotpFactor(stateKey, factorId, secret) {
  let onDisk = {};
  try { onDisk = JSON.parse(readFileSync(FIXTURE_STATE_PATH, 'utf8')); } catch { /* fresh */ }
  onDisk[stateKey] = { ...(onDisk[stateKey] ?? {}), totpFactorId: factorId, totpSecret: secret };
  writeFileSync(FIXTURE_STATE_PATH, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
}

async function challengeAndVerify(supabaseUrl, anonKey, aal1Token, factorId, secret, retriesLeft = 1) {
  const challenge = await gotrue(supabaseUrl, anonKey, aal1Token, `/factors/${factorId}/challenge`, { method: 'POST' });
  if (!challenge.body?.id) {
    throw new Error(`signInMfa: challenge failed for factor ${factorId}: ${challenge.status} ${challenge.text?.slice(0, 300)}`);
  }
  const code = totpCode(secret);
  const verify = await gotrue(supabaseUrl, anonKey, aal1Token, `/factors/${factorId}/verify`, {
    method: 'POST',
    body: { challenge_id: challenge.body.id, code },
  });
  if (!verify.body?.access_token) {
    if (retriesLeft > 0) {
      // 30s step boundary flicker — one retry with a fresh challenge/code, not a raw resend
      // (a GoTrue TOTP challenge is single-use).
      await new Promise((res) => setTimeout(res, 1000));
      return challengeAndVerify(supabaseUrl, anonKey, aal1Token, factorId, secret, retriesLeft - 1);
    }
    throw new Error(`signInMfa: verify failed for factor ${factorId}: ${verify.status} ${verify.text?.slice(0, 300)}`);
  }
  return { accessToken: verify.body.access_token, refreshToken: verify.body.refresh_token ?? null };
}

/**
 * MFA-capable sign-in for a rig fixture user. Returns an AAL2 access token,
 * enrolling + verifying a TOTP factor on first use (persisted to
 * FIXTURE_STATE under state[stateKey].totpFactorId / .totpSecret so later
 * cycles / processes re-challenge the same factor instead of re-enrolling).
 * A session that is already AAL2 straight out of the password grant (e.g.
 * migration 0451 not yet applied on this rig) is returned as-is — no-op.
 *
 * ctx: { state, SUPABASE_URL, ANON_KEY, admin } (every probe's run(ctx)/seed(ctx)
 * already carries these — `admin` is the service-role client, used only for the
 * stale-factor cleanup fallback below).
 * stateKey: e.g. 'platformAdmin', 'adminA' — the fixture's entry under ctx.state.
 */
export async function signInMfa(ctx, stateKey) {
  const { state, SUPABASE_URL: supabaseUrl, ANON_KEY: anonKey, admin } = ctx;
  const entry = state[stateKey];
  if (!entry?.email || !(entry?.password ?? state.password)) {
    throw new Error(`signInMfa: state.${stateKey} has no email/password — run setup.mjs`);
  }
  const email = entry.email;
  const password = entry.password ?? state.password;

  const grant = await passwordGrant(supabaseUrl, anonKey, email, password);
  if (!grant.accessToken) {
    return { status: grant.status, token: null, error: grant.error, aalBefore: null, aalAfter: null, roleBefore: null, roleAfter: null };
  }
  const before = decodeJwt(grant.accessToken);
  if (before.aal === 'aal2') {
    return { status: grant.status, token: grant.accessToken, error: null, aalBefore: before.aal, aalAfter: before.aal, roleBefore: before.role, roleAfter: before.role };
  }
  const aal1Token = grant.accessToken;
  const userId = entry.userId ?? before.sub ?? null;

  // Reuse a persisted factor if we have one; a verified/unverified factor with
  // no persisted secret is unusable (GoTrue never re-exposes a TOTP secret
  // after enrollment) and is deleted so enrollment can start clean — these
  // are rig fixture users, not real accounts, so churning their own factor is
  // safe and is the only way to make the driver self-healing.
  let factorId = entry.totpFactorId ?? null;
  let secret = entry.totpSecret ?? null;

  if (!factorId || !secret) {
    // GoTrue has no GET /factors — that 405s (Allow: POST only, confirmed
    // empirically 2026-09-13). A user's own current factors are listed on
    // GET /user instead, under the `factors` key.
    const me = await gotrue(supabaseUrl, anonKey, aal1Token, '/user');
    const totpFactors = (me.body?.factors ?? []).filter((f) => f.factor_type === 'totp');
    for (const f of totpFactors) {
      // GoTrue refuses to let an AAL1 session unenroll an already-VERIFIED
      // factor (422 insufficient_aal — confirmed empirically 2026-09-13: "AAL2
      // required to unenroll verified factor"), which is exactly the state a
      // leftover factor from an earlier successful signInMfa run is in once
      // this run's persisted totpFactorId/totpSecret are lost (e.g. a
      // setup.mjs re-run clobbering the shared fixture user — reproduced the
      // same day). The service-role admin API is not subject to that AAL
      // check, so prefer it; fall back to the user's own token only if no
      // admin client or user id is available (best-effort, matches prior
      // behaviour for an unverified factor, which the user's own token CAN
      // remove).
      if (admin && userId) {
        await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
      } else {
        await gotrue(supabaseUrl, anonKey, aal1Token, `/factors/${f.id}`, { method: 'DELETE' });
      }
    }
    // GoTrue's raw REST endpoint wants snake_case (factorType/friendlyName is the
    // supabase-js client's naming, not the wire format — confirmed empirically
    // against rig 1: camelCase 400s with validation_failed).
    const enroll = await gotrue(supabaseUrl, anonKey, aal1Token, '/factors', {
      method: 'POST',
      body: { factor_type: 'totp', friendly_name: 'rig-probe' },
    });
    if (!enroll.body?.id || !enroll.body?.totp?.secret) {
      throw new Error(`signInMfa: enroll failed for ${email}: ${enroll.status} ${enroll.text?.slice(0, 300)}`);
    }
    factorId = enroll.body.id;
    secret = enroll.body.totp.secret;
    entry.totpFactorId = factorId;
    entry.totpSecret = secret;
    persistTotpFactor(stateKey, factorId, secret);
  }

  const { accessToken, refreshToken } = await challengeAndVerify(supabaseUrl, anonKey, aal1Token, factorId, secret);
  const after = decodeJwt(accessToken);
  return {
    status: 200, token: accessToken, refreshToken, error: null,
    aalBefore: before.aal ?? null, roleBefore: before.role ?? null,
    aalAfter: after.aal ?? null, roleAfter: after.role ?? null,
  };
}

/**
 * Refresh path for an AAL2 session obtained via signInMfa: GoTrue's refresh_token
 * grant preserves the session's AAL (it does not step back down to aal1), so a
 * plain refresh suffices — re-challenging is only needed if the refresh itself
 * comes back below aal2 (e.g. the factor was unenrolled server-side mid-soak;
 * see memory/project_gotrue_unenroll_drops_aal_on_refresh.md), in which case we
 * fall through to a full signInMfa() using the persisted factor/secret.
 */
export async function refreshMfaSession(ctx, stateKey, refreshToken) {
  const { state, SUPABASE_URL: supabaseUrl, ANON_KEY: anonKey } = ctx;
  const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const body = await r.json().catch(() => null);
  const token = body?.access_token ?? null;
  if (token && decodeJwt(token).aal === 'aal2') {
    return { status: r.status, token, refreshToken: body?.refresh_token ?? null, error: null };
  }
  // Expired/invalid refresh token, or AAL regressed — full re-auth.
  const result = await signInMfa(ctx, stateKey);
  return { status: result.status, token: result.token, refreshToken: result.refreshToken ?? null, error: result.error };
}
