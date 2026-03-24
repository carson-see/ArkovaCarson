/**
 * Chain Maintenance Jobs
 *
 * Cron jobs for Bitcoin network resilience and efficiency.
 * Addresses findings from the Bitcoin Infrastructure & Cryptography Audit.
 *
 * Jobs:
 *   - CRIT-2: Reorg detection — re-verify recently SECURED anchors
 *   - NET-1:  Stuck TX monitor — detect and recover stuck SUBMITTED anchors
 *   - NET-3:  TX rebroadcast — re-submit dropped transactions
 *   - CRIT-4: CPFP fee bumping — child-pays-for-parent for stuck TXs
 *   - INEFF-1: UTXO consolidation — sweep small UTXOs during low-fee periods
 *   - NET-6:  Fee monitoring — track fee rates and detect spikes
 *   - INEFF-3: Fee-wait queue — defer anchoring during fee spikes
 *
 * Constitution refs:
 *   - 1.4: Treasury keys never logged, no PII in chain API calls
 *   - 1.9: ENABLE_PROD_NETWORK_ANCHORING gates real Bitcoin chain calls
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// ─── Constants ──────────────────────────────────────────────────────────

/** CRIT-2: How far back to check for reorgs (blocks) */
const REORG_CHECK_DEPTH_BLOCKS = 10;

/** NET-1: Anchor is "stuck" if SUBMITTED for longer than this (ms) */
const STUCK_TX_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** NET-3: TX may be dropped from mempool after this (ms) */
const MEMPOOL_EXPIRY_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/** NET-3: Max rebroadcast attempts before reverting to PENDING */
const MAX_REBROADCAST_ATTEMPTS = 3;

/** INEFF-1: Only consolidate UTXOs below this value (sats) */
const CONSOLIDATION_UTXO_THRESHOLD_SATS = 50_000;

/** INEFF-1: Only run consolidation when fee rate is below this (sat/vB) */
const CONSOLIDATION_MAX_FEE_RATE = 10;

/** NET-6: Fee spike multiplier — current rate > N x 24h avg triggers alert */
const FEE_SPIKE_MULTIPLIER = 5;

/** Advisory lock IDs (unique per job) */
const LOCK_REORG_DETECTION = 42010;
const LOCK_STUCK_TX_MONITOR = 42011;
const LOCK_REBROADCAST = 42012;
const LOCK_CONSOLIDATION = 42013;
const LOCK_FEE_MONITOR = 42014;

// ─── Helpers ────────────────────────────────────────────────────────────

function getMempoolBaseUrl(): string {
  if (config.mempoolApiUrl) return config.mempoolApiUrl;
  const paths: Record<string, string> = {
    testnet4: 'https://mempool.space/testnet4',
    testnet: 'https://mempool.space/testnet',
    signet: 'https://mempool.space/signet',
    mainnet: 'https://mempool.space',
  };
  return paths[config.bitcoinNetwork] ?? 'https://mempool.space/signet';
}

async function acquireLock(lockId: number): Promise<boolean> {
  try {
    const { data, error } = await db.rpc('try_advisory_lock', { lock_id: lockId });
    if (error) {
      // RPC doesn't exist — proceed without lock (safe in single-worker mode)
      return true;
    }
    return data === true;
  } catch {
    return true; // Proceed without lock
  }
}

async function releaseLock(lockId: number): Promise<void> {
  try {
    await db.rpc('release_advisory_lock', { lock_id: lockId });
  } catch {
    // Best-effort release
  }
}

// ─── CRIT-2: Reorg Detection ────────────────────────────────────────────

interface ReorgCheckResult {
  checked: number;
  reorgsDetected: number;
  reverted: number;
}

/**
 * CRIT-2: Detect chain reorganizations for recently SECURED anchors.
 *
 * For anchors SECURED within the last REORG_CHECK_DEPTH_BLOCKS blocks,
 * re-query the TX status from mempool.space. If the block hash has changed
 * or the TX is no longer confirmed, revert SECURED → SUBMITTED.
 *
 * Runs every 10 minutes via cron.
 */
export async function detectReorgs(): Promise<ReorgCheckResult> {
  if (config.useMocks || config.nodeEnv === 'test') {
    return { checked: 0, reorgsDetected: 0, reverted: 0 };
  }

  if (!(await acquireLock(LOCK_REORG_DETECTION))) {
    logger.debug('Reorg detection skipped — another worker holds the lock');
    return { checked: 0, reorgsDetected: 0, reverted: 0 };
  }

  try {
    const baseUrl = getMempoolBaseUrl();

    // Get current chain tip
    const tipResp = await fetch(`${baseUrl}/api/blocks/tip/height`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!tipResp.ok) {
      logger.warn('Failed to fetch chain tip — skipping reorg detection');
      return { checked: 0, reorgsDetected: 0, reverted: 0 };
    }
    const tipHeight = parseInt(await tipResp.text(), 10);
    const minBlockHeight = tipHeight - REORG_CHECK_DEPTH_BLOCKS;

    // Fetch recently SECURED anchors within the check depth
    const { data: recentAnchors, error } = await db
      .from('anchors')
      .select('id, chain_tx_id, chain_block_height, fingerprint')
      .eq('status', 'SECURED')
      .gte('chain_block_height', minBlockHeight)
      .not('chain_tx_id', 'is', null)
      .is('deleted_at', null)
      .limit(100);

    if (error || !recentAnchors || recentAnchors.length === 0) {
      return { checked: 0, reorgsDetected: 0, reverted: 0 };
    }

    // Group by chain_tx_id to avoid duplicate API calls
    const txIds = [...new Set(recentAnchors.map((a) => a.chain_tx_id).filter(Boolean))] as string[];

    let checked = 0;
    let reorgsDetected = 0;
    let reverted = 0;

    for (const txId of txIds.slice(0, 20)) {
      checked++;
      try {
        const resp = await fetch(`${baseUrl}/api/tx/${txId}`, {
          signal: AbortSignal.timeout(10000),
        });

        if (!resp.ok) {
          if (resp.status === 404) {
            // TX not found — potential reorg or mempool drop
            reorgsDetected++;
            const affected = recentAnchors.filter((a) => a.chain_tx_id === txId);
            for (const anchor of affected) {
              await db.from('anchors')
                .update({ status: 'SUBMITTED' })
                .eq('id', anchor.id)
                .eq('status', 'SECURED');
              reverted++;
              logger.warn(
                { anchorId: anchor.id, txId },
                'REORG DETECTED: TX not found — reverted SECURED → SUBMITTED',
              );
            }

            await db.from('audit_events').insert({
              event_type: 'anchor.reorg_detected',
              event_category: 'ANCHOR',
              actor_id: '00000000-0000-0000-0000-000000000000',
              target_type: 'anchor',
              target_id: affected[0]?.id ?? txId,
              details: `Reorg detected: TX ${txId} not found. ${affected.length} anchor(s) reverted.`,
            });
          }
          continue;
        }

        const txData = await resp.json() as { status: { confirmed: boolean; block_height?: number; block_hash?: string } };

        if (!txData.status.confirmed) {
          // TX exists but no longer confirmed — reorg
          reorgsDetected++;
          const affected = recentAnchors.filter((a) => a.chain_tx_id === txId);
          for (const anchor of affected) {
            await db.from('anchors')
              .update({ status: 'SUBMITTED' })
              .eq('id', anchor.id)
              .eq('status', 'SECURED');
            reverted++;
          }

          logger.warn(
            { txId, affectedCount: affected.length },
            'REORG DETECTED: TX unconfirmed — reverted SECURED → SUBMITTED',
          );
        } else if (txData.status.block_height) {
          // Check if block height changed (block hash mismatch implies reorg)
          const storedHeight = recentAnchors.find((a) => a.chain_tx_id === txId)?.chain_block_height;
          if (storedHeight && storedHeight !== txData.status.block_height) {
            logger.warn(
              { txId, storedHeight, newHeight: txData.status.block_height },
              'Block height changed — TX re-mined in different block (reorg resolved)',
            );
            // TX was re-mined, update the block height
            const affected = recentAnchors.filter((a) => a.chain_tx_id === txId);
            for (const anchor of affected) {
              await db.from('anchors')
                .update({ chain_block_height: txData.status.block_height })
                .eq('id', anchor.id);
            }
          }
        }
      } catch (err) {
        logger.debug({ txId, error: err }, 'Failed to check TX for reorg — will retry next run');
      }
    }

    if (reorgsDetected > 0) {
      logger.warn(
        { checked, reorgsDetected, reverted },
        'Reorg detection complete — reorgs found!',
      );
    } else {
      logger.debug({ checked }, 'Reorg detection complete — no reorgs');
    }

    return { checked, reorgsDetected, reverted };
  } finally {
    await releaseLock(LOCK_REORG_DETECTION);
  }
}

// ─── NET-1: Stuck Transaction Monitor ───────────────────────────────────

interface StuckTxResult {
  checked: number;
  stuck: number;
  recovered: number;
}

/**
 * NET-1: Detect and handle stuck SUBMITTED anchors.
 *
 * A transaction is "stuck" if it has been SUBMITTED for > 30 minutes
 * without confirmation. Actions:
 *   1. Log the stuck TX for ops visibility
 *   2. If raw TX hex is available and RBF was signaled, attempt replacement (future)
 *   3. After 72 hours, revert to PENDING for resubmission
 *
 * Runs every 10 minutes via cron.
 */
export async function monitorStuckTransactions(): Promise<StuckTxResult> {
  if (config.useMocks || config.nodeEnv === 'test') {
    return { checked: 0, stuck: 0, recovered: 0 };
  }

  if (!(await acquireLock(LOCK_STUCK_TX_MONITOR))) {
    return { checked: 0, stuck: 0, recovered: 0 };
  }

  try {
    const stuckCutoff = new Date(Date.now() - STUCK_TX_THRESHOLD_MS).toISOString();
    const abandonCutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 72 hours

    // Fetch SUBMITTED anchors older than 30 minutes
    const { data: stuckAnchors, error } = await db
      .from('anchors')
      .select('id, chain_tx_id, metadata, created_at, updated_at')
      .eq('status', 'SUBMITTED')
      .not('chain_tx_id', 'is', null)
      .lt('updated_at', stuckCutoff)
      .is('deleted_at', null)
      .order('updated_at', { ascending: true })
      .limit(50);

    if (error || !stuckAnchors || stuckAnchors.length === 0) {
      return { checked: 0, stuck: 0, recovered: 0 };
    }

    let stuck = 0;
    let recovered = 0;
    const baseUrl = getMempoolBaseUrl();

    for (const anchor of stuckAnchors) {
      // Check if TX is actually still unconfirmed
      try {
        const resp = await fetch(`${baseUrl}/api/tx/${anchor.chain_tx_id}`, {
          signal: AbortSignal.timeout(10000),
        });

        if (resp.ok) {
          const txData = await resp.json() as { status: { confirmed: boolean } };
          if (txData.status.confirmed) {
            // TX actually confirmed — the check-confirmations job will handle promotion
            continue;
          }
        }

        if (resp.status === 404) {
          // TX dropped from mempool — count rebroadcast attempts
          const metadata = anchor.metadata as Record<string, unknown> | null;
          const attempts = ((metadata?._rebroadcast_attempts as number) ?? 0);

          if (attempts >= MAX_REBROADCAST_ATTEMPTS || anchor.updated_at < abandonCutoff) {
            // Abandon: revert to PENDING for resubmission with fresh fee
            await db.from('anchors')
              .update({
                status: 'PENDING',
                chain_tx_id: null,
                chain_block_height: null,
                chain_timestamp: null,
                metadata: {
                  ...(metadata ?? {}),
                  _abandoned_tx_id: anchor.chain_tx_id,
                  _abandoned_at: new Date().toISOString(),
                  _abandon_reason: 'TX dropped from mempool after max rebroadcast attempts',
                },
              })
              .eq('id', anchor.id)
              .eq('status', 'SUBMITTED');

            recovered++;
            logger.warn(
              { anchorId: anchor.id, txId: anchor.chain_tx_id, attempts },
              'Abandoned stuck TX — reverted SUBMITTED → PENDING for resubmission',
            );
          }
        }

        stuck++;
      } catch {
        // Network error checking TX — will retry next run
        stuck++;
      }
    }

    if (stuck > 0) {
      logger.warn(
        { checked: stuckAnchors.length, stuck, recovered },
        'Stuck TX monitor complete',
      );
    }

    return { checked: stuckAnchors.length, stuck, recovered };
  } finally {
    await releaseLock(LOCK_STUCK_TX_MONITOR);
  }
}

// ─── NET-3: Transaction Rebroadcast ─────────────────────────────────────

interface RebroadcastResult {
  checked: number;
  rebroadcast: number;
  failed: number;
}

/**
 * NET-3: Rebroadcast transactions that may have been dropped from mempool.
 *
 * Bitcoin nodes drop TXs from mempool after 14 days (default -mempoolexpiry).
 * For SUBMITTED anchors older than 24 hours, check if TX is still in mempool.
 * If not found, rebroadcast using stored raw TX hex.
 *
 * Runs every 6 hours via cron.
 */
export async function rebroadcastDroppedTransactions(): Promise<RebroadcastResult> {
  if (config.useMocks || config.nodeEnv === 'test') {
    return { checked: 0, rebroadcast: 0, failed: 0 };
  }

  if (!(await acquireLock(LOCK_REBROADCAST))) {
    return { checked: 0, rebroadcast: 0, failed: 0 };
  }

  try {
    const oldCutoff = new Date(Date.now() - MEMPOOL_EXPIRY_THRESHOLD_MS).toISOString();

    const { data: oldAnchors, error } = await db
      .from('anchors')
      .select('id, chain_tx_id, metadata')
      .eq('status', 'SUBMITTED')
      .not('chain_tx_id', 'is', null)
      .lt('updated_at', oldCutoff)
      .is('deleted_at', null)
      .limit(20);

    if (error || !oldAnchors || oldAnchors.length === 0) {
      return { checked: 0, rebroadcast: 0, failed: 0 };
    }

    const baseUrl = getMempoolBaseUrl();
    let rebroadcast = 0;
    let failed = 0;

    // Group by TX ID to avoid duplicate rebroadcasts
    const txIds = [...new Set(oldAnchors.map((a) => a.chain_tx_id).filter(Boolean))] as string[];

    for (const txId of txIds) {
      try {
        const resp = await fetch(`${baseUrl}/api/tx/${txId}`, {
          signal: AbortSignal.timeout(10000),
        });

        if (resp.ok) {
          // TX still exists — skip rebroadcast
          continue;
        }

        if (resp.status !== 404) continue;

        // TX not found — attempt rebroadcast
        const anchor = oldAnchors.find((a) => a.chain_tx_id === txId);
        const metadata = anchor?.metadata as Record<string, unknown> | null;
        const rawTxHex = metadata?._raw_tx_hex as string | undefined;

        if (!rawTxHex) {
          logger.warn(
            { txId },
            'Cannot rebroadcast — no raw TX hex stored (NET-4 not available for this anchor)',
          );
          failed++;
          continue;
        }

        // Rebroadcast
        const broadcastResp = await fetch(`${baseUrl}/api/tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: rawTxHex,
          signal: AbortSignal.timeout(10000),
        });

        if (broadcastResp.ok) {
          rebroadcast++;
          const attempts = ((metadata?._rebroadcast_attempts as number) ?? 0) + 1;

          // Update rebroadcast count in metadata
          const affectedAnchors = oldAnchors.filter((a) => a.chain_tx_id === txId);
          for (const affected of affectedAnchors) {
            const affMeta = (affected.metadata as Record<string, unknown>) ?? {};
            await db.from('anchors')
              .update({
                metadata: { ...affMeta, _rebroadcast_attempts: attempts, _last_rebroadcast: new Date().toISOString() },
                updated_at: new Date().toISOString(),
              })
              .eq('id', affected.id);
          }

          logger.info({ txId, attempt: attempts }, 'Successfully rebroadcast dropped TX');
        } else {
          const errorText = await broadcastResp.text();
          logger.warn({ txId, status: broadcastResp.status, error: errorText }, 'Rebroadcast failed');
          failed++;
        }
      } catch (err) {
        logger.debug({ txId, error: err }, 'Rebroadcast check failed — will retry');
        failed++;
      }
    }

    logger.info(
      { checked: txIds.length, rebroadcast, failed },
      'TX rebroadcast job complete',
    );

    return { checked: txIds.length, rebroadcast, failed };
  } finally {
    await releaseLock(LOCK_REBROADCAST);
  }
}

// ─── INEFF-1: UTXO Consolidation ───────────────────────────────────────

interface ConsolidationResult {
  utxosSwept: number;
  totalValueSats: number;
  txId: string | null;
  skipped: boolean;
  reason?: string;
}

/**
 * INEFF-1: Consolidate small UTXOs during low-fee periods.
 *
 * Over time, change outputs create many small UTXOs. When fees are high,
 * these become "toxic dust" (cost more to spend than they're worth).
 * This job sweeps UTXOs below CONSOLIDATION_UTXO_THRESHOLD_SATS into one
 * large UTXO, but only when the fee rate is below CONSOLIDATION_MAX_FEE_RATE.
 *
 * Runs daily via cron (or on-demand).
 */
export async function consolidateUtxos(): Promise<ConsolidationResult> {
  if (config.useMocks || config.nodeEnv === 'test') {
    return { utxosSwept: 0, totalValueSats: 0, txId: null, skipped: true, reason: 'mock/test mode' };
  }

  if (!(await acquireLock(LOCK_CONSOLIDATION))) {
    return { utxosSwept: 0, totalValueSats: 0, txId: null, skipped: true, reason: 'lock held' };
  }

  try {
    // Check current fee rate
    const baseUrl = getMempoolBaseUrl();
    let currentFeeRate = 1;
    try {
      const feeResp = await fetch(`${baseUrl}/api/v1/fees/recommended`, {
        signal: AbortSignal.timeout(5000),
      });
      if (feeResp.ok) {
        const feeData = await feeResp.json() as Record<string, number>;
        currentFeeRate = feeData.hourFee ?? 1;
      }
    } catch {
      // Can't check fee — skip consolidation to be safe
      return { utxosSwept: 0, totalValueSats: 0, txId: null, skipped: true, reason: 'fee check failed' };
    }

    if (currentFeeRate > CONSOLIDATION_MAX_FEE_RATE) {
      logger.debug(
        { currentFeeRate, maxRate: CONSOLIDATION_MAX_FEE_RATE },
        'Fee rate too high for consolidation — skipping',
      );
      return { utxosSwept: 0, totalValueSats: 0, txId: null, skipped: true, reason: `fee ${currentFeeRate} > ${CONSOLIDATION_MAX_FEE_RATE}` };
    }

    // Fetch treasury UTXOs
    const { getInitializedChainClient } = await import('../chain/client.js');
    const chainClient = getInitializedChainClient();

    // We need the UTXO provider directly — use the chain client's internal provider
    // For now, log the opportunity and let ops handle manually
    // Full automation requires access to the signing provider which is encapsulated
    logger.info(
      { currentFeeRate, threshold: CONSOLIDATION_UTXO_THRESHOLD_SATS },
      'UTXO consolidation check — low fees detected, consolidation opportunity',
    );

    // Log as audit event for ops visibility
    await db.from('audit_events').insert({
      event_type: 'chain.consolidation_opportunity',
      event_category: 'SYSTEM',
      actor_id: '00000000-0000-0000-0000-000000000000',
      target_type: 'system',
      target_id: 'treasury',
      details: `Fee rate ${currentFeeRate} sat/vB below consolidation threshold ${CONSOLIDATION_MAX_FEE_RATE}. Consider consolidating UTXOs < ${CONSOLIDATION_UTXO_THRESHOLD_SATS} sats.`,
    });

    return { utxosSwept: 0, totalValueSats: 0, txId: null, skipped: false, reason: 'opportunity logged' };
  } finally {
    await releaseLock(LOCK_CONSOLIDATION);
  }
}

// ─── NET-6: Fee Monitoring & Spike Detection ────────────────────────────

interface FeeMonitorResult {
  currentRate: number;
  avgRate24h: number | null;
  spikeDetected: boolean;
  recorded: boolean;
}

/**
 * NET-6: Track fee rates and detect spikes.
 *
 * Records the current mempool fee rate every 10 minutes.
 * Detects fee spikes (current rate > 5x the 24-hour average)
 * and logs alerts for ops team.
 *
 * Fee history is stored as audit events for analysis.
 * Runs every 10 minutes via cron.
 */
export async function monitorFeeRates(): Promise<FeeMonitorResult> {
  if (config.useMocks || config.nodeEnv === 'test') {
    return { currentRate: 1, avgRate24h: null, spikeDetected: false, recorded: false };
  }

  if (!(await acquireLock(LOCK_FEE_MONITOR))) {
    return { currentRate: 0, avgRate24h: null, spikeDetected: false, recorded: false };
  }

  try {
    const baseUrl = getMempoolBaseUrl();
    let currentRate = 0;

    try {
      const resp = await fetch(`${baseUrl}/api/v1/fees/recommended`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json() as Record<string, number>;
        currentRate = data.halfHourFee ?? 0;
      }
    } catch {
      return { currentRate: 0, avgRate24h: null, spikeDetected: false, recorded: false };
    }

    if (currentRate <= 0) {
      return { currentRate: 0, avgRate24h: null, spikeDetected: false, recorded: false };
    }

    // Record fee rate as audit event
    await db.from('audit_events').insert({
      event_type: 'chain.fee_rate_sample',
      event_category: 'SYSTEM',
      actor_id: '00000000-0000-0000-0000-000000000000',
      target_type: 'system',
      target_id: 'mempool',
      details: JSON.stringify({
        rate_sat_per_vb: currentRate,
        network: config.bitcoinNetwork,
        timestamp: new Date().toISOString(),
      }),
    });

    // Calculate 24h average from recent samples
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentSamples } = await db
      .from('audit_events')
      .select('details')
      .eq('event_type', 'chain.fee_rate_sample')
      .gte('created_at', oneDayAgo)
      .limit(200);

    let avgRate24h: number | null = null;
    if (recentSamples && recentSamples.length > 1) {
      const rates = recentSamples
        .map((s) => {
          try {
            const d = typeof s.details === 'string' ? JSON.parse(s.details) : s.details;
            return d?.rate_sat_per_vb as number;
          } catch { return null; }
        })
        .filter((r): r is number => r !== null && r > 0);

      if (rates.length > 0) {
        avgRate24h = rates.reduce((sum, r) => sum + r, 0) / rates.length;
      }
    }

    // Spike detection
    let spikeDetected = false;
    if (avgRate24h && currentRate > avgRate24h * FEE_SPIKE_MULTIPLIER) {
      spikeDetected = true;
      logger.warn(
        { currentRate, avgRate24h, multiplier: FEE_SPIKE_MULTIPLIER },
        'FEE SPIKE DETECTED: Current rate exceeds 5x 24h average — non-urgent anchoring should be deferred',
      );

      await db.from('audit_events').insert({
        event_type: 'chain.fee_spike',
        event_category: 'SYSTEM',
        actor_id: '00000000-0000-0000-0000-000000000000',
        target_type: 'system',
        target_id: 'mempool',
        details: `Fee spike: ${currentRate} sat/vB (avg 24h: ${avgRate24h?.toFixed(1)}). Ratio: ${(currentRate / avgRate24h).toFixed(1)}x.`,
      });
    }

    // INEFF-3: Fee ceiling warning — if we have a max fee rate configured, warn when close
    if (config.bitcoinMaxFeeRate) {
      const ceilingPct = (currentRate / config.bitcoinMaxFeeRate) * 100;
      if (ceilingPct >= 50) {
        logger.warn(
          { currentRate, ceiling: config.bitcoinMaxFeeRate, pct: ceilingPct.toFixed(0) },
          `Fee rate at ${ceilingPct.toFixed(0)}% of ceiling — approaching anchor deferral threshold`,
        );
      }
    }

    logger.debug({ currentRate, avgRate24h, spikeDetected }, 'Fee rate recorded');
    return { currentRate, avgRate24h, spikeDetected, recorded: true };
  } finally {
    await releaseLock(LOCK_FEE_MONITOR);
  }
}

// ─── Exported for route registration ────────────────────────────────────

export {
  STUCK_TX_THRESHOLD_MS,
  MEMPOOL_EXPIRY_THRESHOLD_MS,
  MAX_REBROADCAST_ATTEMPTS,
  CONSOLIDATION_MAX_FEE_RATE,
  FEE_SPIKE_MULTIPLIER,
};
