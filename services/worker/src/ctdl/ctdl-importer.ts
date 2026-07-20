/**
 * CTDL JSON-LD importer / parser (SCRUM-2913 + SCRUM-2599).
 *
 * The inverse of `ctdl-serializer.ts`: that module emits public CTDL JSON-LD
 * FROM Arkova anchors; this module reads a CTDL JSON-LD document (e.g. fetched
 * from the Credential Engine Registry or a partner CTID lookup) INTO a bounded,
 * internal `ImportedCtdlRecord`. It never emits anything public and never
 * touches the anchor lifecycle — it is a read/parse boundary.
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

/** The internal record a single CTDL credential node maps to. */
export interface ImportedCtdlRecord {
  /** `@type` verbatim (e.g. `ceterms:License`), or null when absent. */
  type: string | null;
  /** Resolved `ceterms:name` (language-map/@value aware), or null. */
  name: string | null;
  /** `ceterms:ctid` — the source Credential Engine identifier, or null. */
  sourceId: string | null;
  /** First org reference from `ceterms:ownedBy`, or null. */
  issuer: ImportedCtdlIssuer | null;
  /** `ceterms:dateEffective`, normalized to an ISO string, or null. */
  issuedAt: string | null;
  /** `ceterms:expirationDate`, normalized to an ISO string, or null. */
  expiresAt: string | null;
  /**
   * The status the SOURCE document claimed, normalized from
   * `ceterms:lifecycleStatusType` (or null when the source made no claim). Kept
   * distinct from `status` so the SCRUM-2599 precedence is observable: a record
   * can carry `sourceStatus: 'active'` while `status: 'expired'`.
   */
  sourceStatus: ImportedCredentialStatus | null;
  /**
   * The RECONCILED status (SCRUM-2599). Precedence, in order:
   *   1. A past `ceterms:expirationDate` (relative to the injected `now`) ALWAYS
   *      wins — the record is `expired` even if the source claims `active`. A
   *      lapsed expiry is ground truth; the source's lifecycle flag is not.
   *   2. Otherwise the normalized `sourceStatus` is used.
   *   3. With neither an expiry nor a status claim, the result is `unknown`.
   */
  status: ImportedCredentialStatus;
}

export interface ParseCtdlOptions {
  /** Injected clock for the expiration-vs-status reconciliation (never Date.now()). */
  now: Date;
}

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
  issuer: ImportedCtdlIssuerSchema.nullable(),
  issuedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
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
 * A past expiry (relative to the injected `now`) ALWAYS wins over the source's
 * lifecycle claim. See {@link ImportedCtdlRecord.status} for the full precedence.
 */
export function reconcileStatus(
  sourceStatus: ImportedCredentialStatus | null,
  expiresAt: string | null,
  now: Date,
): ImportedCredentialStatus {
  if (expiresAt) {
    const expiry = new Date(expiresAt).getTime();
    if (!Number.isNaN(expiry) && expiry <= now.getTime()) {
      // Past expiry is ground truth — overrides an "active" source claim.
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
  const issuer = resolveIssuer(node['ceterms:ownedBy']);
  const issuedAt = normalizeCtdlDate(node['ceterms:dateEffective']);
  const expiresAt = normalizeCtdlDate(node['ceterms:expirationDate']);
  const sourceStatus = normalizeLifecycleStatus(node['ceterms:lifecycleStatusType']);
  const status = reconcileStatus(sourceStatus, expiresAt, options.now);

  return ImportedCtdlRecordSchema.parse({
    type,
    name,
    sourceId,
    issuer,
    issuedAt,
    expiresAt,
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
