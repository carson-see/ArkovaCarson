/**
 * Dependency-free RFC 6238 TOTP (SHA-1, 6 or 8 digits, 30s step).
 *
 * Ported from the CTO session's proven scratchpad helper (`totp.mjs`) —
 * verified against the RFC 6238 Appendix B SHA-1 test vector before this
 * port (T=59 -> "287082" / 6 digits, "94287082" / 8 digits;
 * T=1111111109 -> "07081804" / 8 digits). Those same assertions run as a
 * Playwright `test.describe('totp helper')` block in
 * `e2e/mfa-enrollment-and-challenge.spec.ts` — `e2e/` is not in the vitest
 * `include` globs (see `vitest.config.ts`), so Playwright is the runner that
 * actually exercises this file.
 *
 * NO new npm dependency — only Node's built-in `node:crypto`. Used to derive
 * a real 6-digit code from the manual-entry secret Supabase's
 * `mfa.enroll()` returns, so an E2E spec can complete a TOTP challenge
 * without a headless authenticator app.
 */

import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Strip trailing `=` padding characters without a regex quantifier at the
 * end of the string (SonarCloud typescript:S8786 — `/=+$/` was flagged for
 * potential super-linear backtracking). A plain backward scan has no
 * backtracking at all, and is O(n) in the number of trailing `=` chars.
 */
function stripTrailingBase32Padding(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '=') {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Decode an RFC 4648 base32 string (case-insensitive, padding optional) to raw bytes. */
export function base32Decode(input: string): Buffer {
  const clean = stripTrailingBase32Padding(input.toUpperCase()).replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

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

export interface TotpOptions {
  /** Epoch milliseconds to derive the code for. Defaults to `Date.now()`. */
  now?: number;
  /** Time-step size in seconds. Defaults to 30 (the Supabase/GoTrue default). */
  step?: number;
  /** Code length. Defaults to 6 (the Supabase/GoTrue default). */
  digits?: number;
}

/** Compute an RFC 6238 TOTP code for a base32-encoded secret. */
export function totp(secretBase32: string, options: TotpOptions = {}): string {
  const { now = Date.now(), step = 30, digits = 6 } = options;
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
