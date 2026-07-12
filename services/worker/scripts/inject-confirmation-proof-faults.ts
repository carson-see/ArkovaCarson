#!/usr/bin/env tsx
/**
 * #1408 — Confirmation-proof FAULT-INJECTION staging driver.
 *
 * The chain-resilience rig (#1408) never exercised the transient-vs-definitive
 * RPC-failure classification of `/jobs/populate-confirmation-proofs`
 * (`/jobs/populate-confirmation-proofs` got 0 hits in 6h). This driver closes
 * that gap ON A REAL STAGING DB by wrapping the real inclusion-proof provider in
 * a deterministic fault injector and running the ACTUAL populate fan-out
 * (`populateConfirmationProofsForSecuredAnchors`), then asserting the empirical
 * classification distribution:
 *
 *   TRANSIENT injected fault (HTTP 5xx / 429 / timeout / ECONNRESET) ⇒ txPending
 *     (recoverable — the row is left for the next tick, NOT poisoned stale, NOT
 *      persisted).
 *   DEFINITIVE injected fault (JSON-RPC app error / HTTP 4xx)        ⇒ txStale
 *     (non-retryable — parked, NOT persisted).
 *
 * This is a DRIVER, not a soak: it proves the classification branch fires under
 * a real provider + real Supabase scan. A full T3 soak (48h, multiple trigger
 * cycles) is still owed on an isolated rig — see the workflow report.
 *
 * SAFETY / §1.11A:
 *   - Points ONLY at the Supabase project ref you pass via env. NEVER point it
 *     at prod (vzwyaatejekddvltxyye) — the script refuses that ref outright.
 *   - The transient/stale paths persist NOTHING (that's the whole assertion), so
 *     even a mistargeted run cannot mutate anchor_proofs on those paths.
 *   - No treasury key, no broadcast, no migration. Read scan + (on the
 *     control-run only) idempotent confirmed writes to the target staging DB.
 *   - No secrets logged (§1.4): the token-bearing rpcUrl is never printed.
 *
 * Usage (from services/worker):
 *   SUPABASE_URL=https://<staging-ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<staging-service-role> \
 *   BITCOIN_RPC_URL=<getblock-rpc-url> \
 *   BITCOIN_UTXO_PROVIDER=getblock BITCOIN_NETWORK=mainnet \
 *   ENABLE_PROD_NETWORK_ANCHORING=true \
 *   npx tsx scripts/inject-confirmation-proof-faults.ts [--fault=transient|definitive|both] [--max-rows=200]
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const PROD_REF = 'vzwyaatejekddvltxyye';

type FaultKind = 'transient' | 'definitive';

function parseArgs(): { fault: 'transient' | 'definitive' | 'both'; maxRows: number } {
  const args = process.argv.slice(2);
  const faultArg = (args.find((a) => a.startsWith('--fault='))?.split('=')[1] ?? 'both') as
    | 'transient'
    | 'definitive'
    | 'both';
  const maxRows = Number.parseInt(args.find((a) => a.startsWith('--max-rows='))?.split('=')[1] ?? '200', 10) || 200;
  return { fault: faultArg, maxRows };
}

async function main(): Promise<void> {
  const { fault, maxRows } = parseArgs();
  console.log('=== #1408 Confirmation-proof fault-injection driver ===\n');

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (staging only).');
    process.exit(1);
  }
  if (supabaseUrl.includes(PROD_REF)) {
    console.error(`ERROR: refusing to run against the PROD project ref (${PROD_REF}). Staging only.`);
    process.exit(1);
  }

  // Dynamic imports AFTER dotenv (config.ts reads env at import time).
  const { createClient } = await import('@supabase/supabase-js');
  const { createUtxoProvider, HttpError } = await import('../src/chain/utxo-provider.js');
  const { populateConfirmationProofsForSecuredAnchors } = await import('../src/jobs/confirmation-proof-populate.js');
  const { fetchConfirmationProof } = await import('../src/chain/confirmation-proof.js');
  type ConfirmationProofProvider = import('../src/chain/utxo-provider.js').ConfirmationProofProvider;

  const client = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });

  // Real provider (GetBlock-backed) — proves the classifier fires against the
  // production provider surface, not just a mock.
  const realProvider = createUtxoProvider({
    type: (process.env.BITCOIN_UTXO_PROVIDER as 'getblock' | 'rpc' | 'mempool') ?? 'getblock',
    rpcUrl: process.env.BITCOIN_RPC_URL,
    rpcAuth: process.env.BITCOIN_RPC_AUTH,
    mempoolApiUrl: process.env.MEMPOOL_API_URL,
    network: process.env.BITCOIN_NETWORK ?? 'mainnet',
  });

  const injectors: Record<FaultKind, () => Error> = {
    transient: () => new HttpError('injected transient: RPC gettxoutproof failed: HTTP 503', 503),
    definitive: () => new Error('injected definitive: RPC gettxoutproof error: Block not found (code -5)'),
  };

  /** Wrap the real provider so BOTH inclusion-proof calls throw the injected
   *  fault; getRawTransaction still hits the real node (so the tx is genuinely
   *  found + confirmed, isolating the fault to the header/proof step). */
  const wrap = (kind: FaultKind): ConfirmationProofProvider => ({
    getRawTransaction: (txid: string) => realProvider.getRawTransaction(txid),
    getBlockHeaderHex: async () => {
      throw injectors[kind]();
    },
    getTxOutProof: async () => {
      throw injectors[kind]();
    },
  });

  const kinds: FaultKind[] = fault === 'both' ? ['transient', 'definitive'] : [fault];
  const minConfirmations = (process.env.BITCOIN_NETWORK ?? 'mainnet') === 'mainnet' ? 6 : 1;

  let ok = true;
  for (const kind of kinds) {
    console.log(`--- injecting ${kind.toUpperCase()} fault (maxRows=${maxRows}) ---`);
    const result = await populateConfirmationProofsForSecuredAnchors(client, wrap(kind), {
      minConfirmations,
      maxRows,
    });
    console.log(JSON.stringify(result, null, 2));

    const expectPending = kind === 'transient';
    const classified = expectPending ? result.txPending : result.txStale;
    const wrong = expectPending ? result.txStale : result.txPending;

    if (result.txAttempted === 0) {
      console.warn(
        `  WARN: 0 candidate txs scanned — staging has no app-tree-complete / header-missing SECURED anchors. Seed some before asserting.`,
      );
    } else if (classified === result.txAttempted && wrong === 0 && result.anchorsUpdated === 0) {
      console.log(
        `  PASS: all ${result.txAttempted} tx(s) classified ${expectPending ? 'PENDING' : 'STALE'}; 0 mis-classified; 0 persisted.`,
      );
    } else {
      ok = false;
      console.error(
        `  FAIL: expected all ${result.txAttempted} → ${expectPending ? 'txPending' : 'txStale'} & 0 persisted; got pending=${result.txPending} stale=${result.txStale} confirmed=${result.txConfirmed} persisted=${result.anchorsUpdated}.`,
      );
    }
    console.log('');
  }

  // Sanity: a NON-injected single fetch against the real provider should NOT be
  // stale for a healthy mined tx (guards against the classifier over-firing).
  console.log('--- control: real provider, no injected fault (informational) ---');
  if (!process.env.CONTROL_TXID) {
    console.log('  (skipped — set CONTROL_TXID to a healthy mined anchor tx to run the control)');
  } else {
    const proof = await fetchConfirmationProof(realProvider, {
      chainTxId: process.env.CONTROL_TXID,
      minConfirmations,
    });
    console.log(`  control txid status=${proof.status} reason=${proof.reason ?? '(none)'}`);
    if (proof.status === 'stale') {
      ok = false;
      console.error('  FAIL: healthy control tx classified stale — classifier over-fires.');
    }
  }

  console.log(ok ? '\n=== DRIVER PASS ===' : '\n=== DRIVER FAIL ===');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('driver error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
