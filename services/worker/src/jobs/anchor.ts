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
    // Validate fingerprint before submitting to chain
    if (!anchor.fingerprint || !FINGERPRINT_REGEX.test(anchor.fingerprint)) {
      logger.error(
        { anchorId, fingerprint: anchor.fingerprint ? '[invalid format]' : '[missing]' },
        'Anchor has invalid fingerprint — skipping chain submission',
      );
      return false;
    }

    // Submit fingerprint to chain
    const chainClient = getInitializedChainClient();
    const receipt = await chainClient.submitFingerprint({
      fingerprint: anchor.fingerprint,
      timestamp: new Date().toISOString(),
    });

    // BETA-01: Set status to SUBMITTED (broadcast but unconfirmed).
    // The check-confirmations cron job will promote to SECURED once the tx is mined.
    const { error: updateError } = await db
      .from('anchors')
      .update({
        status: 'SUBMITTED',
        chain_tx_id: receipt.receiptId,
        chain_block_height: receipt.blockHeight,
        chain_timestamp: receipt.blockTimestamp,
        chain_confirmations: 0,
      })
      .eq('id', anchorId);

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
      logger.warn(
        { error, dataType: typeof data },
        'Failed to read valid ENABLE_PROD_NETWORK_ANCHORING flag — defaulting to disabled',
      );
      return false;
    }

    return data;
  } catch (err) {
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

  // Fetch all PENDING anchors
  const { data: anchors, error } = await db
    .from('anchors')
    .select('id')
    .eq('status', 'PENDING')
    .is('deleted_at', null)
    .limit(100); // Process in batches

  if (error) {
    logger.error({ error }, 'Failed to fetch pending anchors');
    return { processed: 0, failed: 0 };
  }

  if (!anchors || anchors.length === 0) {
    logger.debug('No pending anchors to process');
    return { processed: 0, failed: 0 };
  }

  logger.info({ count: anchors.length }, 'Found pending anchors');

  let processed = 0;
  let failed = 0;

  for (const anchor of anchors) {
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
