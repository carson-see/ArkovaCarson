/**
 * SCRUM-2293 / SCRUM-2299 / SCRUM-2300 — outbound CTDL/Registry value-level PII
 * scrub gate (CLAUDE.md §1.4, §1.6).
 *
 * WHY THIS MODULE EXISTS: `GET /api/v1/credentials/:publicId/ctdl` is PUBLIC and
 * UNAUTHENTICATED, and `ctdl-validation.ts` `UNSAFE_PUBLIC_KEYS` is a key-NAME
 * denylist — it never inspects VALUES. Credential Engine's Registry is
 * explicitly PII-free (Jeanne Kitchens, 2026-06-02), so no learner identity may
 * reach CTDL output or any future Registry publish path.
 *
 * VERIFIED LIVE 2026-08-01 (prod `git_sha 8e6a804e2`, `GET
 * https://api.arkova.ai/v1/credentials/<id>/ctdl`): a `credential_type =
 * 'TRANSCRIPT'` anchor served a person's full name in `ceterms:name` and
 * `ceterms:description`.
 *
 * ── THE DESIGN DECISION THAT MATTERS ──────────────────────────────────────
 *
 * You cannot reliably detect a bare personal name in free text with regex
 * heuristics, and attempting it is actively harmful. A first cut of this module
 * tried: "a capitalised pair counts as a person when introduced by a relational
 * trigger (for/to/by/with) and not vetoed by an institutional word list."
 * Measured against real inputs, that design failed in BOTH directions at once:
 *
 *   - It 404'd 28 of 32 real institution names ("Issued by Johns Hopkins",
 *     "Issued by Red Hat") and 13 of 18 ordinary credential titles
 *     ("Introduction to Machine Learning"), because a finite word list cannot
 *     veto an open class (proper nouns).
 *   - It STILL missed the common leak shapes: a bare name as the whole field
 *     ("Jane Doe"), record-noun-first order ("Transcript: Jane Doe"), all-caps
 *     names ("MARIA GONZALEZ"), and any non-ASCII name ("José García"), because
 *     `[A-Z][a-z]+` cannot express them.
 *
 * So this module does NOT try to find names. For ACADEMIC-RECORD credential
 * types it takes the only decision that is sound without an NER model — the one
 * SCRUM-2293's own acceptance criterion states ("if NER unavailable /
 * low-confidence, SUPPRESS THE FIELD rather than emit it"):
 *
 *   **An academic record never emits issuer- or extraction-authored free text.**
 *
 * `ceterms:name` comes from CONTROLLED VOCABULARY (derived from the resolved
 * CTDL `@type`), and `ceterms:description` / `ceterms:revocationReason` are
 * omitted. That is precision-independent: no heuristic decides whether a real
 * credential publishes, and no name shape — capitalisation, alphabet,
 * punctuation, or position — can leak, because the text is never in the body.
 * It also cannot take a credential offline: academic records still publish,
 * with a truthful structural name.
 *
 * What remains detector-based is only what regex is genuinely good at:
 * FORMAT-ANCHORED and KEYWORD-ANCHORED values (email, phone, SSN, date of
 * birth, student ID). Those run on every credential type.
 *
 * This module is the single source of truth for outbound PII detection and
 * EXTENDS the existing fail-closed serializer chain (CE-01 publishability →
 * CE-02 CTID guard → THIS PII gate → CE-06a claims gate → validator).
 *
 * Keep this module dependency-free so any future Registry publish path — and
 * the frontend test runner — can import it without dragging in the serializer.
 */

/**
 * Thrown when PII would reach serialized public output. Fail-closed: callers
 * must surface this as "no body" (the CTDL route returns 404 with audit outcome
 * `safety_blocked`), never as a published body carrying the value.
 *
 * Defined here rather than in `ctdl-serializer.ts` so the guard has no import
 * back-edge; the serializer re-exports it, so existing `instanceof` checks and
 * import sites are unchanged.
 */
export class CtdlPiiSafetyError extends Error {
  constructor(message = 'CTDL PII safety gate blocked public serialization') {
    // Deliberately value-free: never echo the offending (issuer- or
    // extraction-controlled) text into logs, Sentry, or error messages.
    super(message);
    this.name = 'CtdlPiiSafetyError';
  }
}

/**
 * Credential types that are ACADEMIC RECORDS about an identified learner. These
 * never emit issuer/extraction free text on the public projection (see the
 * design note above).
 *
 * `CPE`/`CLE` are deliberately EXCLUDED: continuing professional education is a
 * practitioner record, not a FERPA academic record, and the descriptive title
 * plus the CE ContactHour projection are the partner-facing value of those
 * types. They keep field-level suppression and the assembled-body scan.
 *
 * CE Registry snapshot anchors (`credentials-ctdl-registry-anchor.ts`) are
 * created as `OTHER`, so they are outside this set by construction — correct,
 * since their content is already-public CE Registry data, not a learner record.
 *
 * Every ADDITION to this set silently replaces real credential titles with
 * generic ones — widen only with a documented privacy reason.
 */
export const EDUCATION_CREDENTIAL_TYPES: ReadonlySet<string> = new Set([
  'DEGREE',
  'CERTIFICATE',
  'TRANSCRIPT',
]);

export function isEducationCredentialType(credentialType: string | null | undefined): boolean {
  return typeof credentialType === 'string'
    && EDUCATION_CREDENTIAL_TYPES.has(credentialType.toUpperCase());
}

/**
 * SCRUM-3102 — the predicate the SERIALIZER must use, which FAILS CLOSED on an
 * absent credential type.
 *
 * `isEducationCredentialType` answers "is this one of the three academic types",
 * and for `null` the honest answer is false. But the serializer is not asking
 * that — it is asking "may this record emit issuer-authored free text", and for
 * an anchor with NO type the safe answer is NO. Routing the serializer through
 * `isEducationCredentialType` made an untyped anchor take the PERMISSIVE branch:
 * measured in prod 2026-08-02, 24 of the 59 `credential_type IS NULL` anchors
 * (41%) carry a learner-name-shaped filename, the densest such pocket in a
 * 3.36M-row corpus.
 *
 * This mirrors the contract's own `structural_keys` principle — "recognising
 * danger fails open; recognising safety fails closed". The academic set
 * recognises SAFETY by enumeration, so anything outside the enumeration that we
 * cannot positively classify must be suppressed, not waved through.
 *
 * A PRESENT but non-academic type (`OTHER`, `CPE`, `CLE`, …) still publishes:
 * `credential_type` is an enum column, so a non-empty value is always a known
 * type, and blanking those would destroy the partner-facing descriptive title.
 */
export function suppressesRecordFreeText(credentialType: string | null | undefined): boolean {
  if (typeof credentialType !== 'string' || credentialType.trim() === '') return true;
  return EDUCATION_CREDENTIAL_TYPES.has(credentialType.toUpperCase());
}

/**
 * Upper bound on the characters any detector will scan.
 *
 * Detectors run on RAW database text at some call sites (e.g.
 * `canonicalizeResourceAvailableUntil` passes an untruncated metadata value),
 * and this endpoint is public and unauthenticated on a single-threaded runtime.
 * A hard cap keeps every scan bounded in the size of attacker-influenced input.
 * Anything a legitimate credential asserts publicly is far inside this bound —
 * the emitted fields themselves cap at 240/500 characters.
 */
export const MAX_SCAN_CHARS = 4000;

/**
 * Upper bound on an emitted public URL, matching the shared contract's
 * `max_public_url_chars`. Overflow DROPS the field (see
 * {@link stripUrlQueryAndFragment}) rather than truncating it.
 */
export const MAX_PUBLIC_URL_CHARS = 2048;

/**
 * C0 controls plus DEL. Stripped so a NUL cannot split a value out from under a
 * detector.
 *
 * `no-control-regex` is disabled deliberately: matching control characters is
 * the entire purpose of this pattern. The escaped form is also load-bearing —
 * writing the bytes literally would make every file containing them binary to
 * git, which is exactly the defect this PR fixed in its own test file.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

/**
 * The one definition of "public-safe text shape" for this surface: strip
 * control characters, collapse whitespace runs, trim, and bound the length.
 *
 * `ctdl-serializer.ts` `cleanPublicString` delegates here, so the serializer's
 * notion of a control character and the detectors' can never drift — they used
 * to be two hand-rolled copies that already disagreed about ordering.
 */
export function normalizePublicText(value: string, maxChars = MAX_SCAN_CHARS): string {
  const bounded = value.length > maxChars ? value.slice(0, maxChars) : value;
  return bounded.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// High-confidence detectors — format- or keyword-anchored, so they are precise
// enough to gate on. These run for EVERY credential type.
//
// Every pattern below uses BOUNDED separator classes (`[\s:#-]{0,4}`) rather
// than the `\s*X?\s*` shape, which enumerates O(n²) splits of a whitespace run
// before failing.
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

/**
 * SSN requires REAL SEPARATORS, or an explicit keyword.
 *
 * The bare-9-digit form (optional separators) matches any bounded 9-digit run —
 * a campaign id, an order number, a numeric path segment in an issuer's website
 * URL. On a fail-closed gate that turns an ordinary tracking parameter into a
 * 404 for every credential the org owns, so the separators are mandatory here
 * and the keyword form covers the unseparated case.
 */
const SSN_SEPARATED_PATTERN = /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/;
const SSN_KEYWORD_PATTERN =
  /\b(?:ssn|social\ssecurity(?:\s(?:no|number|#))?)\b[\s:#-]{0,4}\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/i;

const US_PHONE_PATTERN =
  /(?:\+1\d{10}|\(\d{3}\)\s?\d{3}[-.]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/;

/**
 * International numbers as humans actually write them ("+44 20 7946 0958").
 * The regex only proposes a candidate; the digit count is checked in code, so a
 * short false match like "+1 2026-03-27" (9 digits) is rejected without an
 * unreadable pattern.
 */
const INTL_PHONE_CANDIDATE = /\+\d{1,3}(?:[\s.-]\d{1,5}){2,5}/g;
/**
 * The COMPACT form, with no separators at all (`+442079460958`) — how a number
 * is written when copied from a `tel:` link or a contact page.
 *
 * The separated candidate above cannot match it (it requires at least two
 * separator groups), and `US_PHONE_PATTERN` only covers the compact case for
 * `+1`. The serializer pattern this module replaced carried
 * `\+(?:[2-9]\d)\d{7,11}`, which DID match it, so omitting this was a silent
 * detection regression for every non-US number.
 *
 * Bounded {10,15} to E.164 and `\b`-terminated, so a longer digit run (not a
 * valid phone number) does not match at any backtrack position.
 */
const INTL_PHONE_COMPACT = /\+\d{10,15}\b/;
const MIN_E164_DIGITS = 10;
const MAX_E164_DIGITS = 15;

function containsInternationalPhone(value: string): boolean {
  if (INTL_PHONE_COMPACT.test(value)) return true;
  for (const match of value.matchAll(INTL_PHONE_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, '').length;
    if (digits >= MIN_E164_DIGITS && digits <= MAX_E164_DIGITS) return true;
  }
  return false;
}

const MONTH_NAME = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,9}`;
/**
 * A date in any shape an extractor realistically emits, plus a bare 4-digit
 * year. Only ever used KEYWORD-ADJACENT — a bare date is far too common in
 * credential copy ("Academic year 2024-2025", "Issued 2026-03-27") to treat as
 * PII on its own.
 */
const ANY_DATE = String.raw`(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|${MONTH_NAME}\s\d{1,2},?\s\d{4}|\d{1,2}\s${MONTH_NAME}\s\d{4}|\d{4})`;

/** SCRUM-2299 — date of birth, abbreviated or spelled out. */
const DOB_PATTERN = new RegExp(
  String.raw`(?:\bd\.?\s?o\.?\s?b\.?|\bdate\sof\sbirth\b|\bbirth\s?date\b|\bbirthdate\b|\bborn(?:\son)?\b)[\s:–—-]{0,4}${ANY_DATE}`,
  'i',
);

/**
 * SCRUM-2299 — student / learner / enrollment identifiers. Keyword-anchored and
 * digit-bearing (>= 4 digits) so a bare word like "Student" or a course code
 * ("PHIL 2020") can never trip it.
 */
const STUDENT_ID_PATTERN =
  /\b(?:(?:student|learner|enroll?ment|matriculation|candidate|registrant|pupil)\s?(?:id|i\.d\.|no\.?|number|#)|s\.?i\.?d\.?)\b[\s:#–—-]{0,4}[A-Za-z]{0,4}-?\d{4,}/i;

const HIGH_CONFIDENCE_PATTERNS: readonly RegExp[] = [
  EMAIL_PATTERN,
  SSN_SEPARATED_PATTERN,
  SSN_KEYWORD_PATTERN,
  US_PHONE_PATTERN,
  DOB_PATTERN,
  STUDENT_ID_PATTERN,
];

/**
 * True when the text carries unambiguous PII: email, phone, SSN, a
 * keyword-anchored date of birth, or a keyword-anchored student/learner ID.
 */
export function containsHighConfidencePii(value: string): boolean {
  const text = normalizePublicText(value);
  if (!text) return false;
  return HIGH_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(text))
    || containsInternationalPhone(text);
}

// ---------------------------------------------------------------------------
// Learner-name heuristics — SUPPRESSION ONLY, never a gate.
//
// These are the two narrow patterns that shipped before this module existed.
// They are kept VERBATIM and used ONLY to drop a free-text field (an honest
// omission), never to fail a build or 404 a credential. They are best-effort by
// construction — see the design note at the top for why a broader heuristic was
// tried, measured, and rejected. The real protection for learner names is the
// structural one: academic records emit no free text at all.
//
// Do not widen these into a gate. Do not add bare prepositions as triggers.
// ---------------------------------------------------------------------------

const NAME_TOKEN = String.raw`[A-Z][a-z]{1,}`;
const OPTIONAL_MIDDLE = String.raw`(?:\s(?:[A-Z]\.?|${NAME_TOKEN}))?`;
const FULL_NAME = String.raw`${NAME_TOKEN}${OPTIONAL_MIDDLE}\s${NAME_TOKEN}`;
/**
 * SCRUM-3102 — `for` was REMOVED as a trigger, and the generic credential nouns
 * (`certificate`, `credential`, `degree`) were removed from the name-first
 * pattern. Both changes delete measured FALSE POSITIVES that were erasing real
 * issuer and course names from the public projection.
 *
 * `for` is a bare preposition, so it collides with ordinary organisation names.
 * Every one of these is pinned in the shared contract's `must_publish_vectors`
 * and every one was being dropped: "Society for Human Resource Management",
 * "Institute for Supply Management", "Center for Professional Development",
 * "Alliance for Continuing Education", "Ethics for Trial Lawyers", "Credit for
 * Prior Learning", "Revoked for Non Payment". The generic nouns did the same to
 * "Data Science degree" and "Project Management certificate".
 *
 * That was not a cosmetic loss. Suppression here is not an omission of one
 * optional property: `cleanPublicFreeText` returning null makes `issuerName`
 * and `credentialName` fall through EVERY metadata fallback (they all route
 * through the same cleaner) to the literal placeholders "Arkova verified issuer"
 * and "Arkova credential <publicId>" — so an issuer named "Society for Human
 * Resource Management" published with its identity erased.
 *
 * What remains are RELATIONAL triggers that do not collide with institution
 * names, and record nouns that are not ordinary credential titles. This costs
 * one shape the old pattern caught ("Official transcript for Jane Q Student",
 * noun-before-name). That shape is academic by construction, and academic
 * records emit no issuer-authored free text at all — the structural rule, which
 * is precision-independent, already covers it.
 *
 * Do not re-add `for`, or any other bare preposition, as a trigger.
 */
const CONTEXTUAL_LEARNER_NAME_PATTERN = new RegExp(
  String.raw`\b(?:learner|student|recipient|issued to|awarded to|completed by|earned by|held by)\s${FULL_NAME}\b`,
);
const NAME_FIRST_LEARNER_PATTERN = new RegExp(
  String.raw`\b${FULL_NAME}(?:'s)?\s(?:transcript|student record|learner record|completion)\b`,
);

/**
 * Best-effort learner-name signal for FIELD SUPPRESSION on non-academic
 * credential types. Never call this to decide whether a credential publishes.
 */
export function containsLearnerNamePii(value: string): boolean {
  const text = normalizePublicText(value);
  return CONTEXTUAL_LEARNER_NAME_PATTERN.test(text) || NAME_FIRST_LEARNER_PATTERN.test(text);
}

/**
 * The single field-suppression predicate: does this free text carry anything
 * that must not ship on the public projection?
 *
 * One entry point so a caller cannot forget half the check, and so the value is
 * normalized ONCE rather than once per detector family.
 */
export function containsOutboundFreeTextPii(value: string): boolean {
  const text = normalizePublicText(value);
  if (!text) return false;
  return HIGH_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(text))
    || containsInternationalPhone(text)
    || CONTEXTUAL_LEARNER_NAME_PATTERN.test(text)
    || NAME_FIRST_LEARNER_PATTERN.test(text);
}

// ---------------------------------------------------------------------------
// Assembled-body scan (defense in depth).
// ---------------------------------------------------------------------------

/**
 * Recursion budget, matching `ctdl-claims-guard.ts`. Real CTDL bodies are ~4
 * levels deep; anything deeper is not something the serializer can produce.
 */
const MAX_JSONLD_SCAN_DEPTH = 12;

/**
 * Recursively scan an ALREADY-BUILT JSON-LD body and throw
 * {@link CtdlPiiSafetyError} if any string value carries high-confidence PII.
 *
 * Field-level suppression is the first line of defence; this is the
 * belt-and-suspenders check on the final object, so a value reaching the body
 * by ANY other route — a field that never routed through the free-text cleaner,
 * or a future code path — can never ship.
 *
 * ONLY the high-confidence (format/keyword-anchored) detectors run here. The
 * name heuristics deliberately do NOT, because this scan fails CLOSED for every
 * credential type: a heuristic false positive here would take a legitimate
 * credential offline with no operator recourse.
 *
 * FAILS CLOSED on depth, mirroring the CE-02 CTID scan and the CE-06a claims
 * scan: a body too deep to scan is refused, never published unscanned.
 */
export function assertNoPiiInJsonLd(value: unknown, depth = 0): void {
  if (value === null || value === undefined) return;
  if (depth > MAX_JSONLD_SCAN_DEPTH) {
    // Value-free by construction: reports the budget, never the content.
    throw new CtdlPiiSafetyError(
      `CTDL PII scan exceeded its depth budget of ${MAX_JSONLD_SCAN_DEPTH} — ` +
        'refusing to serialize an unscannable body (fail closed).',
    );
  }
  if (typeof value === 'string') {
    if (containsHighConfidencePii(value)) throw new CtdlPiiSafetyError();
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoPiiInJsonLd(item, depth + 1);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertNoPiiInJsonLd(child, depth + 1);
  }
}

/**
 * Reduce a public URL to scheme + host + path, dropping the query string,
 * fragment, and userinfo.
 *
 * Structural, not heuristic: those three components are where identifiers and
 * bearer material ride into an otherwise innocuous field
 * (`https://jane@example.edu/x?student=jane@example.edu#ref`), and
 * `ceterms:subjectWebpage` is hygiene-cleaned only. Dropping them removes the
 * carrier instead of trying to recognise every payload, and an issuer's public
 * homepage never needs any of the three to resolve.
 *
 * Takes and returns a string rather than mutating a caller's `URL` — the
 * previous in-place form was a side effect the name did not advertise.
 *
 * NOTE: `lib/credential-evidence.ts` `normalizeCredentialSourceUrl` does a
 * related but DIFFERENT job — it preserves non-tracking query parameters,
 * because an evidence source URL must still resolve to the exact document.
 * Here the query is precisely what must go, so the two are deliberately not
 * merged.
 */
export function stripUrlQueryAndFragment(rawUrl: string): string | null {
  // SCRUM-3102 — DROP on overflow, never truncate. The caller cleans with a
  // length budget sized for prose, and a truncated URL still PARSES, so it
  // publishes as a valid-looking WRONG link that the consumer renders as a live
  // anchor — strictly worse than omitting the field. Migration 0385's
  // `public_url_or_null` already drops for exactly this reason; this keeps the
  // two public projections honest about the same value.
  if (rawUrl.length > MAX_PUBLIC_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}
