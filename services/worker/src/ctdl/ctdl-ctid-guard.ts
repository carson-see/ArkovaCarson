/**
 * SCRUM-2373 (CE-02) — fail-closed CTID guard: NO FABRICATED CTIDs.
 *
 * A Credential Engine CTID is a globally-unique identifier the Registry mints
 * for a published resource. Arkova MUST NOT invent one. The only honest states
 * for `ceterms:ctid` in our public CTDL projection are:
 *
 *   1. a REAL CE CTID (`ce-` + a v4-style UUID), present only when source
 *      authority actually supports it, or
 *   2. ABSENT (the optional field is omitted entirely).
 *
 * A synthesized placeholder — `ce-<arkova-public-id>`, `urn:ctid:...`,
 * `ce-xxxx`, an empty string, etc. — is fabricated. Earlier code merely *dropped*
 * a non-matching value silently; this guard upgrades that to a hard, typed throw
 * so a fabricated CTID can never slip into serialized output and so a regression
 * fails loudly (and a test can assert it). This also keeps launch output from
 * implying Registry publishing before CE approval (CLAUDE.md §1.13 R-7 / §1.5).
 */

/**
 * Canonical real-CTID shape: `ce-` followed by a v4-style UUID
 * (8-4-4-4-12 lowercase/uppercase hex). Kept in lockstep with the patterns in
 * `ctdl-serializer.ts` and `ctdl-validation.ts`.
 */
export const REAL_CTID_PATTERN =
  /^ce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a CTID would be attached — used only for safe, value-free messages. */
export type CtidSubject = 'credential' | 'issuer';

/**
 * Thrown when a value that is NOT a real CE CTID and is NOT cleanly absent would
 * reach serialized CTDL output. Fail-closed: callers must surface this as a
 * server-side error (HTTP 500 / no body), never as a published credential.
 */
export class FabricatedCtidError extends Error {
  readonly subject: CtidSubject;
  constructor(subject: CtidSubject) {
    // Deliberately value-free: never echo the offending (possibly attacker- or
    // import-controlled) CTID string into logs/Sentry/error text.
    super(
      `Refusing to serialize a fabricated ${subject} CTID. ` +
        'Only a real Credential Engine CTID (ce-<uuid>) or an absent CTID is allowed.',
    );
    this.name = 'FabricatedCtidError';
    this.subject = subject;
  }
}

function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True only for a real CE CTID. Empty/absent/non-string/placeholder → false. */
export function isRealCtid(value: unknown): boolean {
  const candidate = normalize(value);
  return candidate !== null && REAL_CTID_PATTERN.test(candidate);
}

/**
 * Validate a single inbound CTID candidate for a credential or its issuer.
 *
 * - real CE CTID            → returns the trimmed canonical value (emit it)
 * - cleanly absent          → returns `undefined` (omit the field — honest)
 * - anything else (fake)    → THROWS {@link FabricatedCtidError} (fail closed)
 */
export function assertRealCtidOrAbsent(value: unknown, subject: CtidSubject): string | undefined {
  const candidate = normalize(value);
  if (candidate === null) return undefined; // honest absence
  if (REAL_CTID_PATTERN.test(candidate)) return candidate; // real CTID
  throw new FabricatedCtidError(subject); // fabricated — block
}

const CTID_KEY = 'ceterms:ctid';

/**
 * Defense-in-depth: recursively scan an already-built CTDL JSON-LD body and
 * throw if ANY `ceterms:ctid` key holds a value that is not a real CE CTID
 * (including an empty string). The serializer assembles the body field-by-field
 * with {@link assertRealCtidOrAbsent}; this is the belt-and-suspenders check on
 * the final object so no future code path can attach a `ceterms:ctid` that
 * bypasses the per-field guard.
 */
export function assertNoFabricatedCtidInJsonLd(value: unknown, depth = 0): void {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoFabricatedCtidInJsonLd(item, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (key === CTID_KEY && !isRealCtid(child)) {
      // A present ceterms:ctid key MUST be a real CTID. Absent is fine (the key
      // simply would not exist), but a present-yet-fake/empty value is blocked.
      throw new FabricatedCtidError('credential');
    }
    assertNoFabricatedCtidInJsonLd(child, depth + 1);
  }
}
