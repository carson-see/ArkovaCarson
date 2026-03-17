/**
 * Check Confirmations Job (BETA-01)
 *
 * Polls mempool.space REST API for SUBMITTED anchors to check if their
 * Bitcoin transactions have been confirmed. Promotes SUBMITTED → SECURED
 * when a transaction is mined into a block.
 *
 * Constitution refs:
 *   - 1.4: No PII in mempool API calls, no secrets logged
 *   - 1.9: Gated by ENABLE_PROD_NETWORK_ANCHORING switchboard flag
 *
 * Stories: BETA-01
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { dispatchWebhookEvent } from '../webhooks/delivery.js';

/** Maximum anchors to check per cron run (rate limit mempool.space) */
const MAX_CHECKS_PER_RUN = 10;

/** Minimum confirmations to consider a transaction confirmed */
const MIN_CONFIRMATIONS = 1;

/**
 * Mempool.space transaction status response shape
 */
interface MempoolTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_time?: number;
  block_hash?: string;
}

interface MempoolTxResponse {
  txid: string;
  status: MempoolTxStatus;
}

/**
 * Get the mempool.space API base URL for the configured network.
 */
function getMempoolBaseUrl(): string {
  if (config.mempoolApiUrl) {
    return config.mempoolApiUrl;
  }

  const networkPaths: Record<string, string> = {
    testnet4: 'https://mempool.space/testnet4',
    testnet: 'https://mempool.space/testnet',
    signet: 'https://mempool.space/signet',
    mainnet: 'https://mempool.space',
  };

  return networkPaths[config.bitcoinNetwork] ?? 'https://mempool.space/testnet4';
}

/**
 * Fetch transaction status from mempool.space REST API.
 *
 * @param txid - The transaction ID to look up
 * @returns Transaction response or null if not found/error
 */
async function fetchTxStatus(txid: string): Promise<MempoolTxResponse | null> {
  const baseUrl = getMempoolBaseUrl();
  const url = `${baseUrl}/api/tx/${txid}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      if (response.status === 404) {
        logger.warn({ txid }, 'Transaction not found on mempool.space — may not have propagated yet');
        return null;
      }
      logger.warn({ txid, status: response.status }, 'Mempool.space API returned error');
      return null;
    }

    const data = (await response.json()) as MempoolTxResponse;
    return data;
  } catch (error) {
    logger.warn({ txid, error }, 'Failed to fetch tx status from mempool.space');
    return null;
  }
}

/**
 * Process a single SUBMITTED anchor — check if its transaction has been confirmed.
 *
 * @returns true if anchor was promoted to SECURED
 */
async function checkAnchorConfirmation(anchor: {
  id: string;
  chain_tx_id: string;
  user_id: string;
  org_id: string | null;
  fingerprint: string;
  public_id: string | null;
}): Promise<boolean> {
  const txData = await fetchTxStatus(anchor.chain_tx_id);

  if (!txData?.status.confirmed) {
    logger.debug({ anchorId: anchor.id, txid: anchor.chain_tx_id }, 'Transaction not yet confirmed');
    return false;
  }

  const blockHeight = txData.status.block_height ?? 0;
  const blockTimestamp = txData.status.block_time
    ? new Date(txData.status.block_time * 1000).toISOString()
    : new Date().toISOString();

  // Promote SUBMITTED → SECURED
  const { error: updateError } = await db
    .from('anchors')
    .update({
      status: 'SECURED',
      chain_block_height: blockHeight,
      chain_timestamp: blockTimestamp,
      chain_confirmations: MIN_CONFIRMATIONS,
    })
    .eq('id', anchor.id)
    .eq('status', 'SUBMITTED'); // Guard: only update if still SUBMITTED

  if (updateError) {
    logger.error({ anchorId: anchor.id, error: updateError }, 'Failed to promote anchor to SECURED');
    return false;
  }

  // Update chain index — non-fatal
  const { error: indexError } = await db
    .from('anchor_chain_index')
    .upsert(
      {
        fingerprint_sha256: anchor.fingerprint,
        chain_tx_id: anchor.chain_tx_id,
        chain_block_height: blockHeight,
        chain_block_timestamp: blockTimestamp,
        confirmations: MIN_CONFIRMATIONS,
        anchor_id: anchor.id,
      },
      { onConflict: 'fingerprint_sha256,chain_tx_id' },
    );

  if (indexError) {
    logger.warn({ anchorId: anchor.id, error: indexError }, 'Failed to upsert chain index');
  }

  // Log audit event — non-fatal
  await db.from('audit_events').insert({
    event_type: 'anchor.secured',
    event_category: 'ANCHOR',
    actor_id: anchor.user_id,
    target_type: 'anchor',
    target_id: anchor.id,
    org_id: anchor.org_id,
    details: `Confirmed at block ${blockHeight} (tx: ${anchor.chain_tx_id})`,
  });

  // Dispatch webhook — non-fatal
  if (anchor.org_id) {
    try {
      await dispatchWebhookEvent(anchor.org_id, 'anchor.secured', anchor.id, {
        anchor_id: anchor.id,
        public_id: anchor.public_id,
        fingerprint: anchor.fingerprint,
        status: 'SECURED',
        chain_tx_id: anchor.chain_tx_id,
        chain_block_height: blockHeight,
        secured_at: blockTimestamp,
      });
    } catch (webhookError) {
      logger.warn({ anchorId: anchor.id, error: webhookError }, 'Failed to dispatch webhook for confirmed anchor');
    }
  }

  logger.info(
    { anchorId: anchor.id, txid: anchor.chain_tx_id, blockHeight },
    'Anchor promoted SUBMITTED → SECURED (tx confirmed)',
  );

  return true;
}

/**
 * Check all SUBMITTED anchors for confirmation.
 * Called by cron every 2 minutes.
 */
export async function checkSubmittedConfirmations(): Promise<{ checked: number; confirmed: number }> {
  logger.info('Starting confirmation check for SUBMITTED anchors');

  // In mock mode, auto-confirm all SUBMITTED anchors
  if (config.useMocks || config.nodeEnv === 'test') {
    return autoConfirmMockAnchors();
  }

  // Fetch SUBMITTED anchors with chain_tx_id
  const { data: anchors, error } = await db
    .from('anchors')
    .select('id, chain_tx_id, user_id, org_id, fingerprint, public_id')
    .eq('status', 'SUBMITTED')
    .not('chain_tx_id', 'is', null)
    .is('deleted_at', null)
    .limit(MAX_CHECKS_PER_RUN);

  if (error) {
    logger.error({ error }, 'Failed to fetch SUBMITTED anchors');
    return { checked: 0, confirmed: 0 };
  }

  if (!anchors || anchors.length === 0) {
    logger.debug('No SUBMITTED anchors to check');
    return { checked: 0, confirmed: 0 };
  }

  logger.info({ count: anchors.length }, 'Checking SUBMITTED anchors for confirmation');

  let confirmed = 0;

  for (const anchor of anchors) {
    if (!anchor.chain_tx_id) continue;

    const wasConfirmed = await checkAnchorConfirmation({
      id: anchor.id,
      chain_tx_id: anchor.chain_tx_id,
      user_id: anchor.user_id,
      org_id: anchor.org_id,
      fingerprint: anchor.fingerprint,
      public_id: anchor.public_id,
    });

    if (wasConfirmed) confirmed++;
  }

  logger.info({ checked: anchors.length, confirmed }, 'Confirmation check complete');
  return { checked: anchors.length, confirmed };
}

/**
 * Auto-confirm SUBMITTED anchors in mock/test mode.
 * No mempool.space calls — just promotes all SUBMITTED → SECURED instantly.
 */
async function autoConfirmMockAnchors(): Promise<{ checked: number; confirmed: number }> {
  const { data: anchors, error } = await db
    .from('anchors')
    .select('id')
    .eq('status', 'SUBMITTED')
    .is('deleted_at', null)
    .limit(100);

  if (error || !anchors || anchors.length === 0) {
    return { checked: 0, confirmed: 0 };
  }

  const ids = anchors.map((a) => a.id);

  const { error: updateError } = await db
    .from('anchors')
    .update({
      status: 'SECURED',
      chain_confirmations: 1,
      chain_block_height: 100000,
      chain_timestamp: new Date().toISOString(),
    })
    .in('id', ids)
    .eq('status', 'SUBMITTED');

  if (updateError) {
    logger.error({ error: updateError }, 'Failed to auto-confirm mock anchors');
    return { checked: anchors.length, confirmed: 0 };
  }

  logger.info({ count: anchors.length }, 'Auto-confirmed SUBMITTED anchors (mock mode)');
  return { checked: anchors.length, confirmed: anchors.length };
}
