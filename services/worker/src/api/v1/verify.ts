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
  ] as const;
  for (const key of API_RICH_KEYS) {
    const v = anchor[key];
    if (v !== null && v !== undefined && v !== '') {
      (result as unknown as Record<string, unknown>)[key] = v;
    }
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
} as const;

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

/** Default DB-backed lookup — single JOIN for orgName + parent public_id to avoid N+1 on hot path */
const defaultLookup: PublicIdLookup = {
  async lookupByPublicId(publicId: string) {
    // Supabase nested select hydrates org + parent anchor in one round-trip.
    // `organization:org_id(display_name)` and `parent:parent_anchor_id(public_id)` each resolve
    // the referenced row via the FK. `directory_info_opt_out` added by migration 0197 is
    // not yet in generated types; `parent_anchor_id` FK to anchors.id never leaves this module.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('anchors')
      .select(
        'public_id, fingerprint, status, chain_tx_id, chain_block_height, chain_timestamp, created_at, ' +
          'credential_type, issued_at, expires_at, description, directory_info_opt_out, ' +
          'compliance_controls, chain_confirmations, version_number, ' +
          'revocation_tx_id, revocation_block_height, file_mime, file_size, ' +
          'organization:org_id(display_name), parent:parent_anchor_id(public_id)',
      )
      .eq('public_id', publicId)
      .is('deleted_at', null)
      .single();

    if (error || !data) return null;

    return {
      public_id: data.public_id ?? '',
      fingerprint: data.fingerprint,
      status: data.status,
      chain_tx_id: data.chain_tx_id,
      chain_block_height: data.chain_block_height,
      chain_timestamp: data.chain_timestamp,
      created_at: data.created_at,
      credential_type: data.credential_type,
      org_name: data.organization?.display_name ?? null,
      recipient_hash: null,
      issued_at: data.issued_at,
      expires_at: data.expires_at,
      jurisdiction: null,
      merkle_root: null,
      description: data.description ?? null,
      directory_info_opt_out: data.directory_info_opt_out ?? false,
      compliance_controls: data.compliance_controls ?? null,
      chain_confirmations: data.chain_confirmations ?? null,
      parent_public_id: data.parent?.public_id ?? null,
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
