/**
 * SCRUM-2377 (CE-06a) — fail-closed claims-review gate (CLAUDE.md §1.13 R-7 /
 * §1.5).
 *
 * FACTS WE HOLD: Credential Engine approved Arkova TO PUBLISH to the Registry.
 * FACTS WE DO NOT HOLD: nothing of ours is LISTED in the Registry, and no
 * Arkova proof output is "legally sufficient" for anything.
 *
 * Public output (the CTDL projection, any CE status copy) must therefore never
 * assert Registry-listing status or legal sufficiency. This module is the
 * single source of truth for that phrase set and EXTENDS the existing
 * fail-closed serializer chain (CE-01 publishability gate → CE-02 CTID guard →
 * PII gate → THIS → validator); it is not a parallel gate. Registry publishing
 * itself stays OFF: there is no CE Registry write path in the worker at all —
 * `ctdl-claims-lint.test.ts` asserts no publish endpoint is wired.
 *
 * Where any status copy is needed, the safe default wording is
 * {@link CE_PUBLICATION_STATUS_WORDING} ("approved to publish") — never
 * "listed". The frontend vocabulary (`src/lib/copy.ts`,
 * `CE_PUBLICATION_COPY`) carries the user-visible strings and is scanned by
 * its own lint-style test (`src/lib/copy-claims-gate.test.ts`).
 */

/**
 * Safe default wording for Credential Engine publication status. States
 * exactly what we hold (approval to publish) and nothing we don't (a listing).
 */
export const CE_PUBLICATION_STATUS_WORDING = 'approved to publish' as const;

/**
 * Overclaim phrases that may never ship in public output. Whitespace-tolerant
 * and case-insensitive so "Listed   in the Registry" / "REGISTRY-LISTED" still
 * trip the gate. Two claim families:
 *
 *   1. Registry-listing assertions — external status CE has not granted:
 *      "listed in the Registry", "listed in the Credential Registry",
 *      "Registry-listed" / "registry listed", "in the Credential Registry".
 *      (Arkova's OWN surfaces — "Issuer Registry", "the public credential
 *      registry" — are not CE Registry claims and do not match.)
 *   2. Legal-sufficiency assertions — "legally sufficient" (banned everywhere
 *      per the standing claims-review rule; proof copy states what is measured
 *      vs asserted vs NOT asserted, §1.5).
 *
 * Kept in semantic lockstep with BANNED_OVERCLAIM_PATTERNS in
 * `src/lib/copy-claims-gate.test.ts`.
 */
export const PROHIBITED_CLAIM_PATTERNS: readonly RegExp[] = [
  /listed\s+in\s+the\s+(?:credential\s+)?registry/i,
  /registry[-\s]+listed/i,
  /in\s+the\s+credential\s+registry/i,
  /legally\s+sufficient/i,
];

/**
 * Thrown when a prohibited external-status claim would reach serialized public
 * output. Fail-closed: callers must surface this as a server-side error
 * (HTTP 500 / no body), never as a published body carrying the claim.
 */
export class ProhibitedClaimError extends Error {
  constructor() {
    // Deliberately value-free: never echo the offending (possibly issuer- or
    // import-controlled) text into logs/Sentry/error messages.
    super(
      'Refusing to serialize a prohibited external-status claim (R-7). ' +
        `Credential Engine status is "${CE_PUBLICATION_STATUS_WORDING}" — ` +
        'nothing is listed in any registry and no output is a legal-sufficiency assertion.',
    );
    this.name = 'ProhibitedClaimError';
  }
}

/** True when the text carries any prohibited overclaim phrase. */
export function containsProhibitedClaim(value: string): boolean {
  return PROHIBITED_CLAIM_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Defense-in-depth: recursively scan an already-built JSON-LD body and throw
 * {@link ProhibitedClaimError} if ANY string value carries a prohibited claim.
 * The serializer suppresses overclaim-bearing issuer free text at the source
 * (honest omission, same treatment as PII); this is the belt-and-suspenders
 * check on the final object so no field — now or from a future code path —
 * can ship the claim. Mirrors `assertNoFabricatedCtidInJsonLd` (CE-02).
 */
export function assertNoProhibitedClaimInJsonLd(value: unknown, depth = 0): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (containsProhibitedClaim(value)) throw new ProhibitedClaimError();
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoProhibitedClaimInJsonLd(item, depth + 1);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertNoProhibitedClaimInJsonLd(child, depth + 1);
  }
}
