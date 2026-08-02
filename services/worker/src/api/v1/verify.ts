/**
 * GET /api/v1/verify/:publicId (P4.5-TS-01)
 *
 * Public anchor verification by publicId. Returns the frozen verification
 * response schema (CLAUDE.md Section 10).
 *
 * This endpoint accepts a publicId (e.g., ARK-2026-TEST-001), NOT a
 * fingerprint. For fingerprint-based verification, use POST /api/verify-anchor.
 */

import { Router, type Request } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { buildVerifyUrl } from '../../lib/urls.js';
import { FERPA_EDUCATION_TYPES, FERPA_REDISCLOSURE_NOTICE } from '../../constants/ferpa.js';
import { getCachedVerification, setCachedVerification } from '../../utils/verifyCache.js';
import { dispatchWebhookEvent } from '../../webhooks/delivery.js';
// Imported from the GUARD, not from `ctdl-serializer.js`, on purpose: the guard
// is deliberately dependency-free (see its header) so a non-CTDL path can reuse
// the detectors without pulling the whole CTDL serializer onto this hot,
// anonymous verification path.
import { isEducationCredentialType } from '../../ctdl/ctdl-pii-guard.js';
// The value layer itself lives in `public-projection-text.ts` so `verify.ts`
// and `provenance.ts` share ONE copy — two copies of the wrapper is the same
// drift the contract exists to prevent.
import { publicFreeTextOrNull } from './public-projection-text.js';

const router = Router();

// ---------------------------------------------------------------------------
// Outbound PII gate — the THIRD public projection of an anchor row.
//
// `router.ts` allows anonymous GET on this route
// (`if (!req.apiKey && req.method === 'GET') next()`), so everything
// `buildVerificationResult` emits is public. Two sibling projections of the
// SAME rows were hardened first and this one was missed:
//
//   * SQL  — `public.get_public_anchor` (migration 0385, PR #1841), anon-GRANTed
//            and called from the browser over PostgREST.
//   * CTDL — `services/worker/src/ctdl/ctdl-pii-guard.ts` (PR #1815), behind
//            `GET /api/v1/credentials/:publicId/ctdl`.
//
// Both apply the same two-layer rule; this file now applies it too. The shared
// statement of the rule is `scripts/ci/public-pii-projection-contract.json`.
//
// ── THE POLICY DECISION ────────────────────────────────────────────────────
//
// Academic-record suppression here is UNCONDITIONAL, matching the other two —
// it is deliberately NOT gated on `directory_info_opt_out`. Three reasons:
//
//   1. Opt-out means the DEFAULT IS PUBLISH, and default-publish is the defect
//      class this work exists to close. `directory_info_opt_out` defaults to
//      `false`, so before this change every learner's description shipped
//      unless an institution had explicitly set a flag.
//   2. `description` was not gated by the opt-out ANYWAY. The REG-02 block
//      below suppresses issuer/recipient/dates; `description` was emitted raw
//      underneath it, so even an opted-out learner was exposed on this route.
//   3. One row, three anonymous projections, three different answers is not a
//      privacy posture. The verify page (browser) already reads the SQL path,
//      which suppresses; the API disagreeing with the page it serves is the
//      drift itself.
//
// The cost is real and bounded: an issuer-authored description no longer ships
// on an academic record for anyone. It already does not ship on the other two
// public projections, so no consumer loses access to data it could still get
// publicly elsewhere.
//
// `FERPA_EDUCATION_TYPES` is NOT reused for this and is NOT edited. It carries
// a fourth member (`CLE`) and drives the FERPA §99.33 re-disclosure NOTICE plus
// the §99.37 directory-information opt-out — different jobs from free-text
// suppression, and a continuing-legal-education record is a practitioner
// record whose descriptive title is the partner-facing value. The academic set
// comes from the guard's `EDUCATION_CREDENTIAL_TYPES`. Two lists, two purposes,
// both pinned by the contract test.
//
// ── OMISSION, NOT FAIL-CLOSED ──────────────────────────────────────────────
//
// The CTDL path 404s on a PII hit because its body is a PUBLICATION. This body
// is a VERIFICATION ANSWER: refusing it would tell an anonymous verifier that a
// genuinely anchored document does not exist, in exchange for nothing — the
// verification-bearing fields (fingerprint, chain receipt, status, block) carry
// no free text. Dropping the FIELD contains the leak while the answer survives.
//
// ── NO LEARNER-NAME HEURISTIC ──────────────────────────────────────────────
//
// `containsLearnerNamePii` is deliberately NOT imported. Measured in PR #1815
// and again for migration 0385: the capitalised-pair patterns detect NONE of
// the real leak shapes (bare, all-caps, non-ASCII, apostrophe, hyphenated) while
// `for` as a bare preposition drops "Center for Professional Development",
// "Society for Human Resource Management", "Ethics for Trial Lawyers" and more.
// Zero measured true positives, abundant measured false positives. Learner names
// are covered STRUCTURALLY here — an academic record emits no issuer- or
// extraction-authored free text at all, which is precision-independent.
// ---------------------------------------------------------------------------

/**
 * API-RICH string keys exempt from the value gate.
 *
 * An ALLOW-list, and the gate FAILS CLOSED against it: any string-valued
 * API-RICH key NOT named here routes through `publicFreeTextOrNull`, so a
 * future additive field is gated by default instead of shipping raw because
 * nobody remembered. (Recognising danger fails open; recognising safety fails
 * closed — the same inversion `$structural_keys_note` records in the contract.)
 *
 * These three are opaque or structural: a chain transaction id, an
 * Arkova-issued public id, and a closed enum. None can carry issuer- or
 * extraction-authored prose.
 */
const STRUCTURAL_API_RICH_KEYS: ReadonlySet<string> = new Set([
  'parent_public_id',
  'revocation_tx_id',
  'fingerprint_source',
]);

/** Full frozen schema result per CLAUDE.md Section 10 */
export interface VerificationResult {
  verified: boolean;
  status?: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED' | 'EXPIRED' | 'PENDING' | 'SUBMITTED';
  issuer_name?: string;
  recipient_identifier?: string;
  credential_type?: string;
  issued_date?: string | null;
  expiry_date?: string | null;
  anchor_timestamp?: string;
  bitcoin_block?: number | null;
  network_receipt_id?: string | null;
  merkle_proof_hash?: string | null;
  record_uri?: string;
  jurisdiction?: string;
  /** BETA-11: Deep link to network explorer (additive, nullable — Constitution 1.8) */
  explorer_url?: string;
  /** BETA-12: Immutable description (additive, nullable — Constitution 1.8) */
  description?: string;
  /** REG-03: FERPA re-disclosure notice for education credential types (additive, nullable — Constitution 1.8) */
  ferpa_notice?: string;
  /** REG-02: Indicates directory-level fields were suppressed per FERPA Section 99.37 opt-out (additive, nullable — Constitution 1.8) */
  directory_info_suppressed?: boolean;
  // API-RICH-01 (SCRUM-772, 2026-04-16): 8 additive nullable fields that surface
  // already-stored data for GRC platform + SDK consumers. All additions per
  // Constitution 1.8 (frozen schema allows additive nullables).
  /** Regulatory control IDs (SOC 2 / FERPA / HIPAA / GDPR / ISO) — populated by CML-02 (migration 0137). */
  compliance_controls?: Record<string, unknown> | null;
  /** Bitcoin block confirmations at anchor time. */
  chain_confirmations?: number | null;
  /** Public ID of the parent anchor (credential lineage). Resolved from internal UUID — Constitution 1.4. */
  parent_public_id?: string | null;
  /** Version in the lineage; defaults to 1 (omitted from response in the default case). */
  version_number?: number | null;
  /** Revocation TX id when status = REVOKED. */
  revocation_tx_id?: string | null;
  /** Revocation block height when status = REVOKED. */
  revocation_block_height?: number | null;
  /** Source document MIME type — client-side metadata only per Constitution 1.6. */
  file_mime?: string | null;
  /** Source document size in bytes — client-side metadata only. */
  file_size?: number | null;
  // API-RICH-02 (SCRUM-895): per-field AI confidence + GRE-01 sub-type.
  /** Per-field confidence + overall + grounding from the latest extraction manifest. */
  confidence_scores?: Record<string, unknown> | null;
  /** GRE-01 fine-grained credential sub-type (e.g., 'official_undergraduate'). */
  sub_type?: string | null;
  /**
   * R19 (CTO ruling 2026-07-28, advances SCRUM-2481): evidence class for how
   * `fingerprint` was computed. 'document_bytes' = a real file's bytes were
   * fingerprinted client-side (Constitution 1.6). 'issuer_record_attestation'
   * = no source document was supplied; the issuer's asserted record content
   * was fingerprinted. null = unclassified (anchor predates migration 0376;
   * never guessed, Constitution 1.5). Additive nullable — Constitution 1.8.
   */
  fingerprint_source?: 'document_bytes' | 'issuer_record_attestation' | null;
  error?: string;
}

function mapStatus(status: string): VerificationResult['status'] {
  switch (status) {
    case 'SECURED':
    case 'ACTIVE':
      return 'ACTIVE';
    case 'REVOKED':
      return 'REVOKED';
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'PENDING':
      return 'PENDING';
    case 'SUBMITTED':
      return 'SUBMITTED';
    default:
      return undefined;
  }
}

/**
 * Lookup anchor by publicId from the database.
 * Injectable for testing.
 */
export interface PublicIdLookup {
  lookupByPublicId(publicId: string): Promise<AnchorByPublicId | null>;
}

export interface AnchorByPublicId {
  public_id: string;
  fingerprint: string;
  status: string;
  /**
   * Internal-only: org owning this anchor. Used for credential.verified
   * webhook dispatch routing (SCRUM-1799). MUST NOT be copied into
   * VerificationResult — buildVerificationResult uses explicit field
   * allowlist, so this field stays internal by construction. CLAUDE.md §6.
   * Optional so existing test fixtures (~30 across the suite) don't all
   * need updates; production lookups (defaultLookup, oracle.ts) always
   * populate it.
   */
  org_id?: string | null;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  created_at: string;
  credential_type: string | null;
  org_name: string | null;
  recipient_hash: string | null;
  issued_at: string | null;
  expires_at: string | null;
  jurisdiction: string | null;
  merkle_root: string | null;
  /** BETA-12: Immutable description */
  description: string | null;
  /** REG-02: FERPA Section 99.37 directory info opt-out */
  directory_info_opt_out: boolean;
  /** API-RICH-01: Regulatory control IDs (SOC 2 / FERPA / HIPAA / GDPR / ISO) */
  compliance_controls: Record<string, unknown> | null;
  /** API-RICH-01: Bitcoin block confirmations at anchor time */
  chain_confirmations: number | null;
  /** API-RICH-01: Parent anchor PUBLIC ID (resolved from internal UUID — never expose UUID) */
  parent_public_id: string | null;
  /** API-RICH-01: Version in lineage; defaults to 1 */
  version_number: number | null;
  /** API-RICH-01: Revocation TX id when status = REVOKED */
  revocation_tx_id: string | null;
  /** API-RICH-01: Revocation block height when status = REVOKED */
  revocation_block_height: number | null;
  /** API-RICH-01: Source document MIME type (client-side metadata only) */
  file_mime: string | null;
  /** API-RICH-01: Source document size in bytes */
  file_size: number | null;
  /** API-RICH-02 (SCRUM-895): Per-field AI confidence from latest extraction_manifests row. */
  confidence_scores: Record<string, unknown> | null;
  /** API-RICH-02 (SCRUM-895): Fine-grained sub-type from anchors.sub_type (GRE-01). */
  sub_type: string | null;
  /** R19: fingerprint evidence class from anchors.fingerprint_source (migration 0376). */
  fingerprint_source: string | null;
}

/**
 * Core verification logic — extracted for testability.
 */
export function buildVerificationResult(anchor: AnchorByPublicId): VerificationResult {
  const publicStatus = mapStatus(anchor.status);
  const isVerified = anchor.status === 'SECURED' || anchor.status === 'ACTIVE';

  const result: VerificationResult = {
    verified: isVerified,
    status: publicStatus,
    anchor_timestamp: anchor.created_at,
    bitcoin_block: anchor.chain_block_height ?? null,
    network_receipt_id: anchor.chain_tx_id ?? null,
    merkle_proof_hash: anchor.merkle_root ?? null,
    record_uri: buildVerifyUrl(anchor.public_id),
  };

  // REG-02: When directory_info_opt_out is true for education types,
  // suppress directory-level fields (name, degree type, dates) per FERPA Section 99.37
  const isEducationType = anchor.credential_type &&
    (FERPA_EDUCATION_TYPES as readonly string[]).includes(anchor.credential_type);
  const suppressDirectory = anchor.directory_info_opt_out && isEducationType;

  // Structural layer: an ACADEMIC RECORD (a record about an identified learner)
  // emits no issuer- or extraction-authored free text. Unconditional — see the
  // policy note above. Distinct from `isEducationType`, which is the wider
  // FERPA notice/opt-out set and additionally includes CLE.
  const isAcademicRecord = isEducationCredentialType(anchor.credential_type);

  if (anchor.credential_type) {
    result.credential_type = anchor.credential_type;
  }
  // The issuer is an INSTITUTION, not the learner, so it is cleaned rather than
  // structurally suppressed — deliberate parity with migration 0385's
  // `issuer_name` handling. The REG-02 opt-out still hides it as directory info.
  const issuerName = publicFreeTextOrNull(anchor.org_name);
  if (issuerName && !suppressDirectory) {
    result.issuer_name = issuerName;
  }
  if (anchor.recipient_hash && !suppressDirectory) {
    result.recipient_identifier = anchor.recipient_hash;
  }
  if (anchor.issued_at !== undefined && !suppressDirectory) {
    result.issued_date = anchor.issued_at;
  }
  if (anchor.expires_at !== undefined && !suppressDirectory) {
    result.expiry_date = anchor.expires_at;
  }
  // Frozen schema: omit jurisdiction when null, never return null.
  // Value-gated but not academically suppressed — an informational
  // jurisdiction tag (§1.5) is not a statement about the learner. Matches 0385.
  const jurisdiction = publicFreeTextOrNull(anchor.jurisdiction);
  if (jurisdiction) {
    result.jurisdiction = jurisdiction;
  }
  // BETA-11: explorer URL (additive, nullable — Constitution 1.8)
  if (anchor.chain_tx_id && /^[a-fA-F0-9]+$/.test(anchor.chain_tx_id)) {
    const network = config.bitcoinNetwork;
    const baseMap: Record<string, string> = {
      testnet4: 'https://mempool.space/testnet4',
      testnet: 'https://mempool.space/testnet',
      signet: 'https://mempool.space/signet',
      mainnet: 'https://mempool.space',
    };
    const base = baseMap[network] ?? baseMap.signet;
    result.explorer_url = `${base}/tx/${anchor.chain_tx_id}`;
  }
  // BETA-12: description (additive, nullable — Constitution 1.8).
  //
  // THE LEAK THIS FIXES: `anchor.description` shipped RAW here, to an anonymous
  // caller, for every credential type — including the three the other two
  // public projections suppress outright. It was not even covered by the
  // REG-02 opt-out above.
  //
  // Academic record  -> omitted entirely (structural).
  // Everything else  -> value-gated, same as the other two projections.
  if (!isAcademicRecord) {
    const description = publicFreeTextOrNull(anchor.description);
    if (description) {
      result.description = description;
    }
  }

  // REG-02: Signal when directory info was suppressed
  if (suppressDirectory) {
    result.directory_info_suppressed = true;
  }

  // REG-03: FERPA re-disclosure notice for education credential types
  if (anchor.credential_type && (FERPA_EDUCATION_TYPES as readonly string[]).includes(anchor.credential_type)) {
    result.ferpa_notice = FERPA_REDISCLOSURE_NOTICE;
  }

  // API-RICH-01: Surface already-stored fields for GRC platforms + SDK consumers.
  // All backwards-compat nullable per Constitution 1.8. `version_number === 1` (the
  // default / no-lineage case) is omitted to keep the common-case payload lean.
  const API_RICH_KEYS = [
    'compliance_controls',
    'chain_confirmations',
    'parent_public_id',
    'revocation_tx_id',
    'revocation_block_height',
    'file_mime',
    'file_size',
    'confidence_scores',
    'sub_type',
    'fingerprint_source',
  ] as const;
  for (const key of API_RICH_KEYS) {
    const v = anchor[key];
    if (v === null || v === undefined || v === '') continue;
    // Every STRING here is issuer- or extraction-authored unless the allow-list
    // says otherwise. `sub_type` is bare `text` in the schema (no CHECK, no
    // enum) and `file_mime` is client-supplied, so both are gated; the numeric
    // and jsonb members (`chain_confirmations`, `file_size`,
    // `compliance_controls`, `confidence_scores`) carry no free text and pass
    // through untouched.
    if (typeof v === 'string' && !STRUCTURAL_API_RICH_KEYS.has(key)) {
      const safe = publicFreeTextOrNull(v);
      if (safe) (result as unknown as Record<string, unknown>)[key] = safe;
      continue;
    }
    (result as unknown as Record<string, unknown>)[key] = v;
  }
  if (
    anchor.version_number !== null &&
    anchor.version_number !== undefined &&
    anchor.version_number !== 1
  ) {
    result.version_number = anchor.version_number;
  }

  return result;
}

/**
 * Default shape for the 8 API-RICH-01 fields on a bare `AnchorByPublicId`.
 * Used by endpoints that don't hydrate rich fields (e.g. the oracle batch endpoint) so
 * adding a new rich field only requires touching this constant + the interface.
 */
export const EMPTY_API_RICH_FIELDS = {
  compliance_controls: null,
  chain_confirmations: null,
  parent_public_id: null,
  version_number: null,
  revocation_tx_id: null,
  revocation_block_height: null,
  file_mime: null,
  file_size: null,
  confidence_scores: null,
  sub_type: null,
  fingerprint_source: null,
} as const;

/** Fire-and-forget audit log for verification queries */

function logVerificationAudit(
  req: Request,
  publicId: string,
  result: VerificationResult,
  cacheHit: boolean,
  credentialVerifiedDispatched: boolean | null = null,
  credentialVerifiedDispatchError: string | null = null,
): void {
  // eslint-disable-next-line arkova/missing-org-filter -- anonymous public verification endpoint, no org context for the querier
  void db.from('audit_events').insert({
    event_type: 'VERIFICATION_QUERIED',
    event_category: 'ANCHOR',
    target_type: 'anchor',
    target_id: publicId,
    details: JSON.stringify({
      verified: result.verified,
      status: result.status,
      credential_type: result.credential_type ?? null,
      querying_ip: req.ip ?? null,
      querying_agent: req.headers?.['user-agent']?.substring(0, 200) ?? null,
      api_key_id: (req as unknown as Record<string, unknown>).apiKeyId ?? null,
      ...(cacheHit && { cache_hit: true }),
      // SCRUM-1799 (SCRUM-1743 Phase 2b): record whether the credential.verified
      // webhook was dispatched on this verify call. `null` means the emit code
      // path was not exercised (cache hit, flag off, or non-terminal status);
      // `true`/`false` mean the dispatch was attempted with the recorded outcome.
      ...(credentialVerifiedDispatched !== null && {
        credential_verified_dispatched: credentialVerifiedDispatched,
      }),
      ...(credentialVerifiedDispatchError && {
        credential_verified_dispatch_error: credentialVerifiedDispatchError,
      }),
    }),
  });
}

/** Single embedded `anchor_proofs` row (merkle_root lives here, not on anchors). */
interface AnchorProofEmbed {
  merkle_root: string | null;
}

/**
 * Shape returned by the Supabase nested select in defaultLookup (not yet in
 * generated types).
 *
 * NOTE on jurisdiction + merkle_root: neither is a top-level `anchors` column.
 * `merkle_root` lives on `anchor_proofs.merkle_root` (1:1 via
 * `anchor_proofs_anchor_unique`), with a legacy `metadata->>'merkle_root'`
 * fallback. `jurisdiction` lives in `anchors.metadata->>'jurisdiction'`. The
 * embed may surface as a single object or a one-element array depending on how
 * PostgREST resolves the to-one relationship, so `anchor_proofs` accepts both.
 */
export interface AnchorSelectRow {
  public_id: string;
  fingerprint: string;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  chain_timestamp: string | null;
  created_at: string;
  credential_type: string | null;
  sub_type: string | null;
  issued_at: string | null;
  expires_at: string | null;
  description: string | null;
  directory_info_opt_out: boolean;
  compliance_controls: Record<string, unknown> | null;
  chain_confirmations: number | null;
  version_number: number | null;
  revocation_tx_id: string | null;
  revocation_block_height: number | null;
  file_mime: string | null;
  file_size: number | null;
  org_id: string | null;
  /** R19: fingerprint evidence class (migration 0376). */
  fingerprint_source: string | null;
  /** anchors.metadata JSONB — source of jurisdiction + legacy merkle_root. */
  metadata: Record<string, unknown> | null;
  organization: { display_name: string } | null;
  parent: { public_id: string } | null;
  /** Embedded anchor_proofs (single object or one-element array, or null). */
  anchor_proofs: AnchorProofEmbed | AnchorProofEmbed[] | null;
  extraction_manifests: Array<{
    confidence_scores: Record<string, unknown> | null;
    extraction_timestamp: string;
  }>;
}

/** Reads `merkle_root` from the joined anchor_proofs embed (object or array),
 *  falling back to the legacy `metadata.merkle_root` string. Returns null when
 *  neither source carries a string value. */
function resolveMerkleRoot(row: AnchorSelectRow): string | null {
  const proofs = row.anchor_proofs;
  const proofRows = Array.isArray(proofs) ? proofs : proofs ? [proofs] : [];
  for (const proof of proofRows) {
    if (typeof proof?.merkle_root === 'string' && proof.merkle_root.length > 0) {
      return proof.merkle_root;
    }
  }
  const legacy = row.metadata?.merkle_root;
  return typeof legacy === 'string' && legacy.length > 0 ? legacy : null;
}

/** Reads `jurisdiction` from anchors.metadata JSONB (informational tag,
 *  Constitution 1.5). Returns null for missing or non-string values. */
function resolveJurisdiction(row: AnchorSelectRow): string | null {
  const value = row.metadata?.jurisdiction;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pure mapping from a DB select row to the public-safe AnchorByPublicId.
 * Exported for unit testing. Uses an explicit field allowlist — internal-only
 * columns (anchors.id, org_id beyond webhook routing) are never copied into the
 * public response by construction (Constitution 1.4 / §6).
 */
export function mapAnchorRow(row: AnchorSelectRow): AnchorByPublicId {
  const manifests = row.extraction_manifests ?? [];
  const latestManifest = manifests.length === 0
    ? null
    : manifests
        .slice()
        .sort((a, b) => (a.extraction_timestamp < b.extraction_timestamp ? 1 : -1))[0];

  return {
    public_id: row.public_id ?? '',
    fingerprint: row.fingerprint,
    status: row.status,
    org_id: row.org_id ?? null,
    chain_tx_id: row.chain_tx_id ?? null,
    chain_block_height: row.chain_block_height ?? null,
    chain_timestamp: row.chain_timestamp ?? null,
    created_at: row.created_at,
    credential_type: row.credential_type ?? null,
    org_name: row.organization?.display_name ?? null,
    recipient_hash: null,
    issued_at: row.issued_at ?? null,
    expires_at: row.expires_at ?? null,
    jurisdiction: resolveJurisdiction(row),
    merkle_root: resolveMerkleRoot(row),
    description: row.description ?? null,
    directory_info_opt_out: row.directory_info_opt_out ?? false,
    compliance_controls: row.compliance_controls ?? null,
    chain_confirmations: row.chain_confirmations ?? null,
    parent_public_id: row.parent?.public_id ?? null,
    version_number: row.version_number ?? null,
    revocation_tx_id: row.revocation_tx_id ?? null,
    revocation_block_height: row.revocation_block_height ?? null,
    file_mime: row.file_mime ?? null,
    file_size: row.file_size ?? null,
    confidence_scores: latestManifest?.confidence_scores ?? null,
    sub_type: row.sub_type ?? null,
    fingerprint_source: row.fingerprint_source ?? null,
  };
}

/** Default DB-backed lookup — single JOIN for orgName + parent public_id to avoid N+1 on hot path */
const defaultLookup: PublicIdLookup = {
  async lookupByPublicId(publicId: string) {
    const { data, error } = await db
      .from('anchors')
      .select(
        'public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, created_at, ' +
          'credential_type, sub_type, issued_at, expires_at, description, directory_info_opt_out, ' +
          'compliance_controls, chain_confirmations, version_number, ' +
          'revocation_tx_id, revocation_block_height, file_mime, file_size, ' +
          'org_id, fingerprint_source, metadata, ' +
          'organization:org_id(display_name), parent:parent_anchor_id(public_id), ' +
          'anchor_proofs(merkle_root), ' +
          'extraction_manifests(confidence_scores, extraction_timestamp)',
      )
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;

    return mapAnchorRow(data as unknown as AnchorSelectRow);
  },
};

/**
 * GET /api/v1/verify/:publicId
 */
router.get('/:publicId', async (req, res) => {
  const { publicId } = req.params;

  if (!publicId || publicId.length < 3) {
    res.status(400).json({
      verified: false,
      error: 'Invalid publicId parameter',
    });
    return;
  }

  try {
    // PERF-12: Check Redis cache first
    const cached = await getCachedVerification<VerificationResult>(publicId);
    if (cached) {
      logVerificationAudit(req, publicId, cached, true);
      res.json(cached);
      return;
    }

    const lookup = (req as unknown as { _testLookup?: PublicIdLookup })._testLookup ?? defaultLookup;
    const anchor = await lookup.lookupByPublicId(publicId);

    if (!anchor) {
      res.status(404).json({
        verified: false,
        error: 'Record not found',
      });
      return;
    }

    const result = buildVerificationResult(anchor);

    // PERF-12: Cache the result (fire-and-forget)
    void setCachedVerification(publicId, result);

    // SCRUM-1799 (SCRUM-1743 Phase 2b): emit `credential.verified` on cache miss
    // when the anchor has resolved to a terminal status. Best-effort — never
    // aborts the response (the verification answer is already authoritative).
    //
    // Scale safety: this branch only runs on cache MISS (cache hit path
    // returns early at line ~363). Cache TTL (verifyCache.ts) provides natural
    // per-anchor sampling — repeat verifies within the TTL window skip emit.
    //
    // Default-OFF feature flag: ENABLE_CREDENTIAL_VERIFIED_WEBHOOK lets Carson
    // ramp up the producer in staging before exposing customer endpoints to
    // verify-call traffic. Schema accepts SECURED / REVOKED / EXPIRED only;
    // ACTIVE maps to SECURED (anchor.status === 'ACTIVE' is the v1 alias).
    let credentialVerifiedDispatched: boolean | null = null;
    let credentialVerifiedDispatchError: string | null = null;
    if (
      config.enableCredentialVerifiedWebhook
      && anchor.org_id
      && anchor.public_id
    ) {
      const terminalStatus =
        anchor.status === 'SECURED' || anchor.status === 'ACTIVE' ? 'SECURED'
        : anchor.status === 'REVOKED' ? 'REVOKED'
        : anchor.status === 'EXPIRED' ? 'EXPIRED'
        : null;
      if (terminalStatus) {
        try {
          await dispatchWebhookEvent(anchor.org_id, 'credential.verified', anchor.public_id, {
            public_id: anchor.public_id,
            credential_type: anchor.credential_type ?? 'OTHER',
            status: terminalStatus,
            verified_at: new Date().toISOString(),
            // verifier_country requires a GEO provider; not yet wired.
            // Schema accepts null/missing; revisit when GEO lookup lands.
          });
          credentialVerifiedDispatched = true;
        } catch (webhookError) {
          credentialVerifiedDispatched = false;
          credentialVerifiedDispatchError = webhookError instanceof Error
            ? webhookError.message
            : String(webhookError);
          logger.warn(
            { publicId: anchor.public_id, error: webhookError },
            'Failed to dispatch credential.verified webhook (response NOT aborted)',
          );
        }
      }
    }

    // SCRUM-1799: enrich the existing VERIFICATION_QUERIED audit row with the
    // credential.verified dispatch outcome. We log the audit AFTER the emit so
    // the row records the actual dispatch result, not just the decision to
    // emit. Fire-and-forget — never blocks the response.
    logVerificationAudit(
      req,
      anchor.public_id,
      result,
      false,
      credentialVerifiedDispatched,
      credentialVerifiedDispatchError,
    );

    res.json(result);
  } catch (err) {
    logger.error({ error: err, publicId }, 'Verification lookup failed');
    res.status(500).json({
      verified: false,
      error: 'Internal server error',
    });
  }
});

export { router as verifyRouter };
