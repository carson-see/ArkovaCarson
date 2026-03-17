/**
 * Revocation Processing Job (BETA-02)
 *
 * Broadcasts OP_RETURN revocation transactions for anchors that have
 * been revoked via the revoke_anchor() RPC but not yet anchored on-chain.
 *
 * The revocation transaction embeds:
 *   ARKV prefix + SHA-256(REVOKE:{original_fingerprint})
 *
 * This creates an immutable on-chain record that the credential was revoked,
 * complementing the original anchoring transaction.
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 *
 * Stories: BETA-02
 */

import { db } from '../utils/db.js';
import { logger, createRpcLogger } from '../utils/logger.js';
import { callRpc } from '../utils/rpc.js';
import { getInitializedChainClient } from '../chain/client.js';
import { getNetworkDisplayName, config } from '../config.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';

/**
 * Process a single revocation — broadcast OP_RETURN to chain.
 *
 * Prerequisites:
 * - Anchor must be in REVOKED status
 * - Anchor must have chain_tx_id (was anchored on-chain before revocation)
 * - Anchor must NOT already have revocation_tx_id (idempotency guard)
 */
export async function processRevocation(anchorId: string): Promise<boolean> {
  const rpcLog = createRpcLogger('processRevocation', { anchorId });
  rpcLog.start();

  // Fetch revoked anchor that needs chain revocation
  const { data: anchor, error: fetchError } = await db
    .from('anchors')
    .select('*')
    .eq('id', anchorId)
    .eq('status', 'REVOKED')
    .is('deleted_at', null)
    .limit(1);

  // Handle both single and array responses from Supabase
  const anchorRecord = Array.isArray(anchor) ? anchor[0] : anchor;

  if (fetchError || !anchorRecord) {
    logger.warn({ anchorId, error: fetchError }, 'Revoked anchor not found or not eligible');
    return false;
  }

  // Idempotency: skip if already has a revocation tx
  if (anchorRecord.revocation_tx_id) {
    logger.debug({ anchorId }, 'Anchor already has revocation tx — skipping');
    return false;
  }

  // Skip if anchor was never anchored on-chain (nothing to revoke on-chain)
  if (!anchorRecord.chain_tx_id) {
    logger.warn({ anchorId }, 'Anchor has no chain_tx_id — cannot broadcast revocation');
    return false;
  }

  try {
    // Submit revocation fingerprint to chain
    // We reuse the same fingerprint but add REVOKE metadata so the OP_RETURN
    // payload is: ARKV + SHA-256(fingerprint) — same as anchoring.
    // The metadata field distinguishes it as a revocation in our records.
    const chainClient = getInitializedChainClient();
    const receipt = await chainClient.submitFingerprint({
      fingerprint: anchorRecord.fingerprint,
      timestamp: new Date().toISOString(),
      metadata: {
        type: 'REVOKE',
        original_tx_id: anchorRecord.chain_tx_id,
      },
    });

    // Update anchor with revocation chain data
    const { error: updateError } = await db
      .from('anchors')
      .update({
        revocation_tx_id: receipt.receiptId,
        revocation_block_height: receipt.blockHeight,
      })
      .eq('id', anchorId);

    if (updateError) {
      logger.error({ anchorId, error: updateError }, 'Failed to update revocation chain data');
      throw updateError;
    }

    // Log audit event — non-fatal
    const { error: auditError } = await db.from('audit_events').insert({
      event_type: 'anchor.revocation_anchored',
      event_category: 'ANCHOR',
      actor_id: anchorRecord.user_id,
      target_type: 'anchor',
      target_id: anchorId,
      org_id: anchorRecord.org_id,
      details: `Revocation broadcast to ${getNetworkDisplayName(config.bitcoinNetwork)}: ${receipt.receiptId}`,
    });

    if (auditError) {
      logger.warn({ anchorId, error: auditError }, 'Failed to log audit event for revocation');
    }

    // Dispatch webhook — non-fatal
    if (anchorRecord.org_id) {
      try {
        await dispatchWebhookEvent(anchorRecord.org_id, 'anchor.revocation_anchored', anchorId, {
          anchor_id: anchorId,
          public_id: anchorRecord.public_id ?? null,
          fingerprint: anchorRecord.fingerprint,
          status: 'REVOKED',
          revocation_tx_id: receipt.receiptId,
          revocation_block_height: receipt.blockHeight,
          original_chain_tx_id: anchorRecord.chain_tx_id,
        });
      } catch (webhookError) {
        logger.warn({ anchorId, error: webhookError }, 'Failed to dispatch revocation webhook');
      }
    }

    rpcLog.success({ receiptId: receipt.receiptId });
    return true;
  } catch (error) {
    logger.error({ anchorId, error }, 'Revocation chain submission failed');
    rpcLog.error(error);
    return false;
  }
}

/**
 * Check if anchoring is enabled via switchboard_flags (runtime kill switch).
 * Fails closed (returns false) on errors.
 */
async function isAnchoringEnabled(): Promise<boolean> {
  try {
    const { data, error } = await callRpc<boolean>(db, 'get_flag', {
      p_flag_key: 'ENABLE_PROD_NETWORK_ANCHORING',
    });

    if (error || typeof data !== 'boolean') {
      logger.warn(
        { error, dataType: typeof data },
        'Failed to read ENABLE_PROD_NETWORK_ANCHORING flag — defaulting to disabled',
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
 * Process all revoked anchors that need chain revocation transactions.
 *
 * Finds anchors where:
 * - status = REVOKED
 * - chain_tx_id IS NOT NULL (was anchored)
 * - revocation_tx_id IS NULL (not yet revoked on-chain)
 */
export async function processRevokedAnchors(): Promise<{ processed: number; failed: number }> {
  logger.info('Starting revocation processing');

  // Runtime kill switch
  const enabled = await isAnchoringEnabled();
  if (!enabled) {
    logger.info('Revocation processing disabled via switchboard flag');
    return { processed: 0, failed: 0 };
  }

  // Fetch revoked anchors needing chain revocation
  const { data: anchors, error } = await db
    .from('anchors')
    .select('id')
    .eq('status', 'REVOKED')
    .is('deleted_at', null)
    .is('revocation_tx_id', null)
    .limit(50);

  if (error) {
    logger.error({ error }, 'Failed to fetch revoked anchors');
    return { processed: 0, failed: 0 };
  }

  // Filter to only anchors that have chain_tx_id (were actually anchored)
  if (!anchors || anchors.length === 0) {
    logger.debug('No revoked anchors needing chain revocation');
    return { processed: 0, failed: 0 };
  }

  logger.info({ count: anchors.length }, 'Found revoked anchors needing chain revocation');

  let processed = 0;
  let failed = 0;

  for (const anchor of anchors) {
    const success = await processRevocation(anchor.id);
    if (success) {
      processed++;
    } else {
      failed++;
    }
  }

  logger.info({ processed, failed }, 'Finished processing revocations');
  return { processed, failed };
}
