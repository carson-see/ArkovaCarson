/**
 * GET /api/v1/verify/:publicId (P4.5-TS-01)
 *
 * Public anchor verification by publicId. Returns the frozen verification
 * response schema (CLAUDE.md Section 10).
 *
 * This endpoint accepts a publicId (e.g., ARK-2026-TEST-001), NOT a
 * fingerprint. For fingerprint-based verification, use POST /api/verify-anchor.
 */

import { Router } from 'express';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { buildVerifyUrl } from '../../lib/urls.js';
import { FERPA_EDUCATION_TYPES, FERPA_REDISCLOSURE_NOTICE } from '../../constants/ferpa.js';
import { getCachedVerification, setCachedVerification } from '../../utils/verifyCache.js';

const router = Router();

/** Full frozen schema result per CLAUDE.md Section 10 */
export interface VerificationResult {
  verified: boolean;
  status?: 'ACTIVE' | 'REVOKED' | 'SUPERSEDED' | 'EXPIRED' | 'PENDING';
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
  /**
   * API-RICH-01 (SCRUM-772 / 2026-04-16): Regulatory control IDs mapped to this anchor
   * (SOC 2, FERPA, HIPAA, GDPR, ISO 27001 control tags). Stored in `anchors.compliance_controls`
   * by CML-02 (migration 0137). Enables GRC platform integration (Vanta, Drata, Anecdotes).
   * Additive, nullable — Constitution 1.8.
   */
  compliance_controls?: Record<string, unknown> | null;
  /**
   * API-RICH-01: Number of Bitcoin block confirmations at anchor time. Stored in
   * `anchors.chain_confirmations`. Useful for maturity checks ("6-confirmed?").
   * Additive, nullable — Constitution 1.8.
   */
  chain_confirmations?: number | null;
  /**
   * API-RICH-01: Public ID of this anchor's parent (credential lineage — reissued diploma,
   * amended license, etc.). Resolved from `anchors.parent_anchor_id` UUID → parent's public_id
   * so we never leak internal anchor UUIDs (Constitution 1.4).
   * Additive, nullable — Constitution 1.8.
   */
  parent_public_id?: string | null;
  /**
   * API-RICH-01: Version number within a lineage. Defaults to 1 for originals.
   * Stored in `anchors.version_number`. Additive, nullable — Constitution 1.8.
   */
  version_number?: number | null;
  /**
   * API-RICH-01: Bitcoin transaction ID of the revocation (when status = REVOKED).
   * Stored in `anchors.revocation_tx_id`. Additive, nullable — Constitution 1.8.
   */
  revocation_tx_id?: string | null;
  /**
   * API-RICH-01: Bitcoin block height at which revocation was anchored.
   * Stored in `anchors.revocation_block_height`. Additive, nullable — Constitution 1.8.
   */
  revocation_block_height?: number | null;
  /**
   * API-RICH-01: MIME type of the source document (client-side metadata — Constitution 1.6).
   * Stored in `anchors.file_mime`. Additive, nullable — Constitution 1.8.
   */
  file_mime?: string | null;
  /**
   * API-RICH-01: Size of the source document in bytes (client-side metadata — Constitution 1.6).
   * Stored in `anchors.file_size`. Additive, nullable — Constitution 1.8.
   */
  file_size?: number | null;
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

  if (anchor.credential_type) {
    result.credential_type = anchor.credential_type;
  }
  if (anchor.org_name && !suppressDirectory) {
    result.issuer_name = anchor.org_name;
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
  // Frozen schema: omit jurisdiction when null, never return null
  if (anchor.jurisdiction) {
    result.jurisdiction = anchor.jurisdiction;
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
  // BETA-12: description (additive, nullable — Constitution 1.8)
  if (anchor.description) {
    result.description = anchor.description;
  }

  // REG-02: Signal when directory info was suppressed
  if (suppressDirectory) {
    result.directory_info_suppressed = true;
  }

  // REG-03: FERPA re-disclosure notice for education credential types
  if (anchor.credential_type && (FERPA_EDUCATION_TYPES as readonly string[]).includes(anchor.credential_type)) {
    result.ferpa_notice = FERPA_REDISCLOSURE_NOTICE;
  }

  // API-RICH-01 (2026-04-16): Surface already-stored fields that GRC platforms,
  // downstream SDK callers, and auditors need. All nullable / additive — Constitution 1.8.
  if (anchor.compliance_controls !== null && anchor.compliance_controls !== undefined) {
    result.compliance_controls = anchor.compliance_controls;
  }
  if (anchor.chain_confirmations !== null && anchor.chain_confirmations !== undefined) {
    result.chain_confirmations = anchor.chain_confirmations;
  }
  if (anchor.parent_public_id) {
    result.parent_public_id = anchor.parent_public_id;
  }
  if (anchor.version_number !== null && anchor.version_number !== undefined && anchor.version_number !== 1) {
    // Only emit for non-default versions to keep response lean for the common case.
    result.version_number = anchor.version_number;
  }
  if (anchor.revocation_tx_id) {
    result.revocation_tx_id = anchor.revocation_tx_id;
  }
  if (anchor.revocation_block_height !== null && anchor.revocation_block_height !== undefined) {
    result.revocation_block_height = anchor.revocation_block_height;
  }
  if (anchor.file_mime) {
    result.file_mime = anchor.file_mime;
  }
  if (anchor.file_size !== null && anchor.file_size !== undefined) {
    result.file_size = anchor.file_size;
  }

  return result;
}

/** Fire-and-forget audit log for verification queries */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logVerificationAudit(req: any, publicId: string, result: VerificationResult, cacheHit: boolean): void {
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
    }),
  });
}

/** Default DB-backed lookup */
const defaultLookup: PublicIdLookup = {
  async lookupByPublicId(publicId: string) {
    // Cast to any — directory_info_opt_out column added by migration 0197 (not yet in generated types)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('anchors')
      .select(
        'public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, created_at, ' +
          'credential_type, issued_at, expires_at, org_id, description, directory_info_opt_out, ' +
          // API-RICH-01 additions — all already in `anchors` schema, just not previously surfaced:
          'compliance_controls, chain_confirmations, parent_anchor_id, version_number, ' +
          'revocation_tx_id, revocation_block_height, file_mime, file_size',
      )
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;

    // Look up org name separately
    let orgName: string | null = null;
    if (data.org_id) {
      const { data: org } = await db
        .from('organizations')
        .select('display_name')
        .eq('id', data.org_id)
        .single();
      orgName = org?.display_name ?? null;
    }

    // API-RICH-01: Resolve parent_anchor_id (UUID) → parent's public_id.
    // Never leak the internal UUID to the public API (Constitution 1.4).
    let parentPublicId: string | null = null;
    if (data.parent_anchor_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: parent } = await (db as any)
        .from('anchors')
        .select('public_id')
        .eq('id', data.parent_anchor_id)
        .single();
      parentPublicId = parent?.public_id ?? null;
    }

    return {
      public_id: data.public_id ?? '',
      fingerprint: data.fingerprint,
      status: data.status,
      chain_tx_id: data.chain_tx_id,
      chain_block_height: data.chain_block_height,
      chain_timestamp: data.chain_timestamp,
      created_at: data.created_at,
      credential_type: data.credential_type,
      org_name: orgName,
      recipient_hash: null,
      issued_at: data.issued_at,
      expires_at: data.expires_at,
      jurisdiction: null,
      merkle_root: null,
      description: data.description ?? null,
      directory_info_opt_out: data.directory_info_opt_out ?? false,
      // API-RICH-01
      compliance_controls: data.compliance_controls ?? null,
      chain_confirmations: data.chain_confirmations ?? null,
      parent_public_id: parentPublicId,
      version_number: data.version_number ?? null,
      revocation_tx_id: data.revocation_tx_id ?? null,
      revocation_block_height: data.revocation_block_height ?? null,
      file_mime: data.file_mime ?? null,
      file_size: data.file_size ?? null,
    } as AnchorByPublicId;
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

    logVerificationAudit(req, anchor.public_id, result, false);

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
