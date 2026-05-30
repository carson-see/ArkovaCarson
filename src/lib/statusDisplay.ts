/**
 * statusDisplay — human-readable status labels (SCRUM-2003, GA-S2 / GA UX PRD E4-S3).
 *
 * Single source of truth for turning a raw `anchor_status` or
 * `attestation_status` enum value (PENDING, SECURED, BROADCASTING, …) into a
 * user-facing label + semantic tone. Status enums are engineering jargon;
 * end users must never see the raw uppercase token.
 *
 * Design constraints:
 *  - PURE. No React, routing, Supabase, or I/O — mirrors `formatters.ts` so it
 *    is safe to reuse from any component, page, server-side test helper, or
 *    exporter. Returns a fresh object each call (no shared mutable reference).
 *  - CLAUDE.md §1.3 COMPLIANT. Every label — including the unknown-value
 *    fallback — is free of banned terms (Wallet, Gas, Hash, Block, Transaction,
 *    Crypto, Blockchain, Bitcoin, Token, …). The status enums themselves don't
 *    contain banned words, but the fallback title-cases arbitrary input, so we
 *    keep it conservative and never echo a raw enum.
 *  - FAIL-SAFE. Unknown values title-case gracefully; nullish/blank input
 *    yields an em-dash placeholder. Display can never throw.
 *
 * Label vocabulary is aligned with the GA UX PRD mapping and the pre-existing
 * `statusConfig` maps in RecordsList / MyRecordsPage / AssetDetailView:
 *   PENDING / BROADCASTING → "Processing"  (in-flight, pre-confirmation)
 *   SUBMITTED              → "Submitted"
 *   SECURED                → "Verified"
 *   REVOKED                → "Revoked"
 *   EXPIRED                → "Expired"
 *   SUPERSEDED             → "Superseded"
 *   PENDING_RESOLUTION     → "Needs Review"
 *   DRAFT (attestation)    → "Draft"
 *   ACTIVE (attestation)   → "Active"
 *   CHALLENGED (attestation) → "Challenged"
 */

/**
 * Semantic tone for badge / pill colouring. Decoupled from any specific
 * design-system variant name so callers can map it to their own palette
 * (shadcn Badge `variant`, Tailwind classes, etc.) without this module
 * depending on the UI layer.
 */
export type StatusTone = 'neutral' | 'positive' | 'warning' | 'danger';

export interface StatusDisplay {
  /** User-facing, §1.3-compliant label. Never a raw enum value. */
  label: string;
  /** Semantic tone for colouring the status indicator. */
  tone: StatusTone;
}

/** Placeholder shown for missing / blank status (matches copy.ts em-dash convention). */
const EMPTY_PLACEHOLDER = '—';

/**
 * Generic, §1.3-safe label used when an UNKNOWN status's title-cased fallback
 * would otherwise surface a banned term (e.g. a hypothetical future enum value
 * containing "TOKEN", "BLOCK", or "HASH"). Known statuses never hit this path.
 */
const SAFE_UNKNOWN_LABEL = 'Unknown Status';

/**
 * §1.3 banned-term detectors applied to the unknown-value fallback ONLY.
 *
 * These are a deliberate SUPERSET of the canonical copy-lint matchers in
 * `scripts/check-copy-terms.ts` (`FORBIDDEN_TERMS`), replicated locally so this
 * module keeps its zero-dependency / browser-safe purity (importing that script
 * would drag `node:fs`/`node:path` into the client bundle).
 *
 * Match semantics are kept BYTE-FOR-BYTE equivalent to the canonical terms so
 * the fallback can never emit a substring the canonical rule would flag:
 *  - `wallet`, `gas`, `transaction`, `crypto`/`cryptocurrency`, `bitcoin`,
 *    `blockchain`, `mining` are canonically BARE substrings (no boundaries),
 *    so an input like `GASEOUS` / `TRANSACTIONAL` / `WALLETED` /
 *    `CRYPTOGRAPHIC_PENDING` IS a violation and is scrubbed. A naive `\b`-only
 *    fallback used to let these through.
 *  - `hash`, `block` (incl. `block height`/`block hash`) and `token` carry the
 *    canonical `(?<![-\w])…(?![-\w])` boundaries, so e.g. `BLOCKADE` is NOT a
 *    violation and survives as a normal title-cased label — matching the lint.
 *
 * Infra-leak patterns from the canonical list (`worker service`,
 * `service_role`, `postgrest`, `issue credential`) are omitted: they contain
 * spaces/underscores that title-casing an UPPER_SNAKE status token can never
 * reproduce as user-visible copy.
 */
const FALLBACK_BANNED_PATTERNS: readonly RegExp[] = [
  // --- bare substrings (canonical: no boundaries) ---
  /wallet/i,
  /gas/i,
  /transaction/i,
  /crypto/i, // also covers `cryptocurrency`
  /bitcoin/i,
  /blockchain/i,
  /mining/i,
  // --- boundary-bounded (canonical: (?<![-\w])…(?![-\w])) ---
  /(?<![-\w])block height(?![-\w])/i,
  /(?<![-\w])block hash(?![-\w])/i,
  /(?<![-\w])hash(?![-\w])/i,
  /(?<![-\w])block(?![-\w])/i,
  /(?<![-\w])token(?![-\w])/i,
];

/** True when a candidate fallback label would surface a §1.3 banned term. */
function containsBannedTerm(label: string): boolean {
  return FALLBACK_BANNED_PATTERNS.some((re) => re.test(label));
}

/**
 * Canonical mapping keyed by the normalised (UPPER_SNAKE) status token.
 * Anchor and attestation statuses share this table — overlapping keys
 * (PENDING, REVOKED, EXPIRED) intentionally resolve to the same display so a
 * record and an attestation read consistently.
 */
const STATUS_MAP: Readonly<Record<string, StatusDisplay>> = Object.freeze({
  // --- anchor_status ---
  PENDING: { label: 'Processing', tone: 'neutral' },
  BROADCASTING: { label: 'Processing', tone: 'neutral' },
  SUBMITTED: { label: 'Submitted', tone: 'neutral' },
  SECURED: { label: 'Verified', tone: 'positive' },
  REVOKED: { label: 'Revoked', tone: 'danger' },
  EXPIRED: { label: 'Expired', tone: 'warning' },
  SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
  PENDING_RESOLUTION: { label: 'Needs Review', tone: 'warning' },

  // --- attestation_status (DRAFT / ACTIVE / CHALLENGED are attestation-only;
  // PENDING / REVOKED / EXPIRED reuse the anchor entries above) ---
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'positive' },
  CHALLENGED: { label: 'Challenged', tone: 'warning' },
});

/** Normalise a raw status to the UPPER_SNAKE lookup key. */
function normalizeKey(raw: string): string {
  return raw.trim().replace(/-/g, '_').toUpperCase();
}

/**
 * Title-case a normalised key for the unknown-value fallback, e.g.
 * `AWAITING_SIGNATURE` → "Awaiting Signature". Conservative by construction:
 * it only ever reformats the input's own words, and the status enums in this
 * codebase contain no §1.3 banned terms — so the fallback can never surface
 * one for a real enum, and the banned-term test pins it for adversarial input.
 */
function titleCaseFallback(normalizedKey: string): string {
  return normalizedKey
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Map a raw anchor/attestation status to a human-readable label + tone.
 *
 * @param status Raw enum value (any case, hyphen or underscore separated),
 *               or null/undefined.
 * @returns A fresh `{ label, tone }`. Unknown values title-case safely;
 *          nullish/blank input yields `{ label: '—', tone: 'neutral' }`.
 */
export function getStatusDisplay(status: string | null | undefined): StatusDisplay {
  if (status == null) {
    return { label: EMPTY_PLACEHOLDER, tone: 'neutral' };
  }

  const key = normalizeKey(status);
  if (key.length === 0) {
    return { label: EMPTY_PLACEHOLDER, tone: 'neutral' };
  }

  const known = STATUS_MAP[key];
  if (known) {
    // Spread to hand back a fresh object — callers never share the frozen one.
    return { label: known.label, tone: known.tone };
  }

  // Unknown value: title-case it, but never let a §1.3 banned term leak through
  // the generic fallback path.
  const fallback = titleCaseFallback(key);
  return {
    label: containsBannedTerm(fallback) ? SAFE_UNKNOWN_LABEL : fallback,
    tone: 'neutral',
  };
}

/**
 * Convenience wrapper returning only the label. Equivalent to
 * `getStatusDisplay(status).label`.
 */
export function getStatusLabel(status: string | null | undefined): string {
  return getStatusDisplay(status).label;
}
