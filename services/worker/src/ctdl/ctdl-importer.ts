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
   * The RECONCILED status (SCRUM-2599). Precedence, in order:
   *   1. A past `resourceAvailableUntil` (`ceterms:expirationDate`, relative to
   *      the injected `now`) drives `expired` even if the source claims `active`.
   *   2. Otherwise the normalized `sourceStatus` is used.
   *   3. With neither an expiry nor a status claim, the result is `unknown`.
   *
   * ⚠ TAXONOMY DECISION PENDING RATIFICATION (SCRUM-2374 / Jeanne Kitchens):
   * `ceterms:expirationDate` is OFFERING/resource-availability expiry, not a
   * PERSON's credential validity. SCRUM-2599 deliberately lets a past
   * offering-availability date drive a person-credential `expired` status — a
   * useful default, but a taxonomy coupling the SCRUM-2374/Jeanne-guidance owner
   * MUST ratify before it is treated as authoritative. `sourceStatus` is kept
   * distinct so the override is always observable (and reversible) downstream.
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
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// -----------------------------------------------------------------------------
// Zod schema — every parsed record is validated before it leaves the module.
// -----------------------------------------------------------------------------
const StatusEnum = z.enum(['active', 'expired', 'inactive', 'unknown']);

const ImportedCtdlIssuerSchema = z.object({
  id: z.string().nullable(),
  ctid: z.string().nullable(),
  name: z.string().nullable(),
});

const ImportedCtdlRecordSchema = z.object({
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
 * Normalize a CTDL date to an ISO string. A bare calendar date (`YYYY-MM-DD`)
 * is preserved as-is (already ISO-8601 and free of a fabricated time-of-day); a
 * full datetime is canonicalized via `toISOString()`. Anything unparseable
 * resolves to null (honest omission — never a throw).
 */
export function normalizeCtdlDate(value: unknown): string | null {
  const scalar = unwrapScalar(value);
  const raw = cleanString(scalar);
  if (!raw) return null;

  if (BARE_DATE.test(raw)) {
    // Validate it is a real calendar day before trusting it.
    return Number.isNaN(new Date(`${raw}T00:00:00Z`).getTime()) ? null : raw;
  }

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
 * A past `resourceAvailableUntil` (`ceterms:expirationDate`, relative to the
 * injected `now`) drives `expired` over the source's lifecycle claim.
 *
 * ⚠ TAXONOMY caveat (SCRUM-2374 / Jeanne): the date is offering/resource
 * availability, not person-credential validity — this coupling is a default the
 * SCRUM-2374 owner must ratify. See {@link ImportedCtdlRecord.status}.
 */
export function reconcileStatus(
  sourceStatus: ImportedCredentialStatus | null,
  resourceAvailableUntil: string | null,
  now: Date,
): ImportedCredentialStatus {
  if (resourceAvailableUntil) {
    const expiry = new Date(resourceAvailableUntil).getTime();
    if (!Number.isNaN(expiry) && expiry <= now.getTime()) {
      // Past availability date is ground truth — overrides an "active" claim.
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

  const type = cleanString(node['@type']);
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
  const sourceStatus = normalizeLifecycleStatus(node['ceterms:lifecycleStatusType']);
  const status = reconcileStatus(sourceStatus, resourceAvailableUntil, options.now);

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
 * Extract the credential nodes from a CTDL document. Handles all three shapes
 * CTDL documents arrive in: a `{ "@graph": [...] }` envelope, a bare array of
 * nodes, or a single top-level node. A null/primitive document yields `[]`.
 */
function nodesOf(doc: unknown): unknown[] {
  if (isRecord(doc)) {
    if (Array.isArray(doc['@graph'])) return doc['@graph'];
    return [doc];
  }
  if (Array.isArray(doc)) return doc;
  return [];
}

/**
 * Parse a CTDL JSON-LD document into internal records — one per node in the
 * `@graph` (or the single top-level node). Untrusted third-party input: shape
 * problems on individual fields resolve to null, not a throw.
 */
export function parseCtdlDocument(doc: unknown, options: ParseCtdlOptions): ImportedCtdlRecord[] {
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
