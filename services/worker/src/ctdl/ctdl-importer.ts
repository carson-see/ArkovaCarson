/**
 * CTDL JSON-LD importer / parser (SCRUM-2913 + SCRUM-2599).
 *
 * The inverse of `ctdl-serializer.ts`: that module emits public CTDL JSON-LD
 * FROM Arkova anchors; this module reads a CTDL JSON-LD document (e.g. fetched
 * from the Credential Engine Registry or a partner CTID lookup) INTO a bounded,
 * internal `ImportedCtdlRecord`. It never emits anything public and never
 * touches the anchor lifecycle — it is a read/parse boundary.
 *
 * READ-ONLY vs the CE Registry (CE-06a / R-7): this module is strictly a
 * CONSUMER of CTDL documents. It carries the CE Registry host only as the
 * default `registryBaseUrl` used to build a read-only provenance link
 * (`registryUrl`) back to the resource a caller already fetched. It issues no
 * Registry calls of its own and **never writes to the Registry** — no publish,
 * no envelope, no write path. It is therefore an allow-listed read-only
 * reference in `ctdl-claims-lint.test.ts`, and remains fully subject to that
 * test's WRITE-shaped markers.
 *
 * Design notes:
 *  - Pure + testable. The SCRUM-2599 expiration-vs-status reconciliation takes an
 *    injected `now` (a `Date`); this module NEVER calls `Date.now()`/`new Date()`
 *    with no argument, so the reconciliation is deterministic under test.
 *  - Fail-soft on shape. A CTDL document from a third party is untrusted input:
 *    missing/optional fields resolve to `null` (never a throw). Only a
 *    structurally impossible node (a non-object where a node is required) raises
 *    `CtdlImportError`. Every returned record is validated with Zod (repo
 *    convention — every parse path) before it leaves this module.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export type ImportedCredentialStatus = 'active' | 'expired' | 'inactive' | 'unknown';

/** Bounded issuer reference lifted from `ceterms:ownedBy`. */
export interface ImportedCtdlIssuer {
  /** The org's `@id` URI, if present. */
  id: string | null;
  /** A real CE CTID, taken from `ceterms:ctid` or extracted from the `@id` URI. */
  ctid: string | null;
  /** Resolved org name (language-map aware), if present. */
  name: string | null;
}

/**
 * The internal record a single CTDL credential node maps to.
 *
 * DOWNSTREAM METADATA MAPPING (SCRUM-2913 — for the eventual consumer, NOT done
 * here): a consumer that persists these into `anchors.metadata` MUST use the
 * snake_case keys the `get_public_anchor` 0355 allow-list projects — the
 * projection DROPS any non-allow-listed key. Intended mapping:
 *   - `registryUrl`                        → `registry_url`
 *   - `sourceUrl`                          → `source_url`   (REUSE the existing
 *                                            allow-listed key — do NOT invent a
 *                                            second camelCase key)
 *   - `retrievedAt`                        → `retrieved_at`
 *   - `ceEnvelopeSha256`             → `ce_envelope_sha256`
 *   - `ceEnvelopeSignatureVerified`  → `ce_envelope_signature_verified`
 *
 * Surfacing `registry_url` PUBLICLY is out of scope for this PR: it requires a
 * deliberate S2/T3 allow-list migration (Lane 2) + the SCRUM-2485 snapshot test
 * + `#`/`?` stripping + a single-writer-provenance check. Today only `source_url`
 * is publicly projected.
 *
 * CLAIMS-GUARD (R-7): any PUBLIC rendering of these provenance fields must route
 * through the claims guard and state only MEASURED facts — "references CE
 * registry CTID <ctid>, retrieved <retrievedAt>, envelope fingerprint <sha256>"
 * — and explicitly NOT-ASSERT endorsement: "Arkova is not listed, endorsed, or
 * verified by Credential Engine." `ceEnvelopeSignatureVerified` is a
 * MEASURED technical fact about the envelope's own signature; it MUST NEVER be
 * rendered as CE endorsement of Arkova.
 */
export interface ImportedCtdlRecord {
  /** `@type` verbatim (e.g. `ceterms:License`), or null when absent. */
  type: string | null;
  /** Resolved `ceterms:name` (language-map/@value aware), or null. */
  name: string | null;
  /** `ceterms:ctid` — the source Credential Engine identifier, or null. */
  sourceId: string | null;
  /**
   * PROVENANCE LINK 1 — the canonical CE **Registry resource** URL for this
   * credential's CTID: `${registryBaseUrl}/resources/${ctid}`. The base is
   * INJECTED (`ParseCtdlOptions.registryBaseUrl`) so a sandbox import links to
   * the sandbox registry and a prod import to prod — never a hardcoded host.
   * Null when the source carries no ctid. Deliberately kept separate from
   * `sourceUrl`: these are two distinct clickable provenance anchors (registry
   * record vs. original issuer document), and from `sourceId` (the raw ctid).
   */
  registryUrl: string | null;
  /**
   * PROVENANCE LINK 2 — the credential's OWN source: the original issuer
   * document/page. Resolved from `ceterms:subjectWebpage` (preferred) or, when
   * that is absent, `ceterms:source`. Only http(s) values are kept; anything
   * else resolves to null (honest omission). Null when neither field carries a
   * usable URL.
   */
  sourceUrl: string | null;
  /**
   * PROVENANCE — when the registry resource was consumed (ISO 8601 /
   * timestamptz-ready), from the injected clock. The registry can change or
   * revoke a resource AFTER consumption, so this bounds the tamper window: the
   * record reflects the resource as of `retrievedAt`, not necessarily now.
   */
  retrievedAt: string | null;
  /**
   * PROVENANCE — SHA-256 (lowercase hex) of the EXACT CE registry JSON envelope
   * that was consumed. Lets a downstream reader detect that the registry's copy
   * later diverged from what Arkova ingested. This is a fingerprint of a PUBLIC
   * registry envelope — NOT a user-document fingerprint, so it is outside the
   * §1.6 client-only fingerprint boundary. Null when no envelope hash was
   * supplied (use {@link parseCtdlEnvelope} to compute it from the raw bytes).
   */
  ceEnvelopeSha256: string | null;
  /**
   * PROVENANCE — a MEASURED technical fact: did the consumed envelope's OWN CE
   * registry signature verify? `true`/`false` when the caller checked it, null
   * when unknown/unchecked. NEVER an endorsement signal: a verified envelope
   * signature means "these bytes came from the CE registry unaltered", it does
   * NOT mean Credential Engine listed, endorsed, or verified Arkova (R-7).
   */
  ceEnvelopeSignatureVerified: boolean | null;
  /** First org reference from `ceterms:ownedBy`, or null. */
  issuer: ImportedCtdlIssuer | null;
  /** `ceterms:dateEffective`, normalized to an ISO string, or null. */
  issuedAt: string | null;
  /**
   * `ceterms:expirationDate`, normalized to an ISO string, or null.
   *
   * TAXONOMY (SCRUM-2374 / Jeanne Kitchens, Credential Engine): CTDL
   * `ceterms:expirationDate` is the RESOURCE/OFFERING-availability expiry — the
   * date the credential RESOURCE is no longer offered — NOT a person's
   * credential validity. It is deliberately read into `resourceAvailableUntil`
   * (matching `ctdl-serializer.ts`, which maps `resourceAvailableUntil →
   * ceterms:expirationDate` and NEVER emits a person's `expiresAt`). Reading it
   * into a person-`expiresAt` field would both mislabel the datum AND break the
   * round-trip (import → re-serialize would silently drop it). Person-level
   * validity lives in the OB3/W3C VC layer (SCRUM-2296), never here.
   */
  resourceAvailableUntil: string | null;
  /**
   * The status the SOURCE document claimed, normalized from
   * `ceterms:lifecycleStatusType` (or null when the source made no claim). Kept
   * distinct from `status` so the SCRUM-2599 precedence is observable: a record
   * can carry `sourceStatus: 'active'` while `status: 'expired'`.
   */
  sourceStatus: ImportedCredentialStatus | null;
  /**
   * The RECONCILED status (SCRUM-2599). By DEFAULT this is just the normalized
   * `sourceStatus` (or `unknown` when the source made no claim) — the importer
   * does NOT force `expired` from the offering-availability date by default.
   *
   * ⚠ TAXONOMY DECISION PENDING RATIFICATION (SCRUM-2374 / Jeanne Kitchens):
   * `ceterms:expirationDate` is OFFERING/resource-availability expiry, not a
   * PERSON's credential validity. Coupling a past offering-availability date to a
   * person-credential `expired` status is therefore OPT-IN and OFF by default,
   * gated behind `treatResourceExpiryAsCredentialExpired`. Only when that flag is
   * explicitly enabled does a past `resourceAvailableUntil` (relative to `now`)
   * override an `active` claim. `sourceStatus` is kept distinct so the override
   * (when enabled) is always observable and reversible downstream. The
   * SCRUM-2374/Jeanne-guidance owner must ratify the coupling before it becomes
   * the default.
   */
  status: ImportedCredentialStatus;
}

export interface ParseCtdlOptions {
  /** Injected clock for the expiration-vs-status reconciliation (never Date.now()). */
  now: Date;
  /**
   * Injected base URL for the CE Registry resource link (`registryUrl`). Points
   * a sandbox import at the sandbox registry and a prod import at prod — never a
   * hardcoded single host. A trailing slash is tolerated. Defaults to the prod
   * registry ({@link DEFAULT_REGISTRY_BASE_URL}).
   */
  registryBaseUrl?: string;
  /**
   * When the registry resource was consumed. Defaults to `now` when omitted.
   * Threaded onto each record's `retrievedAt`.
   */
  retrievedAt?: Date;
  /**
   * SHA-256 (hex) of the exact registry envelope the caller consumed. Threaded
   * onto each record. Prefer {@link parseCtdlEnvelope}, which computes this from
   * the raw bytes so it is provably the envelope that was parsed.
   */
  ceEnvelopeSha256?: string | null;
  /**
   * MEASURED technical fact: did the consumed envelope's own CE registry
   * signature verify? Threaded onto each record. Never an endorsement signal.
   */
  ceEnvelopeSignatureVerified?: boolean | null;
  /**
   * SCRUM-2599 opt-in. When `true`, a past `ceterms:expirationDate`
   * (offering/resource availability) forces `status='expired'` over the source's
   * lifecycle claim. **Default `false`** because that offering→person coupling is
   * an unratified taxonomy decision (SCRUM-2374). With it off, `sourceStatus`
   * stands and `resourceAvailableUntil` is preserved purely as data.
   */
  treatResourceExpiryAsCredentialExpired?: boolean;
  /**
   * SCRUM-2913 opt-in (the real-record "junk" fix). When `true`,
   * `parseCtdlDocument` / `parseCtdlEnvelope` emit records ONLY for nodes whose
   * `@type` is a CTDL credential class (see {@link isCtdlCredentialClass}), and
   * resolve `@id`-referenced issuer names from sibling `@graph` nodes (see
   * {@link parseCtdlCredentials}). A real CE `/graph/<ctid>` envelope carries
   * the credential node PLUS organization / ConditionProfile / CostProfile /
   * concept nodes; without the filter each of those becomes a junk record.
   * **Default `false`** so the existing per-node surface is unchanged.
   */
  credentialNodesOnly?: boolean;
  /**
   * L3-A6 CE Noncredit POC opt-in (2026-07-28). When `true` (and only in
   * combination with `credentialNodesOnly: true`), `parseCtdlCredentials` ALSO
   * admits CTDL noncredit-PROGRAM classes (see
   * {@link CTDL_NONCREDIT_PROGRAM_CLASSES} / {@link isCtdlNoncreditProgramClass})
   * — `ceterms:LearningProgram`, `ceterms:LearningOpportunityProfile`,
   * `ceterms:LearningOpportunity`, `ceterms:Course`.
   *
   * WHY THIS EXISTS: Credential Engine's Noncredit Data Taxonomy 3.0 → CTDL
   * benchmark model (published 2026-07-16,
   * guidance.credentialengine.org/noncredit-data-taxonomy/) maps noncredit
   * program records onto `ceterms:LearningProgram` (a documented CTDL subclass
   * of `ceterms:LearningOpportunityProfile`) — NOT onto the `CTDL_CREDENTIAL_CLASSES`
   * enumeration (Certificate/License/Degree/Badge/…). Verified against the real
   * importer: with `credentialNodesOnly: true` alone, a `ceterms:LearningProgram`
   * node is silently dropped — it fails BOTH the enumeration AND the
   * credential-shaped fallback pattern (`CREDENTIAL_CLASS_FALLBACK` only matches
   * `Certificat|Licen|Degree|Badge|Diploma|Credential` substrings, none of which
   * `LearningProgram` contains), so noncredit is treated as non-credential junk
   * by default — exactly the class of record this POC exists to anchor. Many
   * noncredit offerings never award a formal credential at all (that is the
   * defining trait of "noncredit"), so gating solely on the credential-class
   * enumeration would make noncredit records unimportable by construction.
   *
   * **Default `false`** — additive, byte-for-byte unchanged default behavior for
   * every existing caller (SCRUM-2913's credential-only surface, `ctdl-importer.
   * real-fixtures.test.ts`, the fuzz suite). Never applies via the fallback veto
   * — noncredit classes are explicitly enumerated, mirroring how
   * `CTDL_CREDENTIAL_CLASSES` bypasses `NON_CREDENTIAL_CLASS_VETO`.
   */
  includeNoncreditProgramClasses?: boolean;
}

/** Prod CE Registry base — the default when no `registryBaseUrl` is injected. */
export const DEFAULT_REGISTRY_BASE_URL = 'https://credentialengineregistry.org' as const;

/** Raised only for a structurally impossible node (non-object where a node is required). */
export class CtdlImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CtdlImportError';
  }
}

// A CE CTID is `ce-` + a v4-shaped UUID (mirrors REAL_CTID_PATTERN in the
// serializer's ctid-guard, but used here only for extraction from a URI).
const CTID_PATTERN = /ce-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Date-only shape, PADDING-TOLERANT: a 4-digit year with 1-or-2-digit month/day.
// CTDL/JSON-LD data is not always zero-padded, and requiring `\d{2}` let
// non-padded impossible dates (e.g. "2026-2-31") bypass the strict guard and
// reach new Date() (which silently normalizes). All matches are strict-validated
// by canonicalizeBareDate.
const DATE_ONLY_SHAPE = /^\d{4}-\d{1,2}-\d{1,2}$/;

// -----------------------------------------------------------------------------
// Zod schema — every parsed record is validated before it leaves the module.
// -----------------------------------------------------------------------------
const StatusEnum = z.enum(['active', 'expired', 'inactive', 'unknown']);

const ImportedCtdlIssuerSchema = z.object({
  id: z.string().nullable(),
  ctid: z.string().nullable(),
  name: z.string().nullable(),
});

export const ImportedCtdlRecordSchema = z.object({
  type: z.string().nullable(),
  name: z.string().nullable(),
  sourceId: z.string().nullable(),
  registryUrl: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  retrievedAt: z.string().nullable(),
  ceEnvelopeSha256: z.string().nullable(),
  ceEnvelopeSignatureVerified: z.boolean().nullable(),
  issuer: ImportedCtdlIssuerSchema.nullable(),
  issuedAt: z.string().nullable(),
  resourceAvailableUntil: z.string().nullable(),
  sourceStatus: StatusEnum.nullable(),
  status: StatusEnum,
});

// -----------------------------------------------------------------------------
// Small structural helpers
// -----------------------------------------------------------------------------
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Bound on how many entries of an @type array we scan — a defensive cap so a
// hostile document cannot make @type resolution unbounded work.
const MAX_TYPE_ENTRIES = 64;

/**
 * Resolve a JSON-LD `@type`, which may be a single string OR an array (JSON-LD
 * permits both). For an array we prefer the first `ceterms:` term (our vocab),
 * else the first non-empty string; non-string entries are ignored and an empty
 * array resolves to null. Scanning is bounded by {@link MAX_TYPE_ENTRIES}.
 */
export function resolvePrimaryType(value: unknown): string | null {
  if (typeof value === 'string') return cleanString(value);
  if (!Array.isArray(value)) return null;

  const entries = value.slice(0, MAX_TYPE_ENTRIES);
  const cetermsType = entries.find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().startsWith('ceterms:'),
  );
  if (cetermsType) return cleanString(cetermsType);

  for (const entry of entries) {
    const clean = cleanString(entry);
    if (clean) return clean;
  }
  return null;
}

/** True for an `en`/`en-US`/`en-GB`… language tag. */
function isEnglishTag(tag: string): boolean {
  return tag.toLowerCase() === 'en' || tag.toLowerCase().startsWith('en-');
}

/**
 * Resolve a CTDL string that may arrive as:
 *  - a plain string;
 *  - a JSON-LD value object `{ "@value": "...", "@language": "en" }`;
 *  - an array of value objects / strings;
 *  - a language map `{ "en-US": "...", "fr": "..." }`.
 * Prefers an English tag, then the first available non-empty value; empty or
 * missing resolves to null.
 */
export function resolveCtdlLangString(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') return cleanString(value);

  if (Array.isArray(value)) {
    // Prefer an English-tagged entry, else the first that resolves.
    const english = value.find(
      (entry) => isRecord(entry) && typeof entry['@language'] === 'string' && isEnglishTag(entry['@language']),
    );
    if (english) {
      const resolved = resolveCtdlLangString(english);
      if (resolved) return resolved;
    }
    for (const entry of value) {
      const resolved = resolveCtdlLangString(entry);
      if (resolved) return resolved;
    }
    return null;
  }

  if (isRecord(value)) {
    // JSON-LD value object.
    if ('@value' in value) return cleanString(value['@value']);

    // Language map. Prefer a bare `en`, then any `en-*`, then first non-empty.
    const entries = Object.entries(value).filter(([key]) => !key.startsWith('@'));
    const bareEn = entries.find(([key]) => key.toLowerCase() === 'en');
    if (bareEn) {
      const resolved = cleanString(bareEn[1]);
      if (resolved) return resolved;
    }
    const anyEn = entries.find(([key]) => isEnglishTag(key));
    if (anyEn) {
      const resolved = cleanString(anyEn[1]);
      if (resolved) return resolved;
    }
    for (const [, entryValue] of entries) {
      const resolved = cleanString(entryValue);
      if (resolved) return resolved;
    }
    return null;
  }

  return null;
}

/** Unwrap a JSON-LD `@value` wrapper (or pass a string through). */
function unwrapScalar(value: unknown): unknown {
  if (isRecord(value) && '@value' in value) return value['@value'];
  return value;
}

/**
 * STRICT calendar-day check. `new Date("2026-02-31")` silently NORMALIZES to
 * 2026-03-03 (and `2026-13-01` → 2027, `2026-00-10` → 2025-12), so a raw
 * `Date` parse lets impossible third-party dates through. This parses the
 * Y-M-D components and round-trips them through `Date.UTC` — the value is real
 * only if every component survives unchanged. Rejects `2026-02-31`,
 * `2026-13-01`, `2026-00-10`, `2026-05-00`, and a non-leap-year `2026-02-29`;
 * accepts a real leap day `2024-02-29`.
 */
/**
 * Strict, padding-tolerant bare-date validator + canonicalizer. Accepts a
 * 4-digit year with 1-OR-2-digit month/day (JSON-LD/CTDL data is not always
 * zero-padded), round-trips the Y-M-D through `Date.UTC`, and returns the
 * CANONICAL zero-padded `YYYY-MM-DD` only if every component survives unchanged.
 * Returns null for any impossible calendar day (`2026-02-31`, `2026-2-31`,
 * `2026-13-01`, `2026-00-10`, `2026-05-00`, non-leap `2026-02-29`) or non-date
 * shape. Padding normalization (`2026-2-3` → `2026-02-03`) is lossless (same
 * day) — NOT the silently-WRONG normalization `new Date()` would do for an
 * impossible day.
 */
function canonicalizeBareDate(bareDate: string): string | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(bareDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Normalize a CTDL date to an ISO string. A date-only value (any padding) is
 * strict-validated and returned canonical (`YYYY-MM-DD`); a full datetime is
 * canonicalized via `toISOString()` after its leading date portion passes the
 * same strict check. Impossible calendar dates (e.g. `2026-02-31`, `2026-2-31`)
 * and anything unparseable resolve to null (honest omission — never a throw, and
 * never a silently-normalized WRONG date, regardless of zero-padding).
 */
export function normalizeCtdlDate(value: unknown): string | null {
  const scalar = unwrapScalar(value);
  const raw = cleanString(scalar);
  if (!raw) return null;

  // Date-only shape (padding-tolerant): must be a real calendar day.
  if (DATE_ONLY_SHAPE.test(raw)) {
    return canonicalizeBareDate(raw);
  }

  // Datetime: the leading date portion (before the 'T'/space separator) must
  // itself be a real calendar day — regardless of padding — so a datetime like
  // "2026-2-31T12:00:00Z" or "2026-02-31T12:00:00Z" cannot slip through and be
  // silently normalized by new Date().
  const datePart = raw.split(/[T ]/, 1)[0] ?? '';
  if (DATE_ONLY_SHAPE.test(datePart) && canonicalizeBareDate(datePart) === null) return null;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Extract a `ce-…` CTID from a value that is a CTID string or a URI containing one. */
function extractCtid(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw) return null;
  const match = raw.match(CTID_PATTERN);
  return match ? match[0] : null;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** Accept only a 64-char hex SHA-256 (lowercased); anything else → null. */
function cleanSha256(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw || !SHA256_HEX.test(raw)) return null;
  return raw.toLowerCase();
}

/** Keep only well-formed http(s) URLs; everything else → null (honest omission). */
function cleanHttpUrl(value: unknown): string | null {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve the FIRST usable http(s) URL from a CTDL link value, which may be a
 * string, an `{ "@id": "…" }` node reference, or an array of either. Used for
 * `ceterms:subjectWebpage` / `ceterms:source`.
 */
function firstHttpUrl(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = firstHttpUrl(entry);
      if (resolved) return resolved;
    }
    return null;
  }
  if (isRecord(value)) return cleanHttpUrl(value['@id']);
  return cleanHttpUrl(value);
}

/**
 * PROVENANCE LINK 1 — build the canonical CE Registry resource URL for a CTID.
 * `${base}/resources/${ctid}`, with the injected base's trailing slash trimmed
 * so we never emit a double slash. Null when the ctid is absent.
 */
export function buildRegistryUrl(ctid: string | null, registryBaseUrl: string): string | null {
  if (!ctid) return null;
  const base = registryBaseUrl.replace(/\/+$/, '');
  return `${base}/resources/${ctid}`;
}

/**
 * PROVENANCE LINK 2 — resolve the credential's own source URL. Precedence:
 * `ceterms:subjectWebpage` (the issuer's canonical page for the credential) is
 * PREFERRED over `ceterms:source` (a more generic origin reference). Only
 * http(s) values survive; null when neither yields a usable URL.
 */
export function resolveSourceUrl(node: Record<string, unknown>): string | null {
  return firstHttpUrl(node['ceterms:subjectWebpage']) ?? firstHttpUrl(node['ceterms:source']);
}

/**
 * Normalize `ceterms:lifecycleStatusType` to a bounded status token. The value
 * may be a string (`lifecycle:Active`), a full URI, or an alignment object
 * carrying `@id`/`ceterms:targetNode`. Unknown tokens resolve to `unknown`.
 */
export function normalizeLifecycleStatus(value: unknown): ImportedCredentialStatus | null {
  let token: string | null = null;
  if (typeof value === 'string') {
    token = value;
  } else if (isRecord(value)) {
    token =
      cleanString(value['@id']) ??
      cleanString(value['ceterms:targetNode']) ??
      cleanString(value['@value']);
  }
  if (!token) return null;

  // Reduce `lifecycle:Active` / `…/Active` / `Active` to `active`.
  const leaf = token.split(/[:/#]/).pop()?.toLowerCase() ?? '';
  if (!leaf) return null;

  if (leaf === 'active') return 'active';
  if (leaf === 'expired') return 'expired';
  if (['deprecated', 'ceased', 'revoked', 'superseded', 'retired', 'suspended', 'teachout'].includes(leaf)) {
    return 'inactive';
  }
  return 'unknown';
}

/** Map the first `ceterms:ownedBy` entry to a bounded issuer reference. */
export function resolveIssuer(ownedBy: unknown): ImportedCtdlIssuer | null {
  const first = Array.isArray(ownedBy) ? ownedBy[0] : ownedBy;
  if (first === null || first === undefined) return null;

  if (typeof first === 'string') {
    const id = cleanString(first);
    if (!id) return null;
    return { id, ctid: extractCtid(id), name: null };
  }

  if (isRecord(first)) {
    const id = cleanString(first['@id']);
    const ctid = extractCtid(first['ceterms:ctid']) ?? extractCtid(id);
    const name = resolveCtdlLangString(first['ceterms:name']);
    if (id === null && ctid === null && name === null) return null;
    return { id, ctid, name };
  }

  return null;
}

/**
 * SCRUM-2599 — reconcile the source-claimed status against the expiration date.
 *
 * ⚠ TAXONOMY caveat (SCRUM-2374 / Jeanne): `ceterms:expirationDate` is
 * offering/resource availability, NOT person-credential validity. Coupling a
 * past offering-availability date to a person-credential `expired` status is an
 * UNRATIFIED taxonomy decision, so it is **OPT-IN and OFF by default**
 * (`applyResourceExpiry`). When off, the source's lifecycle claim stands and
 * `resourceAvailableUntil` remains available purely as data. See
 * {@link ImportedCtdlRecord.status}.
 *
 * SEVERITY GUARD: the override only ever *raises* severity from a
 * not-yet-terminal state. It fires only when `sourceStatus ∈ {active, unknown,
 * null}` — a terminal `inactive` (e.g. revoked) or `expired` is NEVER
 * downgraded. `expired` is less severe than `inactive`/revoked, so relabeling a
 * revoked credential "expired" would silently discard the revocation.
 */
const OVERRIDABLE_SOURCE_STATUSES = new Set<ImportedCredentialStatus>(['active', 'unknown']);

export function reconcileStatus(
  sourceStatus: ImportedCredentialStatus | null,
  resourceAvailableUntil: string | null,
  now: Date,
  applyResourceExpiry: boolean,
): ImportedCredentialStatus {
  const overridable = sourceStatus === null || OVERRIDABLE_SOURCE_STATUSES.has(sourceStatus);
  if (applyResourceExpiry && overridable && resourceAvailableUntil) {
    const expiry = new Date(resourceAvailableUntil).getTime();
    if (!Number.isNaN(expiry) && expiry <= now.getTime()) {
      // Opt-in only, and only from a non-terminal source claim: a past
      // availability date overrides an "active"/"unknown" status. A terminal
      // inactive/expired is left untouched (never downgraded).
      return 'expired';
    }
  }
  return sourceStatus ?? 'unknown';
}

/** Parse a single CTDL node into a validated `ImportedCtdlRecord`. */
export function parseCtdlNode(node: unknown, options: ParseCtdlOptions): ImportedCtdlRecord {
  if (!isRecord(node)) {
    throw new CtdlImportError('CTDL node must be a JSON object');
  }

  const type = resolvePrimaryType(node['@type']);
  const name = resolveCtdlLangString(node['ceterms:name']);
  const sourceId = extractCtid(node['ceterms:ctid']);
  const registryUrl = buildRegistryUrl(
    sourceId,
    options.registryBaseUrl ?? DEFAULT_REGISTRY_BASE_URL,
  );
  const sourceUrl = resolveSourceUrl(node);
  const retrievedAt = (options.retrievedAt ?? options.now).toISOString();
  const ceEnvelopeSha256 = cleanSha256(options.ceEnvelopeSha256);
  const ceEnvelopeSignatureVerified =
    typeof options.ceEnvelopeSignatureVerified === 'boolean'
      ? options.ceEnvelopeSignatureVerified
      : null;
  const issuer = resolveIssuer(node['ceterms:ownedBy']);
  const issuedAt = normalizeCtdlDate(node['ceterms:dateEffective']);
  // TAXONOMY (SCRUM-2374): ceterms:expirationDate is OFFERING availability, read
  // into resourceAvailableUntil to mirror the serializer and keep round-trips
  // lossless — NOT a person's expiresAt.
  const resourceAvailableUntil = normalizeCtdlDate(node['ceterms:expirationDate']);
  // REAL-record status spellings (SCRUM-2913): live CE Registry records carry
  // the status under THREE keys — `ceterms:lifecycleStatusType` (synthetic /
  // legacy), `ceterms:lifeCycleStatusType` (capital C — the actual CTDL term,
  // seen on CE's own org record), or `ceterms:credentialStatusType`
  // (`credentialStat:Active`, seen on real credential records). First present
  // key wins; all three route through the same bounded normalizer.
  const sourceStatus = normalizeLifecycleStatus(
    node['ceterms:lifecycleStatusType'] ??
      node['ceterms:lifeCycleStatusType'] ??
      node['ceterms:credentialStatusType'],
  );
  const status = reconcileStatus(
    sourceStatus,
    resourceAvailableUntil,
    options.now,
    options.treatResourceExpiryAsCredentialExpired === true,
  );

  return ImportedCtdlRecordSchema.parse({
    type,
    name,
    sourceId,
    registryUrl,
    sourceUrl,
    retrievedAt,
    ceEnvelopeSha256,
    ceEnvelopeSignatureVerified,
    issuer,
    issuedAt,
    resourceAvailableUntil,
    sourceStatus,
    status,
  });
}

/**
 * DoS bound on how many `@graph` (or bare-array) nodes a single untrusted CTDL
 * document may contain. A hostile document with millions of nodes would
 * otherwise pin CPU/memory in the parse loop. On overflow we THROW (see
 * {@link nodesOf}) rather than truncate — silently truncating would present a
 * partial import as complete, which is worse for a parse boundary.
 */
export const MAX_GRAPH_NODES = 10_000;

/**
 * Extract the credential nodes from a CTDL document. Handles all three shapes
 * CTDL documents arrive in: a `{ "@graph": [...] }` envelope, a bare array of
 * nodes, or a single top-level node. A null/primitive document yields `[]`.
 * Throws `CtdlImportError` when the node count exceeds {@link MAX_GRAPH_NODES}
 * (matches the module's structural-impossibility-throws contract; never a
 * silent truncation). The cap message is value-free (no document content).
 */
function nodesOf(doc: unknown): unknown[] {
  let nodes: unknown[];
  if (isRecord(doc)) {
    nodes = Array.isArray(doc['@graph']) ? doc['@graph'] : [doc];
  } else if (Array.isArray(doc)) {
    nodes = doc;
  } else {
    return [];
  }
  if (nodes.length > MAX_GRAPH_NODES) {
    throw new CtdlImportError(`CTDL @graph exceeds the ${MAX_GRAPH_NODES}-node limit`);
  }
  return nodes;
}

// -----------------------------------------------------------------------------
// CTDL credential-class filter (SCRUM-2913 — the real-record "junk" fix)
// -----------------------------------------------------------------------------

/**
 * Enumerated CTDL credential classes (`@type` values that describe a
 * CREDENTIAL, not an organization/profile/concept). Sourced from the CTDL
 * types list; the fallback pattern below catches credential-shaped ceterms
 * classes added to CTDL after this enumeration.
 */
export const CTDL_CREDENTIAL_CLASSES: ReadonlySet<string> = new Set([
  'ceterms:Certification',
  'ceterms:License',
  'ceterms:Certificate',
  'ceterms:Degree',
  'ceterms:Badge',
  'ceterms:DigitalBadge',
  'ceterms:OpenBadge',
  'ceterms:BachelorDegree',
  'ceterms:MasterDegree',
  'ceterms:DoctoralDegree',
  'ceterms:AssociateDegree',
  'ceterms:MicroCredential',
  'ceterms:ApprenticeshipCertificate',
  'ceterms:JourneymanCertificate',
  'ceterms:MasterCertificate',
  'ceterms:ProfessionalDoctorate',
  'ceterms:QualityAssuranceCredential',
  'ceterms:SecondarySchoolDiploma',
  'ceterms:GeneralEducationDevelopment',
  'ceterms:CertificateOfCompletion',
]);

// Fallback for credential-shaped ceterms classes NOT in the enumeration
// (CTDL adds subclasses over time — e.g. a future ceterms:TradeDiploma).
const CREDENTIAL_CLASS_FALLBACK = /^ceterms:.*(Certificat|Licen|Degree|Badge|Diploma|Credential)/;

// REAL-record trap (seen in the live /graph fixture): CTDL has NON-credential
// classes whose names CONTAIN a credential keyword — `ceterms:QACredentialOrganization`,
// `ceterms:CredentialOrganization`, `ceterms:CredentialAlignmentObject`,
// `ceterms:CredentialingAction`, `ceterms:CredentialPerson`. A bare keyword
// regex would emit junk records for every one of them, so agent/support-class
// SUFFIXES veto the fallback (never the explicit enumeration above).
const NON_CREDENTIAL_CLASS_VETO = /(Organization|Person|Agent|AlignmentObject|Action|Profile|Manifest|Framework|Scheme|Concept|Assessment|LearningOpportunity)$/;

/**
 * True when `type` (a single `@type` string) names a CTDL CREDENTIAL class:
 * either enumerated in {@link CTDL_CREDENTIAL_CLASSES}, or matching the
 * credential-shaped fallback pattern without hitting an agent/support-class
 * veto suffix.
 */
export function isCtdlCredentialClass(type: string | null): boolean {
  if (!type) return false;
  const clean = type.trim();
  if (clean.length === 0) return false;
  if (CTDL_CREDENTIAL_CLASSES.has(clean)) return true;
  if (NON_CREDENTIAL_CLASS_VETO.test(clean)) return false;
  return CREDENTIAL_CLASS_FALLBACK.test(clean);
}

// -----------------------------------------------------------------------------
// CTDL noncredit-PROGRAM class filter (L3-A6 — CE Noncredit Data Taxonomy 3.0
// POC, 2026-07-28). See `ParseCtdlOptions.includeNoncreditProgramClasses` for
// the full "why" — CE's NDT-3.0 → CTDL benchmark model maps noncredit program
// records onto ceterms:LearningProgram (subclass of ceterms:LearningOpportunity
// Profile), none of which pass CTDL_CREDENTIAL_CLASSES or its fallback pattern.
// -----------------------------------------------------------------------------

/**
 * Enumerated CTDL noncredit-PROGRAM classes — the record shapes CE's Noncredit
 * Data Taxonomy 3.0 benchmark model actually publishes. Sourced from the CTDL
 * types list (credreg.net/page/typeslist) and
 * guidance.credentialengine.org/noncredit-data-taxonomy/:
 *   - `ceterms:LearningProgram` — "Set of learning opportunities that leads to
 *     an outcome, usually a credential like a degree or certificate" — the
 *     primary class for a noncredit program record.
 *   - `ceterms:LearningOpportunityProfile` — the broader class LearningProgram
 *     specializes; some noncredit publishers emit records typed directly at
 *     this level rather than the narrower LearningProgram subclass.
 *   - `ceterms:LearningOpportunity` — CTDL's general opportunity class,
 *     occasionally used interchangeably with LearningOpportunityProfile in
 *     publisher data.
 *   - `ceterms:Course` — course-level noncredit offerings (a documented CTDL
 *     sibling subclass of LearningOpportunityProfile, alongside LearningProgram).
 * Explicitly enumerated (not pattern-matched) because every one of these class
 * names ends in a suffix (`Profile`/`LearningOpportunity`) that
 * `NON_CREDENTIAL_CLASS_VETO` deliberately rejects for the credential-class
 * fallback — the veto must never gate this explicit, intentional admission.
 */
export const CTDL_NONCREDIT_PROGRAM_CLASSES: ReadonlySet<string> = new Set([
  'ceterms:LearningProgram',
  'ceterms:LearningOpportunityProfile',
  'ceterms:LearningOpportunity',
  'ceterms:Course',
]);

/** True when `type` names one of {@link CTDL_NONCREDIT_PROGRAM_CLASSES} verbatim. */
export function isCtdlNoncreditProgramClass(type: string | null): boolean {
  if (!type) return false;
  const clean = type.trim();
  if (clean.length === 0) return false;
  return CTDL_NONCREDIT_PROGRAM_CLASSES.has(clean);
}

/**
 * True when `type` is admitted by the current parse options: a CTDL credential
 * class always; a CTDL noncredit-program class only when
 * `includeNoncreditProgramClasses` is set.
 */
function isAdmittedClass(type: string | null, options: ParseCtdlOptions): boolean {
  if (isCtdlCredentialClass(type)) return true;
  return options.includeNoncreditProgramClasses === true && isCtdlNoncreditProgramClass(type);
}

/**
 * True when a node's raw `@type` value (string OR JSON-LD array) carries ANY
 * admitted class (credential, or — opt-in — noncredit program). Array scanning
 * is bounded by {@link MAX_TYPE_ENTRIES}.
 */
function hasCredentialClass(typeValue: unknown, options: ParseCtdlOptions): boolean {
  if (typeof typeValue === 'string') return isAdmittedClass(typeValue, options);
  if (!Array.isArray(typeValue)) return false;
  return typeValue
    .slice(0, MAX_TYPE_ENTRIES)
    .some((entry) => typeof entry === 'string' && isAdmittedClass(entry, options));
}

/**
 * Resolve the CREDENTIAL-class `@type` label for an ADMITTED node (architect
 * cross-review fix): a node typed
 * `['ceterms:CredentialOrganization', 'ceterms:Certification']` is admitted by
 * the any-entry filter, but `resolvePrimaryType` would label the record with
 * the FIRST ceterms entry — the org class — which is exactly the
 * class-confusion the filter exists to prevent. Returns the first entry that
 * passes {@link isCtdlCredentialClass} (bounded by {@link MAX_TYPE_ENTRIES}),
 * or null when none does (callers fall back to the record's existing type, so
 * the resolution stays total). Scoped to the credential-filtered path only —
 * the default unfiltered surface keeps `resolvePrimaryType` behavior.
 */
function resolveCredentialType(typeValue: unknown, options: ParseCtdlOptions): string | null {
  if (typeof typeValue === 'string') {
    return isAdmittedClass(typeValue, options) ? cleanString(typeValue) : null;
  }
  if (!Array.isArray(typeValue)) return null;
  for (const entry of typeValue.slice(0, MAX_TYPE_ENTRIES)) {
    if (typeof entry === 'string' && isAdmittedClass(entry, options)) {
      return cleanString(entry);
    }
  }
  return null;
}

/**
 * Cross-`@id` issuer-name resolution (SCRUM-2913). Real CE credential nodes
 * reference their owner as a bare URI (`ceterms:ownedBy: ["https://…/resources/ce-…"]`);
 * when the referenced organization node happens to be PRESENT in the same
 * `@graph`, lift its `ceterms:name` (and ctid) onto the issuer reference.
 * Strictly same-document — never a network fetch — and cycle-proof by
 * construction: resolution is a single Map lookup (index built in one pass, no
 * recursion), so duplicated or self-referencing `@id`s cannot loop.
 */
function enrichIssuerFromGraph(
  record: ImportedCtdlRecord,
  nodesById: ReadonlyMap<string, Record<string, unknown>>,
): ImportedCtdlRecord {
  const issuer = record.issuer;
  if (!issuer || issuer.id === null || issuer.name !== null) return record;
  const referenced = nodesById.get(issuer.id);
  if (!referenced) return record;
  const name = resolveCtdlLangString(referenced['ceterms:name']);
  const ctid = issuer.ctid ?? extractCtid(referenced['ceterms:ctid']);
  if (name === null && ctid === issuer.ctid) return record;
  // Re-validated: every record leaving this module passes the Zod schema.
  return ImportedCtdlRecordSchema.parse({ ...record, issuer: { ...issuer, name, ctid } });
}

/**
 * Parse ONLY the CREDENTIAL nodes of a CTDL document (SCRUM-2913 entry-point).
 *
 * A real CE `/graph/<ctid>` envelope carries the credential node PLUS
 * organization nodes, ConditionProfile / CostProfile blank nodes, and
 * ceasn/skos concept nodes; the unfiltered per-node surface turns each of
 * those into a junk record. This entry-point:
 *  - emits a record only for nodes whose `@type` (string or array, any entry)
 *    is a CTDL credential class per {@link isCtdlCredentialClass};
 *  - skips non-object and non-credential `@graph` entries entirely (they are
 *    not credentials, so they are filtered — not a structural throw);
 *  - resolves `@id`-referenced issuer names from sibling nodes in the SAME
 *    document (two-pass: index by `@id`, then a single bounded lookup per
 *    record — no recursion, no network, cycle-proof).
 * The {@link MAX_GRAPH_NODES} DoS cap applies before any parsing.
 */
export function parseCtdlCredentials(
  doc: unknown,
  options: ParseCtdlOptions,
): ImportedCtdlRecord[] {
  const nodes = nodesOf(doc);

  // Pass 1 — index nodes by @id for same-document issuer resolution. First
  // occurrence wins on duplicated @ids (deterministic; no last-writer races).
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const id = cleanString(node['@id']);
    if (id && !nodesById.has(id)) nodesById.set(id, node);
  }

  // Pass 2 — parse admitted-class nodes only (credential classes always;
  // noncredit-program classes when `includeNoncreditProgramClasses` is set).
  const records: ImportedCtdlRecord[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    if (!hasCredentialClass(node['@type'], options)) continue;
    let record = parseCtdlNode(node, options);
    // Mixed @type arrays: the record must be LABELED with the admitted class
    // that let it through, never a co-listed non-admitted class.
    const admittedType = resolveCredentialType(node['@type'], options);
    if (admittedType !== null && admittedType !== record.type) {
      record = ImportedCtdlRecordSchema.parse({ ...record, type: admittedType });
    }
    records.push(enrichIssuerFromGraph(record, nodesById));
  }
  return records;
}

/**
 * Parse a CTDL JSON-LD document into internal records — one per node in the
 * `@graph` (or the single top-level node). Untrusted third-party input: shape
 * problems on individual fields resolve to null, not a throw. With
 * `options.credentialNodesOnly` set, delegates to {@link parseCtdlCredentials}
 * (credential-class nodes only + same-document issuer resolution).
 */
export function parseCtdlDocument(doc: unknown, options: ParseCtdlOptions): ImportedCtdlRecord[] {
  if (options.credentialNodesOnly === true) return parseCtdlCredentials(doc, options);
  return nodesOf(doc).map((node) => parseCtdlNode(node, options));
}

/**
 * Parse a CTDL envelope from its RAW bytes, computing the SHA-256 of exactly
 * those bytes and stamping it onto every record's `ceEnvelopeSha256`. This
 * is the faithful way to obtain the envelope fingerprint (the parser otherwise
 * only sees an already-decoded object). The hash is of a PUBLIC registry
 * envelope — not a user document — so it is outside the §1.6 client-only
 * fingerprint boundary.
 *
 * A `ceEnvelopeSha256` passed in `options` is ignored in favor of the
 * computed value. Throws `CtdlImportError` if the bytes are not valid JSON.
 */
export function parseCtdlEnvelope(
  rawEnvelope: string,
  options: ParseCtdlOptions,
): ImportedCtdlRecord[] {
  const envelopeSha256 = createHash('sha256').update(rawEnvelope, 'utf8').digest('hex');
  let doc: unknown;
  try {
    doc = JSON.parse(rawEnvelope);
  } catch {
    throw new CtdlImportError('CTDL envelope is not valid JSON');
  }
  return parseCtdlDocument(doc, { ...options, ceEnvelopeSha256: envelopeSha256 });
}
