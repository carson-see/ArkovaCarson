/**
 * Confirmation-proof backfill cron entry (PROOF-03 / SCRUM-2336).
 *
 * Production wiring for {@link populateConfirmationProofsForSecuredAnchors}: it
 * resolves the real inclusion-proof provider + Supabase client from config and
 * drives one bounded backfill pass. Kept SEPARATE from the pure, injectable
 * populate logic in `confirmation-proof-populate.ts` so that module stays free
 * of `config`/`db` imports and remains unit-testable with mocks only.
 *
 * Registered (gated on ENABLE_CONFIRMATION_PROOF_BACKFILL) by
 * `setupScheduledJobs` at a low cadence — DELIBERATELY decoupled from the
 * latency-critical 2-minute `check-confirmations` drain (RP-2): it never touches
 * that hot path, so a header fetch can't slow confirmations.
 *
 * Constitution refs:
 *   - §1.5 Never fabricate a branch: a provider with no inclusion-proof source
 *     yields `pending`, not a synthesized proof.
 *   - §1.9 Real chain calls gated by ENABLE_PROD_NETWORK_ANCHORING.
 */

import { config } from '../config.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { createUtxoProvider, type ConfirmationProofProvider } from '../chain/utxo-provider.js';
import {
  populateConfirmationProofsForSecuredAnchors,
  type PopulateConfirmationProofsResult,
} from './confirmation-proof-populate.js';

/** Result of one backfill cron run, plus a `skipped` flag for mock/anchoring-off. */
export interface ConfirmationProofBackfillRunResult extends PopulateConfirmationProofsResult {
  /** True when the run was a no-op (mock mode or prod anchoring off). */
  skipped: boolean;
  /** anchor_proofs rows scanned this run. */
  scanned: number;
}

const EMPTY_RUN = {
  scanned: 0,
  txAttempted: 0,
  txConfirmed: 0,
  txPending: 0,
  txStale: 0,
  anchorsUpdated: 0,
  anchorsMissing: 0,
} as const;

/**
 * The inclusion-proof provider is built ONCE per process (mirroring the
 * chain-client singleton) and reused across ticks — so we neither reconstruct
 * it nor re-log its `rpcUrl` (which carries the GetBlock token) on every
 * 15-minute run.
 */
let cachedProvider: ConfirmationProofProvider | null = null;

function getInclusionProofProvider(): ConfirmationProofProvider {
  cachedProvider ??= createUtxoProvider({
    type: config.bitcoinUtxoProvider,
    rpcUrl: config.bitcoinRpcUrl,
    rpcAuth: config.bitcoinRpcAuth,
    mempoolApiUrl: config.mempoolApiUrl,
    network: config.bitcoinNetwork,
  });
  return cachedProvider;
}

/** Test-only: clear the memoized provider so a changed config takes effect. */
export function _resetProviderCacheForTest(): void {
  cachedProvider = null;
}

/**
 * Cron entrypoint: build the production inclusion-proof provider from config and
 * populate confirmation proofs for SECURED anchors.
 *
 * No-ops (returns `{ skipped: true }`) in mock mode or when
 * ENABLE_PROD_NETWORK_ANCHORING is off — the inclusion proof needs a real
 * `getblockheader` / `gettxoutproof` source (GetBlock RPC, DISC-03); the mock
 * provider has none, so there is nothing to fetch.
 */
export async function runConfirmationProofBackfill(): Promise<ConfirmationProofBackfillRunResult> {
  if (config.useMocks || !config.enableProdNetworkAnchoring) {
    logger.debug(
      'confirmation-proof backfill skipped — mock mode or prod anchoring off (no real inclusion-proof source)',
    );
    return { skipped: true, ...EMPTY_RUN };
  }

  const provider = getInclusionProofProvider();

  // Mainnet headers need depth before they're durable; signet/testnet 1 is fine.
  const minConfirmations = config.bitcoinNetwork === 'mainnet' ? 6 : 1;

  const result = await populateConfirmationProofsForSecuredAnchors(db, provider, { minConfirmations });
  return { skipped: false, ...result };
}
