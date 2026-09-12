// Shared helpers for the CTO 0912 targeted soak drivers (PR #2832 / #2831).
// Self-contained on purpose (no cross-repo relative imports) so these scripts
// stay usable if the repo checkout moves; only @supabase/supabase-js is an
// external dependency (already installed at repo root).
import { createHmac } from 'node:crypto';

export const RIG_REF = 'fizyjojbebyalirtjjht';
export const SUPABASE_URL = 'https://fizyjojbebyalirtjjht.supabase.co';
export const SERVICE = 'arkova-worker-staging';
export const REGION = 'us-central1';
export const CANDIDATE_SHA = '133474d30653bce3bdb285c87b4877638bd9a6b6';
export const TAG_URL = 'https://arkova-worker-staging-kvojbeutfa-uc.a.run.app';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function stripPad(v) {
  let end = v.length;
  while (end > 0 && v[end - 1] === '=') end -= 1;
  return v.slice(0, end);
}

export function base32Decode(input) {
  const clean = stripPad(input.toUpperCase()).replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Dependency-free RFC 6238 TOTP (SHA-1, 6 digits, 30s step) — ported from the
// same proven implementation as e2e/helpers/totp.ts (verified against the
// RFC 6238 Appendix B test vectors there); duplicated here so this soak
// tooling has no cross-directory import onto the app's e2e helpers.
export function totp(secretBase32, { now = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(now / 1000 / step);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binaryCode =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  const code = binaryCode % 10 ** digits;
  return String(code).padStart(digits, '0');
}

// Nudge forward one step if within 3s of a boundary, same rationale as
// e2e/helpers/mfa.ts's computeTotpAvoidingBoundary — avoids a code going
// stale mid-request against real GoTrue.
export function totpNow(secret) {
  const STEP_MS = 30_000;
  const now = Date.now();
  const msIntoStep = now % STEP_MS;
  const effectiveNow = STEP_MS - msIntoStep < 3_000 ? now + STEP_MS : now;
  return totp(secret, { now: effectiveNow });
}

export function hashApiKey(rawKey, hmacSecret) {
  return createHmac('sha256', hmacSecret).update(rawKey).digest('hex');
}

export async function getIamToken() {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('gcloud', ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim();
}

export async function fireJson(url, opts = {}) {
  const started = Date.now();
  let status = 0, body = null, ok = false, transportError = null;
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
    status = res.status;
    const raw = await res.text();
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw.slice(0, 500); }
    ok = true;
  } catch (err) {
    transportError = err instanceof Error ? err.message : String(err);
  }
  return { status, body, latencyMs: Date.now() - started, transportError, ok };
}

export function probe(name, expected, observedStatus, extra = {}) {
  const expectedArr = Array.isArray(expected) ? expected : [expected];
  return {
    name,
    expected: expectedArr,
    observed: observedStatus,
    pass: expectedArr.includes(observedStatus),
    ...extra,
  };
}
