/**
 * Anchor Processing Job
 *
 * Processes PENDING anchors and submits them to the chain.
 */

import { db } from '../utils/db.js';
import { logger, createRpcLogger } from '../utils/logger.js';
import { getInitializedChainClient } from '../chain/client.js';
import { getNetworkDisplayName, config } from '../config.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';

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
    // Submit fingerprint to chain
    const chainClient = getInitializedChainClient();
    const receipt = await chainClient.submitFingerprint({
      fingerprint: anchor.fingerprint,
      timestamp: new Date().toISOString(),
    });

    // Update anchor with chain data
    const { error: updateError } = await db
      .from('anchors')
      .update({
        status: 'SECURED',
        chain_tx_id: receipt.receiptId,
        chain_block_height: receipt.blockHeight,
        chain_timestamp: receipt.blockTimestamp,
      })
      .eq('id', anchorId);

    if (updateError) {
      logger.error({ anchorId, error: updateError }, 'Failed to update anchor');
      throw updateError;
    }

    // Upsert chain index entry — non-fatal (anchor is already secured)
    const { error: indexError } = await db
      .from('anchor_chain_index')
      .upsert(
        {
          fingerprint_sha256: anchor.fingerprint,
          chain_tx_id: receipt.receiptId,
          chain_block_height: receipt.blockHeight,
          chain_block_timestamp: receipt.blockTimestamp,
          confirmations: receipt.confirmations,
          anchor_id: anchorId,
        },
        { onConflict: 'fingerprint_sha256,chain_tx_id' },
      );

    if (indexError) {
      logger.warn({ anchorId, error: indexError }, 'Failed to upsert chain index entry');
    }

    // Log audit event — non-fatal if it fails (anchor is already secured)
    const { error: auditError } = await db.from('audit_events').insert({
      event_type: 'anchor.secured',
      event_category: 'ANCHOR',
      actor_id: anchor.user_id,
      target_type: 'anchor',
      target_id: anchorId,
      org_id: anchor.org_id,
      details: `Secured on ${getNetworkDisplayName(config.bitcoinNetwork)}: ${receipt.receiptId}`,
    });

    if (auditError) {
      logger.warn({ anchorId, error: auditError }, 'Failed to log audit event for secured anchor');
    }

    // Dispatch webhook — non-fatal if it fails (anchor is already secured)
    if (anchor.org_id) {
      try {
        await dispatchWebhookEvent(anchor.org_id, 'anchor.secured', anchorId, {
          anchor_id: anchorId,
          public_id: anchor.public_id ?? null,
          fingerprint: anchor.fingerprint,
          status: 'SECURED',
          chain_tx_id: receipt.receiptId,
          chain_block_height: receipt.blockHeight,
          secured_at: receipt.blockTimestamp,
        });
      } catch (webhookError) {
        logger.warn({ anchorId, error: webhookError }, 'Failed to dispatch webhook for secured anchor');
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
 * Process all pending anchors
 */
export async function processPendingAnchors(): Promise<{ processed: number; failed: number }> {
  logger.info('Starting pending anchor processing');

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
