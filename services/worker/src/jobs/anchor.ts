/**
 * Anchor Processing Job
 *
 * Processes PENDING anchors and submits them to the chain.
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 *
 * Stories: CRIT-2, P7-TS-05, P7-TS-13, BETA-01
 */

import { db } from '../utils/db.js';
import { logger, createRpcLogger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { getInitializedChainClient } from '../chain/client.js';
import { getNetworkDisplayName, config } from '../config.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';
import { checkPaymentGuard } from '../billing/paymentGuard.js';
import { isFreeTierUser, isWithinBatchWindow } from '../billing/reconciliation.js';

/** SHA-256 hex fingerprint pattern: exactly 64 lowercase hex characters */
const FINGERPRINT_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Process a single anchor
 */
export async function processAnchor(anchorId: string): Promise<boolean> {
  const rpcLog = createRpcLogger('processAnchor', { anchorId });
  rpcLog.start();

  // Fetch anchor with PENDING status
  const { data: anchor, error: fetchError } = await db
    .from('anchors')
    .select('*')
    .eq('id', anchorId)
    .eq('status', 'PENDING')
    .single();

  if (fetchError || !anchor) {
    logger.warn({ anchorId, error: fetchError }, 'Anchor not found or not pending');
    return false;
  }

  try {
    // GAP-6: Confidence gate — block low-confidence AI extractions from being permanently anchored.
    // Pipeline records (metadata.pipeline_source) are exempt — they use ground truth data.
    const anchorMeta = anchor.metadata as Record<string, unknown> | null;
    const isPipeline = !!anchorMeta?.pipeline_source;
    if (!isPipeline) {
      // Check for AI extraction confidence via ai_usage_events
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
              'Anchor blocked by confidence gate — extraction confidence too low for permanent anchoring',
            );
            // Update status to flag for review rather than silently skipping
            await db.from('anchors').update({
              metadata: { ...anchorMeta, _review_reason: 'low_confidence', _ai_confidence: confidence },
            }).eq('id', anchorId).eq('status', 'PENDING');
            return false;
          }
        }
      } catch {
        // Non-fatal — proceed with anchoring if confidence check fails
      }
    }

    // RISK-1: Payment guard — verify user has valid payment before broadcasting.
    // Checks: (a) active Stripe subscription, (b) x402 payment for this anchor, or (c) admin bypass.
    // Pipeline records (public data) are exempt.
    if (!isPipeline) {
      const paymentCheck = await checkPaymentGuard(anchor.user_id, anchor.org_id, anchorId);
      if (!paymentCheck.authorized) {
        logger.warn(
          { anchorId, reason: paymentCheck.reason },
          'Anchor blocked by payment guard — no valid payment found',
        );
        await db.from('anchors').update({
          metadata: { ...anchorMeta, _payment_blocked: true, _payment_block_reason: paymentCheck.reason },
        }).eq('id', anchorId).eq('status', 'PENDING');
        return false;
      }

      // Item #10: Free tier batch-only anchoring — only when beta override is NOT active
      if (paymentCheck.source?.type !== 'beta_unlimited') {
        const isFree = await isFreeTierUser(anchor.user_id);
        if (isFree && !isWithinBatchWindow()) {
          logger.debug(
            { anchorId },
            'Free tier anchor deferred to daily batch window (02:00-03:00 UTC)',
          );
          return false; // Will be picked up during batch window
        }
      }

      // ECON-4: Link anchor to payment source for revenue attribution
      if (paymentCheck.source) {
        await db.from('anchors').update({
          payment_source_id: paymentCheck.source.id,
          payment_source_type: paymentCheck.source.type,
        }).eq('id', anchorId);
      }
    } else {
      // Pipeline records: tag as admin_bypass for accounting
      await db.from('anchors').update({
        payment_source_type: 'pipeline',
      }).eq('id', anchorId);
    }

    // Validate fingerprint before submitting to chain
    if (!anchor.fingerprint || !FINGERPRINT_REGEX.test(anchor.fingerprint)) {
      logger.error(
        { anchorId, fingerprint: anchor.fingerprint ? '[invalid format]' : '[missing]' },
        'Anchor has invalid fingerprint — skipping chain submission',
      );
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
            'Anchor deferred — current fee rate exceeds MAX_FEE_SAT_PER_VBYTE ceiling',
          );
          await db.from('anchors').update({
            metadata: { ...anchorMeta, _fee_deferred: true, _deferred_fee_rate: currentFeeRate },
          }).eq('id', anchorId).eq('status', 'PENDING');
          return false;
        }
      } catch {
        // Non-fatal: proceed if fee check fails
      }
    }

    // Submit fingerprint to chain, with metadata for OP_RETURN embedding (DEMO-01)
    const chainClient = getInitializedChainClient();
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
        'Chain broadcast returned empty receipt — mempool may have rejected the transaction',
      );
      return false;
    }

    // BETA-01: Set status to SUBMITTED (broadcast but unconfirmed).
    // The check-confirmations cron job will promote to SECURED once the tx is mined.
    // DEMO-01: Store metadata_hash in metadata JSON for independent verification.
    const updatePayload: Record<string, unknown> = {
      status: 'SUBMITTED',
      chain_tx_id: receipt.receiptId,
      chain_block_height: receipt.blockHeight,
      chain_timestamp: receipt.blockTimestamp,
    };

    // Store chain-related metadata: metadata hash, raw TX hex, fee
    const existingMetadata = (anchor.metadata as Record<string, unknown>) ?? {};
    const chainMetadata: Record<string, unknown> = { ...existingMetadata };
    if (receipt.metadataHash) {
      chainMetadata._metadata_hash = receipt.metadataHash;
    }
    // NET-4: Store raw TX hex for rebroadcast/RBF recovery
    if (receipt.rawTxHex) {
      chainMetadata._raw_tx_hex = receipt.rawTxHex;
    }
    // Cost tracking: fee paid in satoshis
    if (receipt.feeSats !== undefined) {
      chainMetadata._fee_sats = receipt.feeSats;
    }
    if (Object.keys(chainMetadata).length > Object.keys(existingMetadata).length) {
      updatePayload.metadata = chainMetadata;
    }

    // RACE-1 fix: Add status guard to prevent double-broadcast.
    // If another worker already claimed this anchor, the UPDATE returns 0 rows.
    const { error: updateError, count } = await db
      .from('anchors')
      .update(updatePayload)
      .eq('id', anchorId)
      .eq('status', 'PENDING');

    if (!updateError && count === 0) {
      logger.warn({ anchorId }, 'Anchor already claimed by another worker — skipping update');
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
    rpcLog.error(error);
    return false;
  }
}

/**
 * Check if anchoring is enabled via switchboard_flags (runtime kill switch).
 * Fails closed (returns false) on errors — prevents unintended chain submissions
 * when the control plane is unreachable.
 */
async function isAnchoringEnabled(): Promise<boolean> {
  try {
    const { data, error } = await callRpc<boolean>(db, 'get_flag', {
      p_flag_key: 'ENABLE_PROD_NETWORK_ANCHORING',
    });

    if (error || typeof data !== 'boolean') {
      // Fallback: check env var when DB RPC fails (e.g., PostgREST schema cache stale)
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
    // Fallback: check env var
    if (config.enableProdNetworkAnchoring) {
      logger.warn({ error: err }, 'get_flag threw — using env ENABLE_PROD_NETWORK_ANCHORING=true as fallback');
      return true;
    }
    logger.warn({ error: err }, 'ENABLE_PROD_NETWORK_ANCHORING flag lookup threw — defaulting to disabled');
    return false;
  }
}

/**
 * Process all pending anchors
 */
export async function processPendingAnchors(): Promise<{ processed: number; failed: number }> {
  logger.info('Starting pending anchor processing');

  // Runtime kill switch: check switchboard_flags before processing
  // This allows disabling anchoring without redeploying the worker
  const enabled = await isAnchoringEnabled();
  if (!enabled) {
    logger.info('Anchor processing disabled via switchboard flag');
    return { processed: 0, failed: 0 };
  }

  // Fetch PENDING user anchors — two-phase: DB fetch + JS filter.
  // Pipeline records (metadata.pipeline_source IS NOT NULL) use Merkle batch
  // anchoring via /jobs/anchor-public-records, not individual OP_RETURN.
  //
  // BUG FIX: Previously fetched limit(100) but with 10K+ pipeline records all
  // 100 were pipeline. Now uses RPC to filter at DB level for reliability.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: userAnchors, error } = await (db.rpc as any)('get_pending_user_anchors', {
    p_limit: 100,
  });

  if (error) {
    // Fallback: if RPC doesn't exist yet, use broad query with JS filter
    logger.warn({ error }, 'get_pending_user_anchors RPC failed — falling back to JS filter');
    const { data: allPending, error: fallbackError } = await db
      .from('anchors')
      .select('id, metadata')
      .eq('status', 'PENDING')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (fallbackError) {
      logger.error({ error: fallbackError }, 'Fallback anchor query failed');
      return { processed: 0, failed: 0 };
    }

    logger.info({ rowCount: allPending?.length ?? 0 }, 'Fallback query returned rows');

    if (!allPending || allPending.length === 0) {
      logger.debug('Fallback returned no PENDING anchors');
      return { processed: 0, failed: 0 };
    }

    const filtered = allPending.filter((a) => {
      const meta = a.metadata as Record<string, unknown> | null;
      return !meta?.pipeline_source;
    });

    if (filtered.length === 0) {
      logger.debug({ totalScanned: allPending.length }, 'No pending user anchors found (all pipeline)');
      return { processed: 0, failed: 0 };
    }

    logger.info({ count: filtered.length, totalScanned: allPending.length }, 'Found pending user anchors (fallback)');

    let processed = 0;
    let failed = 0;
    for (const anchor of filtered) {
      const success = await processAnchor(anchor.id);
      if (success) processed++; else failed++;
    }
    return { processed, failed };
  }

  if (!userAnchors || !Array.isArray(userAnchors) || userAnchors.length === 0) {
    logger.debug('No pending user anchors to process');
    return { processed: 0, failed: 0 };
  }

  logger.info({ count: userAnchors.length }, 'Found pending user anchors');

  let processed = 0;
  let failed = 0;

  for (const anchor of userAnchors) {
    const success = await processAnchor(anchor.id);
    if (success) {
      processed++;
    } else {
      failed++;
    }
  }

  logger.info({ processed, failed }, 'Finished processing pending anchors');
  return { processed, failed };
}
