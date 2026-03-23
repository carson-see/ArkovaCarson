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
import { isSemanticSearchEnabled } from '../middleware/aiFeatureGate.js';
import { generateAndStoreEmbedding } from '../ai/embeddings.js';
import { createAIProvider } from '../ai/factory.js';
import { sendEmail, buildAnchorSecuredEmail } from '../email/index.js';

/** Maximum unique transactions to check per cron run (rate limit mempool.space) */
const MAX_TX_CHECKS_PER_RUN = 50;

/** Concurrency for parallel mempool.space API calls */
const MEMPOOL_CONCURRENCY = 5;

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

  return networkPaths[config.bitcoinNetwork] ?? 'https://mempool.space/signet';
}

/**
 * Fetch transaction status from mempool.space REST API.
 *
 * @param txid - The transaction ID to look up
 * @returns Transaction response or null if not found/error
 */
/** ERR-2: Retry with exponential backoff for transient mempool.space failures */
const MEMPOOL_MAX_RETRIES = 3;
const MEMPOOL_INITIAL_BACKOFF_MS = 500;

/** Blockstream.info fallback base URLs */
function getBlockstreamBaseUrl(): string {
  const networkPaths: Record<string, string> = {
    testnet4: 'https://blockstream.info/testnet',
    testnet: 'https://blockstream.info/testnet',
    signet: 'https://blockstream.info/signet',
    mainnet: 'https://blockstream.info',
  };
  return networkPaths[config.bitcoinNetwork] ?? 'https://blockstream.info/signet';
}

async function fetchTxStatus(txid: string): Promise<MempoolTxResponse | null> {
  const baseUrl = getMempoolBaseUrl();
  const url = `${baseUrl}/api/tx/${txid}`;

  // ERR-2: Retry with exponential backoff
  for (let attempt = 0; attempt <= MEMPOOL_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        return (await response.json()) as MempoolTxResponse;
      }

      if (response.status === 404) {
        logger.warn({ txid }, 'Transaction not found on mempool.space — may not have propagated yet');
        return null; // 404 is not retryable
      }

      // Rate limited or server error — retry
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MEMPOOL_MAX_RETRIES) {
          const delay = MEMPOOL_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          logger.debug({ txid, attempt, delay, status: response.status }, 'Retrying mempool.space after backoff');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }

      logger.warn({ txid, status: response.status }, 'Mempool.space API returned error');
      break; // Fall through to fallback
    } catch (error) {
      if (attempt < MEMPOOL_MAX_RETRIES) {
        const delay = MEMPOOL_INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        logger.debug({ txid, attempt, delay, error }, 'Retrying mempool.space after network error');
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      logger.warn({ txid, error }, 'All mempool.space retries exhausted');
      break; // Fall through to fallback
    }
  }

  // ERR-2: Fallback to blockstream.info
  try {
    const fallbackUrl = `${getBlockstreamBaseUrl()}/api/tx/${txid}`;
    logger.info({ txid, fallbackUrl }, 'Falling back to blockstream.info');
    const response = await fetch(fallbackUrl, {
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return (await response.json()) as MempoolTxResponse;
    }
  } catch (fallbackError) {
    logger.warn({ txid, error: fallbackError }, 'Blockstream.info fallback also failed');
  }

  return null;
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
      // chain_confirmations: MIN_CONFIRMATIONS, — column pending migration 0068b
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

  // Send "credential secured" email notification (non-blocking, best-effort)
  trySendSecuredEmail(anchor.id, anchor.user_id, anchor.org_id, anchor.public_id).catch((emailErr) => {
    logger.debug({ anchorId: anchor.id, error: emailErr }, 'Secured email skipped or failed (non-fatal)');
  });

  // Auto-generate embedding for semantic search (non-blocking, best-effort)
  // Only runs if ENABLE_SEMANTIC_SEARCH is true and an AI provider is available
  tryAutoEmbed(anchor.id, anchor.org_id, anchor.user_id).catch((embedErr) => {
    logger.debug({ anchorId: anchor.id, error: embedErr }, 'Auto-embed skipped or failed (non-fatal)');
  });

  return true;
}

/**
 * Check all SUBMITTED anchors for confirmation.
 * Called by cron every 2 minutes.
 *
 * Groups anchors by chain_tx_id so Merkle-batched anchors (which share a tx)
 * only require one mempool API call per group. This dramatically improves
 * throughput: 50 tx checks can confirm 1000+ anchors per run.
 */
export async function checkSubmittedConfirmations(): Promise<{ checked: number; confirmed: number }> {
  logger.info('Starting confirmation check for SUBMITTED anchors');

  // In mock mode, auto-confirm all SUBMITTED anchors
  if (config.useMocks || config.nodeEnv === 'test') {
    return autoConfirmMockAnchors();
  }

  // RACE-3: Distributed lock — prevent concurrent cron runs from overlapping.
  // pg_try_advisory_lock returns false (not blocking) if another worker holds the lock.
  const CONFIRMATION_LOCK_ID = 42001; // Unique ID for this job type
  const { data: lockAcquired } = await db.rpc('pg_try_advisory_lock' as never, {
    key: CONFIRMATION_LOCK_ID,
  } as never);
  if (!lockAcquired) {
    logger.info('Confirmation check skipped — another worker holds the advisory lock');
    return { checked: 0, confirmed: 0 };
  }

  // Fetch SUBMITTED anchors — get enough to fill MAX_TX_CHECKS_PER_RUN unique tx_ids
  // We fetch more anchors than tx limit since many share a tx_id (Merkle batching)
  const { data: anchors, error } = await db
    .from('anchors')
    .select('id, chain_tx_id, user_id, org_id, fingerprint, public_id')
    .eq('status', 'SUBMITTED')
    .not('chain_tx_id', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(5000);

  if (error) {
    logger.error({ error }, 'Failed to fetch SUBMITTED anchors');
    return { checked: 0, confirmed: 0 };
  }

  if (!anchors || anchors.length === 0) {
    logger.debug('No SUBMITTED anchors to check');
    return { checked: 0, confirmed: 0 };
  }

  // Group anchors by chain_tx_id
  const txGroups = new Map<string, typeof anchors>();
  for (const anchor of anchors) {
    if (!anchor.chain_tx_id) continue;
    const group = txGroups.get(anchor.chain_tx_id) || [];
    group.push(anchor);
    txGroups.set(anchor.chain_tx_id, group);
  }

  // Take only MAX_TX_CHECKS_PER_RUN unique tx_ids
  const txIds = Array.from(txGroups.keys()).slice(0, MAX_TX_CHECKS_PER_RUN);

  logger.info(
    { uniqueTxIds: txIds.length, totalAnchors: anchors.length, totalUniqueTx: txGroups.size },
    'Checking SUBMITTED anchors grouped by tx_id',
  );

  let confirmed = 0;
  let checked = 0;

  // Process tx groups in parallel batches
  for (let i = 0; i < txIds.length; i += MEMPOOL_CONCURRENCY) {
    const batch = txIds.slice(i, i + MEMPOOL_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (txId) => {
        const txData = await fetchTxStatus(txId);
        checked++;

        if (!txData?.status.confirmed) {
          return 0;
        }

        // PERF-2: Promote ALL anchors sharing this tx_id in parallel batches
        const groupAnchors = txGroups.get(txId) || [];
        let groupConfirmed = 0;

        // Process in parallel batches of 50 to avoid overwhelming DB
        const CONFIRM_BATCH_SIZE = 50;
        for (let j = 0; j < groupAnchors.length; j += CONFIRM_BATCH_SIZE) {
          const batch = groupAnchors.slice(j, j + CONFIRM_BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map((anchor) =>
              checkAnchorConfirmation({
                id: anchor.id,
                chain_tx_id: anchor.chain_tx_id!,
                user_id: anchor.user_id,
                org_id: anchor.org_id,
                fingerprint: anchor.fingerprint,
                public_id: anchor.public_id,
              }),
            ),
          );
          for (const result of results) {
            if (result.status === 'fulfilled' && result.value) groupConfirmed++;
          }
        }

        if (groupConfirmed > 0) {
          logger.info(
            { txId, groupSize: groupAnchors.length, confirmed: groupConfirmed },
            'Confirmed anchor group (shared tx)',
          );
        }

        return groupConfirmed;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        confirmed += result.value;
      }
    }
  }

  // RACE-3: Release advisory lock
  await db.rpc('pg_advisory_unlock' as never, { key: CONFIRMATION_LOCK_ID } as never);

  logger.info(
    { txChecked: checked, anchorsConfirmed: confirmed, totalSubmitted: anchors.length },
    'Confirmation check complete',
  );
  return { checked, confirmed };
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
      // chain_confirmations: 1, — column pending migration 0068b
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

/**
 * Attempt to auto-generate an embedding for a newly SECURED anchor.
 * Non-fatal — if semantic search is disabled, no AI provider, or no metadata,
 * this silently skips without affecting the confirmation flow.
 */
async function tryAutoEmbed(anchorId: string, orgId: string | null, userId: string): Promise<void> {
  // Skip if semantic search is not enabled
  const searchEnabled = await isSemanticSearchEnabled();
  if (!searchEnabled || !orgId) return;

  // Fetch anchor metadata for embedding
  const { data: anchor } = await db
    .from('anchors')
    .select('metadata, credential_type')
    .eq('id', anchorId)
    .single();

  if (!anchor?.metadata) return;

  const metadata = anchor.metadata as Record<string, string | undefined>;
  metadata.credentialType = (anchor.credential_type as string) ?? metadata.credentialType;

  // Only embed if there's meaningful metadata
  const nonEmpty = Object.values(metadata).filter((v) => v && v.length > 0);
  if (nonEmpty.length < 2) return;

  const provider = createAIProvider();
  const result = await generateAndStoreEmbedding(provider, {
    anchorId,
    orgId,
    metadata,
    userId,
  });

  if (result.success) {
    logger.info({ anchorId, model: result.model }, 'Auto-embedded SECURED anchor for semantic search');
  }
}

/**
 * Send "credential secured" email notification to the anchor owner.
 * Non-fatal — if user has no email, or email sending fails, the
 * confirmation flow is not affected.
 */
async function trySendSecuredEmail(
  anchorId: string,
  userId: string,
  orgId: string | null,
  publicId: string | null,
): Promise<void> {
  // Fetch user email
  const { data: profile } = await db
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .single();

  if (!profile?.email) return;

  // Fetch credential label + org name
  const { data: anchor } = await db
    .from('anchors')
    .select('credential_type, metadata')
    .eq('id', anchorId)
    .single();

  const metadata = (anchor?.metadata as Record<string, string | undefined>) ?? {};
  const credentialLabel = metadata.issuerName
    ? `${metadata.issuerName} — ${(anchor?.credential_type as string) ?? 'Credential'}`
    : (anchor?.credential_type as string) ?? 'Credential';

  let organizationName: string | undefined;
  if (orgId) {
    const { data: org } = await db
      .from('organizations')
      .select('display_name')
      .eq('id', orgId)
      .single();
    organizationName = org?.display_name ?? undefined;
  }

  // Build verification URL
  const verificationUrl = publicId
    ? `${config.frontendUrl}/verify/${publicId}`
    : `${config.frontendUrl}/records/${anchorId}`;

  const emailData = buildAnchorSecuredEmail({
    recipientEmail: profile.email,
    credentialLabel,
    verificationUrl,
    organizationName,
  });

  await sendEmail({
    to: profile.email,
    ...emailData,
    emailType: 'anchor_secured',
    anchorId,
    actorId: userId,
    orgId: orgId ?? undefined,
  });

  logger.info({ anchorId, userId }, 'Sent anchor_secured email notification');
}
