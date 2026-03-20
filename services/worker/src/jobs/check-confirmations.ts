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

  return networkPaths[config.bitcoinNetwork] ?? 'https://mempool.space/signet';
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
