/**
 * Anchor Processing Job
 *
 * Processes PENDING anchors and submits them to the chain.
 * Uses a two-phase "claim before broadcast" pattern to prevent
 * double-broadcast on worker crash/restart.
 *
 * Flow: PENDING → (claim RPC) → BROADCASTING → (chain submit) → SUBMITTED
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 *
 * Stories: CRIT-2, P7-TS-05, P7-TS-13, BETA-01, RACE-1
 */

import { db, withDbTimeout } from '../utils/db.js';
import { logger, createRpcLogger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { getChainClientAsync } from '../chain/client.js';
import { getNetworkDisplayName, config } from '../config.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';
import { checkPaymentGuard } from '../billing/paymentGuard.js';
import { isFreeTierUser, isWithinBatchWindow } from '../billing/reconciliation.js';
import { getComplianceControlIds } from '../utils/complianceMapping.js';

/** SHA-256 hex fingerprint pattern: exactly 64 lowercase hex characters */
const FINGERPRINT_REGEX = /^[a-f0-9]{64}$/i;

/** Shape of a claimed anchor from claim_pending_anchors() or legacy fetch */
export interface ClaimedAnchor {
  id: string;
  user_id: string;
  org_id: string | null;
  fingerprint: string;
  public_id: string | null;
  metadata: Record<string, unknown> | null;
  credential_type: string | null;
}

/**
 * Process a single anchor that has already been claimed (status = BROADCASTING).
 *
 * RACE-1 fix: The anchor is already in BROADCASTING state via the atomic
 * claim_pending_anchors() RPC. No other worker can claim it. If we crash
 * before updating to SUBMITTED, the recovery cron will reset it to PENDING.
 */
export async function processAnchor(anchor: ClaimedAnchor): Promise<boolean> {
  const anchorId = anchor.id;
  const rpcLog = createRpcLogger('processAnchor', { anchorId });
  rpcLog.start();

  try {
    const anchorMeta = anchor.metadata ?? {};
    const isPipeline = !!anchorMeta.pipeline_source;

    // GAP-6: Confidence gate — block low-confidence AI extractions from being permanently anchored.
    if (!isPipeline) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: usageData } = await (db as any)
          .from('ai_usage_events')
          .select('confidence')
          .eq('fingerprint', anchor.fingerprint)
          .eq('event_type', 'extraction')
          .eq('success', true)
          .order('created_at', { ascending: false })
          .limit(1);

        if (usageData && usageData.length > 0 && usageData[0].confidence != null) {
          const confidence = usageData[0].confidence as number;
          const CONFIDENCE_THRESHOLD = parseFloat(process.env.ANCHOR_CONFIDENCE_THRESHOLD ?? '0.4');
          if (confidence < CONFIDENCE_THRESHOLD) {
            logger.warn(
              { anchorId, confidence, threshold: CONFIDENCE_THRESHOLD },
              'Anchor blocked by confidence gate — releasing claim back to PENDING',
            );
            await revertToPending(anchorId, {
              ...anchorMeta,
              _review_reason: 'low_confidence',
              _ai_confidence: confidence,
            });
            return false;
          }
        }
      } catch {
        // Non-fatal — proceed with anchoring if confidence check fails
      }
    }

    // RISK-1: Payment guard — verify user has valid payment before broadcasting.
    if (!isPipeline) {
      const paymentCheck = await checkPaymentGuard(anchor.user_id, anchor.org_id, anchorId);
      if (!paymentCheck.authorized) {
        logger.warn(
          { anchorId, reason: paymentCheck.reason },
          'Anchor blocked by payment guard — releasing claim back to PENDING',
        );
        await revertToPending(anchorId, {
          ...anchorMeta,
          _payment_blocked: true,
          _payment_block_reason: paymentCheck.reason,
        });
        return false;
      }

      // Item #10: Free tier batch-only anchoring — only when beta override is NOT active
      if (paymentCheck.source?.type !== 'beta_unlimited') {
        const isFree = await isFreeTierUser(anchor.user_id);
        if (isFree && !isWithinBatchWindow()) {
          logger.debug(
            { anchorId },
            'Free tier anchor deferred to daily batch window — releasing claim',
          );
          await revertToPending(anchorId, anchorMeta);
          return false;
        }
      }

      // ECON-4: Link anchor to payment source for revenue attribution
      if (paymentCheck.source) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('anchors').update({
          payment_source_id: paymentCheck.source.id,
          payment_source_type: paymentCheck.source.type,
        }).eq('id', anchorId);
      }
    } else {
      // Pipeline records: tag as admin_bypass for accounting
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('anchors').update({
        payment_source_type: 'pipeline',
      }).eq('id', anchorId);
    }

    // Validate fingerprint before submitting to chain
    if (!anchor.fingerprint || !FINGERPRINT_REGEX.test(anchor.fingerprint)) {
      logger.error(
        { anchorId, fingerprint: anchor.fingerprint ? '[invalid format]' : '[missing]' },
        'Anchor has invalid fingerprint — releasing claim back to PENDING',
      );
      await revertToPending(anchorId, anchorMeta);
      return false;
    }

    // ECON-1 / Item #7: Check fee ceiling — defer anchor if fee rate exceeds MAX_FEE_SAT_PER_VBYTE
    if (config.bitcoinMaxFeeRate) {
      try {
        const { MempoolFeeEstimator } = await import('../chain/fee-estimator.js');
        const estimator = new MempoolFeeEstimator({ target: 'halfHour', timeoutMs: 3000 });
        const currentFeeRate = await estimator.estimateFee();
        if (currentFeeRate > config.bitcoinMaxFeeRate) {
          logger.info(
            { anchorId, currentFeeRate, maxFeeRate: config.bitcoinMaxFeeRate },
            'Anchor deferred — fee rate exceeds ceiling, releasing claim',
          );
          await revertToPending(anchorId, {
            ...anchorMeta,
            _fee_deferred: true,
            _deferred_fee_rate: currentFeeRate,
          });
          return false;
        }
      } catch {
        // Non-fatal: proceed if fee check fails
      }
    }

    // Submit fingerprint to chain, with metadata for OP_RETURN embedding (DEMO-01)
    // At this point the anchor is BROADCASTING — if we crash here, recovery cron
    // will reset to PENDING since chain_tx_id is still null.
    const chainClient = await getChainClientAsync();
    const metadata = anchor.metadata as Record<string, string> | null;
    const receipt = await chainClient.submitFingerprint({
      fingerprint: anchor.fingerprint,
      timestamp: new Date().toISOString(),
      metadata: metadata && Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    // RACE-2 fix: Validate broadcast response — reject if mempool didn't accept
    if (!receipt || !receipt.receiptId) {
      logger.error(
        { anchorId, receipt },
        'Chain broadcast returned empty receipt — reverting to PENDING',
      );
      await revertToPending(anchorId, anchorMeta);
      return false;
    }

    // RACE-1 fix: Update BROADCASTING → SUBMITTED with chain data.
    // This is safe: only one worker holds this anchor in BROADCASTING.
    const updatePayload: Record<string, unknown> = {
      status: 'SUBMITTED',
      chain_tx_id: receipt.receiptId,
      chain_block_height: receipt.blockHeight,
      chain_timestamp: receipt.blockTimestamp,
    };

    // Store chain-related metadata: metadata hash, raw TX hex, fee
    const chainMetadata: Record<string, unknown> = { ...anchorMeta };
    if (receipt.metadataHash) {
      chainMetadata._metadata_hash = receipt.metadataHash;
    }

    // VAI-01: Look up extraction manifest hash and link to anchor
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: manifestData } = await (db as any)
        .from('extraction_manifests')
        .select('id, manifest_hash')
        .eq('fingerprint', anchor.fingerprint)
        .order('created_at', { ascending: false })
        .limit(1);

      if (manifestData && manifestData.length > 0) {
        chainMetadata._extraction_manifest_hash = manifestData[0].manifest_hash;
        // Link manifest to this anchor (non-blocking)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).from('extraction_manifests')
          .update({ anchor_id: anchorId })
          .eq('id', manifestData[0].id)
          .then(({ error: linkErr }: { error: unknown }) => {
            if (linkErr) {
              logger.warn({ error: linkErr, anchorId }, 'Failed to link extraction manifest to anchor');
            }
          });
      }
    } catch {
      // Non-fatal — proceed with anchoring if manifest lookup fails
    }
    // NET-4: Store raw TX hex for rebroadcast/RBF recovery
    if (receipt.rawTxHex) {
      chainMetadata._raw_tx_hex = receipt.rawTxHex;
    }
    // Cost tracking: fee paid in satoshis
    if (receipt.feeSats !== undefined) {
      chainMetadata._fee_sats = receipt.feeSats;
    }
    // Clean up claim metadata
    delete chainMetadata._claimed_by;
    delete chainMetadata._claimed_at;
    updatePayload.metadata = chainMetadata;

    // CML-02: Auto-populate compliance controls based on credential type
    updatePayload.compliance_controls = getComplianceControlIds(anchor.credential_type);

    const { error: updateError, count } = await db
      .from('anchors')
      .update(updatePayload)
      .eq('id', anchorId)
      .eq('status', 'BROADCASTING');

    if (!updateError && count === 0) {
      // This should not happen since we have exclusive claim via BROADCASTING,
      // but guard against unexpected state changes.
      logger.warn({ anchorId }, 'Anchor no longer in BROADCASTING state — skipping update');
      return false;
    }

    if (updateError) {
      logger.error({ anchorId, error: updateError }, 'Failed to update anchor');
      throw updateError;
    }

    // Log audit event — non-fatal
    const { error: auditError } = await db.from('audit_events').insert({
      event_type: 'anchor.submitted',
      event_category: 'ANCHOR',
      actor_id: anchor.user_id,
      target_type: 'anchor',
      target_id: anchorId,
      org_id: anchor.org_id,
      details: `Submitted to ${getNetworkDisplayName(config.bitcoinNetwork)}: ${receipt.receiptId}`,
    });

    if (auditError) {
      logger.warn({ anchorId, error: auditError }, 'Failed to log audit event for submitted anchor');
    }

    // Dispatch webhook for submission — non-fatal
    if (anchor.org_id) {
      try {
        await dispatchWebhookEvent(anchor.org_id, 'anchor.submitted', anchorId, {
          anchor_id: anchorId,
          public_id: anchor.public_id ?? null,
          fingerprint: anchor.fingerprint,
          status: 'SUBMITTED',
          chain_tx_id: receipt.receiptId,
          submitted_at: receipt.blockTimestamp,
        });
      } catch (webhookError) {
        logger.warn({ anchorId, error: webhookError }, 'Failed to dispatch webhook for submitted anchor');
      }
    }

    rpcLog.success({ receiptId: receipt.receiptId });
    return true;
  } catch (error) {
    // On any unexpected error, try to revert to PENDING so the anchor isn't stuck
    try {
      await revertToPending(anchorId, anchor.metadata ?? {});
    } catch (revertError) {
      logger.error({ anchorId, error: revertError }, 'Failed to revert anchor to PENDING after error');
    }
    rpcLog.error(error);
    return false;
  }
}

/**
 * Revert a BROADCASTING anchor back to PENDING.
 * Used when pre-broadcast checks fail or an error occurs before chain submission.
 */
async function revertToPending(anchorId: string, metadata: Record<string, unknown>): Promise<void> {
  const cleanMeta = { ...metadata };
  delete cleanMeta._claimed_by;
  delete cleanMeta._claimed_at;

  await db
    .from('anchors')
    .update({
      status: 'PENDING',
      metadata: cleanMeta as unknown as import('../types/database.types.js').Json,
    })
    .eq('id', anchorId)
    .eq('status', 'BROADCASTING');
}

/**
 * Check if anchoring is enabled.
 *
 * In production: DB switchboard flag is authoritative (runtime kill switch).
 * In non-production: env var ENABLE_PROD_NETWORK_ANCHORING is authoritative,
 * with DB flag as override-only (prevents dev seed data mismatch from blocking anchoring).
 *
 * Fails closed (returns false) on errors — prevents unintended chain submissions
 * when the control plane is unreachable.
 */
async function isAnchoringEnabled(): Promise<boolean> {
  if (config.nodeEnv !== 'production') {
    if (config.enableProdNetworkAnchoring) {
      return true;
    }
    try {
      const { data } = await callRpc<boolean>(db, 'get_flag', {
        p_flag_key: 'ENABLE_PROD_NETWORK_ANCHORING',
      });
      if (data === true) return true;
    } catch {
      // Non-fatal in dev
    }
    return false;
  }

  // Production: DB switchboard flag is authoritative (runtime kill switch)
  try {
    const { data, error } = await callRpc<boolean>(db, 'get_flag', {
      p_flag_key: 'ENABLE_PROD_NETWORK_ANCHORING',
    });

    if (error || typeof data !== 'boolean') {
      if (config.enableProdNetworkAnchoring) {
        logger.warn(
          { error, dataType: typeof data },
          'DB get_flag failed — using env ENABLE_PROD_NETWORK_ANCHORING=true as fallback',
        );
        return true;
      }
      logger.warn(
        { error, dataType: typeof data },
        'Failed to read ENABLE_PROD_NETWORK_ANCHORING flag — defaulting to disabled',
      );
      return false;
    }

    return data;
  } catch (err) {
    if (config.enableProdNetworkAnchoring) {
      logger.warn({ error: err }, 'get_flag threw — using env ENABLE_PROD_NETWORK_ANCHORING=true as fallback');
      return true;
    }
    logger.warn({ error: err }, 'ENABLE_PROD_NETWORK_ANCHORING flag lookup threw — defaulting to disabled');
    return false;
  }
}

/**
 * Process all pending anchors using the claim-before-broadcast pattern.
 *
 * 1. Atomically claim PENDING → BROADCASTING via RPC (FOR UPDATE SKIP LOCKED)
 * 2. Process each claimed anchor (already safe from double-broadcast)
 * 3. On failure, revert BROADCASTING → PENDING (or let recovery cron handle it)
 */
export async function processPendingAnchors(): Promise<{ processed: number; failed: number }> {
  logger.info('Starting pending anchor processing');

  // Runtime kill switch: check switchboard_flags before processing
  const enabled = await isAnchoringEnabled();
  if (!enabled) {
    logger.info('Anchor processing disabled via switchboard flag');
    return { processed: 0, failed: 0 };
  }

  // Pre-flight: check treasury has funds before claiming anchors
  try {
    const chainClient = await getChainClientAsync();
    if (chainClient.hasFunds) {
      const funded = await chainClient.hasFunds();
      if (!funded) {
        logger.warn('Treasury empty — skipping anchor processing until funded');
        return { processed: 0, failed: 0 };
      }
    }
  } catch (err) {
    logger.warn({ error: err }, 'Pre-flight UTXO check failed — proceeding cautiously');
  }

  // Phase 1: Atomically claim anchors via RPC (PENDING → BROADCASTING)
  // Wrapped in 30s timeout to prevent cron job from hanging if PostgREST is slow
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let claimResult: { data: any; error: any };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claimResult = await withDbTimeout(() => (db.rpc as any)('claim_pending_anchors', {
      p_worker_id: `worker-${process.pid}`,
      p_limit: 100, // M3: increased from 50 to clear backlogs faster (6K/hr vs 3K/hr)
      p_exclude_pipeline: true,
    }), 30_000);
  } catch (timeoutErr) {
    logger.error({ error: timeoutErr }, 'claim_pending_anchors timed out after 30s');
    return { processed: 0, failed: 0 };
  }
  const { data: claimedAnchors, error: claimError } = claimResult;

  if (claimError) {
    // Fallback: if RPC doesn't exist yet (pre-migration), use legacy path
    logger.warn({ error: claimError }, 'claim_pending_anchors RPC failed — falling back to legacy claim');
    return legacyProcessPendingAnchors();
  }

  if (!claimedAnchors || !Array.isArray(claimedAnchors) || claimedAnchors.length === 0) {
    logger.debug('No pending anchors claimed');
    return { processed: 0, failed: 0 };
  }

  logger.info({ count: claimedAnchors.length }, 'Claimed pending anchors for processing');

  // Phase 2: Process each claimed anchor
  let processed = 0;
  let failed = 0;

  for (const anchor of claimedAnchors) {
    const success = await processAnchor({
      id: anchor.id,
      user_id: anchor.user_id,
      org_id: anchor.org_id,
      fingerprint: anchor.fingerprint,
      public_id: anchor.public_id,
      metadata: anchor.metadata,
      credential_type: anchor.credential_type,
    });
    if (success) {
      processed++;
    } else {
      failed++;
    }
  }

  logger.info({ processed, failed }, 'Finished processing pending anchors');
  return { processed, failed };
}

/**
 * Legacy fallback: process pending anchors without the claim RPC.
 * Used when migration 0111 hasn't been applied yet.
 * This preserves the old SELECT-then-process pattern with RACE-1 status guard.
 */
async function legacyProcessPendingAnchors(): Promise<{ processed: number; failed: number }> {
  const { data: allPending, error: fallbackError } = await db
    .from('anchors')
    .select('id, user_id, org_id, fingerprint, public_id, metadata, credential_type')
    .eq('status', 'PENDING')
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(50);

  if (fallbackError || !allPending || allPending.length === 0) {
    if (fallbackError) logger.error({ error: fallbackError }, 'Legacy anchor query failed');
    return { processed: 0, failed: 0 };
  }

  // Filter out pipeline records
  const filtered = allPending.filter((a) => {
    const meta = a.metadata as Record<string, unknown> | null;
    return !meta?.pipeline_source;
  });

  if (filtered.length === 0) {
    return { processed: 0, failed: 0 };
  }

  logger.info({ count: filtered.length }, 'Found pending user anchors (legacy fallback)');

  let processed = 0;
  let failed = 0;

  for (const anchor of filtered) {
    // Legacy: claim individually by updating status inline
    const { count: claimed } = await db
      .from('anchors')
      .update({ status: 'BROADCASTING' })
      .eq('id', anchor.id)
      .eq('status', 'PENDING');

    if (claimed === 0) {
      logger.debug({ anchorId: anchor.id }, 'Anchor already claimed by another worker (legacy)');
      continue;
    }

    const success = await processAnchor({
      id: anchor.id,
      user_id: anchor.user_id,
      org_id: anchor.org_id,
      fingerprint: anchor.fingerprint,
      public_id: anchor.public_id,
      metadata: anchor.metadata as Record<string, unknown> | null,
      credential_type: (anchor as Record<string, unknown>).credential_type as string | null,
    });
    if (success) processed++; else failed++;
  }

  return { processed, failed };
}
