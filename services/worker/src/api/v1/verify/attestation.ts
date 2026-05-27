/**
 * GET /api/v1/verify/attestation/:attestationId (SCRUM-1873)
 *
 * Public verification endpoint for legally binding attestations.
 * Accepts the attestation's public_id (ARK-ATT-*), NOT an internal UUID.
 *
 * Returns: verification status, attestation metadata, anchor proof (if
 * available), and notarization status (if applicable).
 *
 * Constitution refs:
 *   - 1.3: No banned terminology in response keys (hash, transaction, etc.)
 *   - 1.4: Never expose internal UUIDs or org_id
 *   - 1.8: Frozen schema — additive nullable fields only once published
 *   - 1.10: 100 req/min anonymous (enforced upstream in router.ts)
 *
 * Privacy: attestation_statement is private (per migration 0314 COMMENT)
 *   and is NEVER included in the verification response.
 */

import { Router, type Request, type Response } from 'express';
import { db } from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { config } from '../../../config.js';
import { buildAttestationVerifyUrl } from '../../../lib/urls.js';

const router = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = db as any;

// ── Types ──────────────────────────────────────────────────────────

/** Row shape from the joined query — only the columns we SELECT */
export interface LegallyBindingAttestationRow {
  attestation_id: string;
  attestation_type: string;
  attesting_org_name: string;
  org_verified: boolean;
  subject_name: string;
  attestation_statement?: never;
  status: string;
  notary_name: string | null;
  notary_commission_state: string | null;
  notary_commission_number: string | null;
  notarization_completed_at: string | null;
  anchor_public_id: string | null;
  anchor_status: string | null;
  anchor_fingerprint: string | null;
  anchor_chain_tx_id: string | null;
  anchor_chain_block_height: number | null;
  anchor_chain_timestamp: string | null;
  anchor_timestamp: string | null;
  created_at: string;
  updated_at: string;
}

/** Notarization sub-block in the response */
export interface NotarizationInfo {
  status: 'pending' | 'completed';
  notary_name?: string;
  commission_state?: string;
  commission_number?: string;
  completed_at?: string;
}

/** Anchor proof sub-block in the response */
export interface AnchorProofInfo {
  status: string;
  fingerprint: string;
  anchored_at: string | null;
  network_receipt: string | null;
  block_height: number | null;
  explorer_url?: string;
}

/** Full verification result — public API response shape */
export interface AttestationVerificationResult {
  verified: boolean;
  attestation: {
    public_id: string;
    type: string;
    status: string;
    created_at: string;
    attesting_org: {
      name: string;
      verified: boolean;
    };
    subject: {
      name: string;
    };
    notarization?: NotarizationInfo;
  };
  anchor: AnchorProofInfo | null;
  verify_url: string;
}

// ── Injectable lookup interface (for testability) ──────────────────

export interface AttestationLookup {
  lookupByPublicId(attestationId: string): Promise<LegallyBindingAttestationRow | null>;
}

// ── Explorer URL builder ───────────────────────────────────────────

function explorerUrlForTx(txId: string | null): string | undefined {
  if (!txId || !/^[a-fA-F0-9]+$/.test(txId)) return undefined;
  const network = config.bitcoinNetwork;
  const baseMap: Record<string, string> = {
    testnet4: 'https://mempool.space/testnet4',
    testnet: 'https://mempool.space/testnet',
    signet: 'https://mempool.space/signet',
    mainnet: 'https://mempool.space',
  };
  const base = baseMap[network] ?? baseMap.signet;
  return `${base}/tx/${txId}`;
}

// ── Core verification logic (extracted for testability) ────────────

export function buildAttestationVerificationResult(
  row: LegallyBindingAttestationRow,
): AttestationVerificationResult {
  // An attestation is verified only when it has reached the 'anchored' status
  const isVerified = row.status === 'anchored';

  // Build notarization sub-block only for notarized type
  let notarization: NotarizationInfo | undefined;
  if (row.attestation_type === 'notarized') {
    if (row.notarization_completed_at) {
      notarization = {
        status: 'completed',
        ...(row.notary_name ? { notary_name: row.notary_name } : {}),
        ...(row.notary_commission_state ? { commission_state: row.notary_commission_state } : {}),
        ...(row.notary_commission_number ? { commission_number: row.notary_commission_number } : {}),
        completed_at: row.notarization_completed_at,
      };
    } else {
      notarization = { status: 'pending' };
    }
  }

  // Build anchor proof sub-block only when anchor data exists
  let anchor: AnchorProofInfo | null = null;
  if (row.anchor_public_id && row.anchor_status) {
    anchor = {
      status: row.anchor_status,
      fingerprint: row.anchor_fingerprint ?? '',
      anchored_at: row.anchor_chain_timestamp ?? row.anchor_timestamp ?? null,
      network_receipt: row.anchor_chain_tx_id ?? null,
      block_height: row.anchor_chain_block_height ?? null,
      ...(explorerUrlForTx(row.anchor_chain_tx_id)
        ? { explorer_url: explorerUrlForTx(row.anchor_chain_tx_id) }
        : {}),
    };
  }

  return {
    verified: isVerified,
    attestation: {
      public_id: row.attestation_id,
      type: row.attestation_type,
      status: row.status,
      created_at: row.created_at,
      attesting_org: {
        name: row.attesting_org_name,
        verified: row.org_verified,
      },
      subject: {
        name: row.subject_name,
      },
      ...(notarization ? { notarization } : {}),
    },
    anchor,
    verify_url: buildAttestationVerifyUrl(row.attestation_id),
  };
}

// ── Default DB-backed lookup ───────────────────────────────────────

const defaultLookup: AttestationLookup = {
  async lookupByPublicId(attestationId: string): Promise<LegallyBindingAttestationRow | null> {
    // Join legally_binding_attestations with organizations (for verified status)
    // and anchors (for chain proof) in one query.
    const { data, error } = await dbAny
      .from('legally_binding_attestations')
      .select(
        'attestation_id, attestation_type, attesting_org_name, ' +
        'subject_name, status, ' +
        'notary_name, notary_commission_state, notary_commission_number, ' +
        'notarization_completed_at, anchor_timestamp, ' +
        'created_at, updated_at, ' +
        'attesting_org_id, anchor_id',
      )
      .eq('attestation_id', attestationId)
      .maybeSingle();

    if (error || !data) {
      if (error) {
        logger.error({ error, attestationId }, 'Legally binding attestation lookup failed');
      }
      return null;
    }

    // Look up organization verification status
    let orgVerified = false;
    if (data.attesting_org_id) {
      const { data: org } = await dbAny
        .from('organizations')
        .select('verification_status')
        .eq('id', data.attesting_org_id)
        .maybeSingle();
      orgVerified = org?.verification_status === 'VERIFIED';
    }

    // Look up anchor chain proof data if anchor_id exists
    let anchorData: Record<string, unknown> | null = null;
    if (data.anchor_id) {
      const { data: anchor } = await db
        .from('anchors')
        .select('public_id, status, fingerprint, chain_tx_id, chain_block_height, chain_timestamp')
        .eq('id', data.anchor_id)
        .maybeSingle();
      if (anchor) {
        anchorData = anchor as unknown as Record<string, unknown>;
      }
    }

    return {
      attestation_id: data.attestation_id,
      attestation_type: data.attestation_type,
      attesting_org_name: data.attesting_org_name,
      org_verified: orgVerified,
      subject_name: data.subject_name,
      status: data.status,
      notary_name: data.notary_name ?? null,
      notary_commission_state: data.notary_commission_state ?? null,
      notary_commission_number: data.notary_commission_number ?? null,
      notarization_completed_at: data.notarization_completed_at ?? null,
      anchor_public_id: (anchorData?.public_id as string) ?? null,
      anchor_status: (anchorData?.status as string) ?? null,
      anchor_fingerprint: (anchorData?.fingerprint as string) ?? null,
      anchor_chain_tx_id: (anchorData?.chain_tx_id as string) ?? null,
      anchor_chain_block_height: (anchorData?.chain_block_height as number) ?? null,
      anchor_chain_timestamp: (anchorData?.chain_timestamp as string) ?? null,
      anchor_timestamp: data.anchor_timestamp ?? null,
      created_at: data.created_at,
      updated_at: data.updated_at,
    };
  },
};

// ── Audit log (fire-and-forget) ────────────────────────────────────

function logAttestationVerificationAudit(
  req: Request,
  attestationId: string,
  result: AttestationVerificationResult,
): void {
  // eslint-disable-next-line arkova/missing-org-filter -- anonymous public verification endpoint
  void dbAny.from('audit_events').insert({
    event_type: 'ATTESTATION_VERIFICATION_QUERIED',
    event_category: 'COMPLIANCE',
    target_type: 'legally_binding_attestation',
    target_id: attestationId,
    details: JSON.stringify({
      verified: result.verified,
      status: result.attestation.status,
      type: result.attestation.type,
      api_key_id: (req as unknown as Record<string, unknown>).apiKeyId ?? null,
    }),
  }).then(({ error }: { error: unknown }) => {
    if (error) logger.warn({ error, attestationId }, 'Attestation verification audit insert failed');
  }).catch(() => { /* non-fatal */ });
}

// ── Route handler ──────────────────────────────────────────────────

router.get('/:attestationId', async (req: Request<{ attestationId: string }>, res: Response) => {
  const { attestationId } = req.params;

  if (!attestationId || !/^ARK-ATT-[A-Za-z0-9_-]{1,64}$/.test(attestationId)) {
    res.status(400).json({
      verified: false,
      error: 'Invalid attestation ID format — expected ARK-ATT-* prefix',
    });
    return;
  }

  try {
    const lookup =
      (req as unknown as { _testLookup?: AttestationLookup })._testLookup ?? defaultLookup;

    const lba = await lookup.lookupByPublicId(attestationId);

    if (!lba) {
      res.status(404).json({
        verified: false,
        error: 'Attestation not found',
      });
      return;
    }

    const result = buildAttestationVerificationResult(lba);

    // Fire-and-forget audit
    logAttestationVerificationAudit(req, attestationId, result);

    res.json(result);
  } catch (err) {
    logger.error({ error: err, attestationId }, 'Attestation verification lookup failed');
    res.status(500).json({
      verified: false,
      error: 'Internal server error',
    });
  }
});

export { router as attestationVerifyRouter };
