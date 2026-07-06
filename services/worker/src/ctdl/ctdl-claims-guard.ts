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
 * itself stays OFF: no CE Registry write path exists in this repo's TS
 * sources — `ctdl-claims-lint.test.ts` asserts no publish endpoint is wired
 * across worker src/ + scripts/ and the edge worker src/ (see that test for
 * the honest scope statement of what the scan can and cannot reach).
 *
 * Where any status copy is needed, the safe default wording is
 * {@link CE_PUBLICATION_STATUS_WORDING} ("approved to publish") — never
 * "listed". The frontend vocabulary (`src/lib/copy.ts`,
 * `CE_PUBLICATION_COPY`) carries the user-visible strings and is scanned by
 * its own lint-style test (`src/lib/copy-claims-gate.test.ts`), which imports
 * {@link PROHIBITED_CLAIM_PATTERNS} from THIS module (single shared source —
 * the two halves cannot drift).
 */

/**
 * Safe default wording for Credential Engine publication status. States
 * exactly what we hold (approval to publish) and nothing we don't (a listing).
 */
export const CE_PUBLICATION_STATUS_WORDING = 'approved to publish' as const;

/**
 * The optional Registry qualifier: "the CE Registry", "the Credential
 * Registry", "the Credential Engine Registry", "Credential Engine's Registry".
 * Shared by the listing/publication pattern families below so a qualifier
 * variant can never bypass one family while tripping another.
 */
const REGISTRY_QUALIFIER = String.raw`(?:the\s+)?(?:ce\s+|credential\s+(?:engine(?:'s)?\s+)?)?registry`;

/**
 * Overclaim phrases that may never ship in public output. Whitespace-tolerant
 * and case-insensitive so "Listed   in the Registry" / "REGISTRY-LISTED" still
 * trip the gate. Pattern FAMILIES (round-1 review finding 1 — literal phrases
 * alone let "listed in the CE Registry" / "published in the Registry" /
 * "listed with Credential Engine" / "live in the Registry" through):
 *
 *   1. Registry-listing assertions — external status CE has not granted:
 *      "listed in/on/with the (CE|Credential|Credential Engine('s)) Registry",
 *      "Registry-listed" / "registry listed", "listed with Credential Engine",
 *      "in the Credential Registry".
 *      (Arkova's OWN surfaces — "Issuer Registry", "the public credential
 *      registry" — are not CE Registry claims and do not match.)
 *   2. Registry-publication status assertions — "published/live/appears
 *      in/on the Registry" ("approved to publish" / "publishing to the
 *      Registry is not enabled" remain honest and do not match).
 *   3. Legal-sufficiency assertions — "legally sufficient" (banned everywhere
 *      per the standing claims-review rule; proof copy states what is measured
 *      vs asserted vs NOT asserted, §1.5).
 *
 * SINGLE SHARED SOURCE: `src/lib/copy-claims-gate.test.ts` imports this exact
 * array — the UI-copy lint and this runtime gate cannot drift. Keep this
 * module dependency-free so the frontend test runner can import it.
 */
export const PROHIBITED_CLAIM_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`listed\s+(?:in|on|with)\s+${REGISTRY_QUALIFIER}`, 'i'),
  /registry[-\s]+listed/i,
  new RegExp(String.raw`(?:published|live|appears?)\s+(?:in|on)\s+${REGISTRY_QUALIFIER}`, 'i'),
  /listed\s+with\s+credential\s+engine/i,
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
 * Recursion budget for the defense-in-depth body scans. Real CTDL bodies are
 * ~4 levels deep; anything deeper is not something the serializer can produce.
 */
const MAX_JSONLD_SCAN_DEPTH = 12;

/**
 * Defense-in-depth: recursively scan an already-built JSON-LD body and throw
 * {@link ProhibitedClaimError} if ANY string value carries a prohibited claim.
 * The serializer suppresses overclaim-bearing issuer free text at the source
 * (honest omission, same treatment as PII); this is the belt-and-suspenders
 * check on the final object so no field — now or from a future code path —
 * can ship the claim. Mirrors `assertNoFabricatedCtidInJsonLd` (CE-02).
 *
 * FAIL CLOSED on depth (round-1 review finding 3): exceeding the recursion
 * budget THROWS instead of silently returning — a body too deep to scan is a
 * body we refuse to publish, never one that ships unscanned.
 */
export function assertNoProhibitedClaimInJsonLd(value: unknown, depth = 0): void {
  if (value === null || value === undefined) return;
  if (depth > MAX_JSONLD_SCAN_DEPTH) {
    // Value-free by construction: reports the budget, never the content.
    throw new Error(
      `CTDL claims scan exceeded its depth budget of ${MAX_JSONLD_SCAN_DEPTH} — ` +
        'refusing to serialize an unscannable body (fail closed, R-7).',
    );
  }
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
