/**
 * SCRUM-3188 — real-world wiring for the supplementary proof anchor job.
 *
 * The job itself (`supplementary-proof-anchor.ts`) is pure policy over the
 * `SupplementaryPorts` interface. This file is the only place those ports touch
 * the database, the chain, and the treasury — which is what makes the
 * "no capability to write to `anchors`" guarantee auditable in one screen.
 *
 * §1.4: the treasury WIF is read from config to DERIVE the public address and
 * for signing inside the chain client. It is never logged, never returned, and
 * never leaves this process.
 */

import { db } from '../utils/db.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { getChainClientAsync } from '../chain/client.js';
import { createUtxoProvider } from '../chain/utxo-provider.js';
import { addressFromWif } from '../chain/wallet.js';
import { extractAnchorFingerprint } from '../chain/signet.js';
import type { Json } from '../types/database.types.js';
import type {
  SupplementaryPorts,
  SupplementaryCohortRow,
} from './supplementary-proof-anchor.js';

/** Treasury UTXO provider, built from the same config the producer uses. */
function utxoProvider() {
  return createUtxoProvider({
    type: config.bitcoinUtxoProvider as 'rpc' | 'mempool' | 'getblock',
    rpcUrl: config.bitcoinRpcUrl,
    rpcAuth: config.bitcoinRpcAuth,
    mempoolApiUrl: config.mempoolApiUrl,
    network: config.bitcoinNetwork,
  });
}

export function createSupplementaryPorts(): SupplementaryPorts {
  return {
    async countRemaining() {
      const { data, error } = await db.rpc('supplementary_proof_backlog_count', {
        p_max: 5_000_000,
      });
      if (error) throw new Error(`backlog count failed: ${error.message}`);
      const row = data as unknown as { count?: number } | null;
      return Number(row?.count ?? 0);
    },

    async claimCohort(limit, priorityOrgIds, deprioritizedCredentialTypes) {
      const { data, error } = await db.rpc('claim_supplementary_proof_cohort', {
        p_limit: limit,
        p_priority_org_ids: priorityOrgIds,
        p_deprioritized_credential_types: deprioritizedCredentialTypes,
      });
      if (error) throw new Error(`cohort claim failed: ${error.message}`);
      const rows = (data ?? []) as Array<{
        anchor_id: string;
        fingerprint: string;
        chain_tx_id: string;
        org_id: string | null;
      }>;
      return rows.map<SupplementaryCohortRow>((r) => ({
        anchorId: r.anchor_id,
        fingerprint: r.fingerprint,
        chainTxId: r.chain_tx_id,
        orgId: r.org_id,
      }));
    },

    async getFeeRate() {
      const client = await getChainClientAsync();
      if (typeof client.estimateCurrentFee !== 'function') {
        // Fail CLOSED: an unknown fee rate must not be treated as a cheap one.
        throw new Error('chain client cannot estimate fees — refusing to spend blind');
      }
      const rate = await client.estimateCurrentFee();
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`implausible fee rate from provider: ${rate}`);
      }
      return rate;
    },

    async getConfirmedBalanceSats() {
      if (!config.bitcoinTreasuryWif) {
        throw new Error('treasury wallet not configured — refusing to plan a spend');
      }
      const address = addressFromWif(config.bitcoinTreasuryWif);
      const utxos = await utxoProvider().listUnspent(address);
      // Only CONFIRMED value is spendable for planning purposes.
      return utxos.reduce((sum, u) => sum + (u.valueSats ?? 0), 0);
    },

    async prepareTx(root: string) {
      const client = await getChainClientAsync();
      if (typeof client.prepareFingerprintTx !== 'function') {
        throw new Error('chain client cannot sign without broadcasting — required for the journal barrier');
      }
      const prepared = await client.prepareFingerprintTx({
        fingerprint: root,
        timestamp: new Date().toISOString(),
      });
      if (prepared.opReturnData.length / 2 > 80) {
        throw new Error('OP_RETURN payload exceeds 80 bytes');
      }
      return {
        txId: prepared.txId,
        txHex: prepared.txHex,
        feeSats: prepared.feeSats,
        opReturnData: prepared.opReturnData,
      };
    },

    async broadcast(txHex: string) {
      const client = await getChainClientAsync();
      if (typeof client.broadcastSignedTx !== 'function') {
        throw new Error('chain client cannot broadcast pre-signed bytes');
      }
      const receipt = await client.broadcastSignedTx(txHex);
      return {
        receiptId: receipt.receiptId,
        blockHeight: receipt.blockHeight ?? null,
        blockTimestamp: receipt.blockTimestamp ?? null,
        confirmations: receipt.confirmations,
      };
    },

    /**
     * Read the root the transaction ACTUALLY commits, from the chain — not from
     * our own database, and not from what we intended to sign. Uses the same
     * structural OP_RETURN decoder the verifier uses, so a crafted or malformed
     * script is rejected rather than loosely pattern-matched.
     */
    async readCommittedRoot(txid: string) {
      try {
        const tx = await utxoProvider().getRawTransaction(txid);
        for (const out of tx.vout ?? []) {
          const root = extractAnchorFingerprint(out.scriptPubKey?.hex ?? '');
          if (root) return root;
        }
        return null;
      } catch (error) {
        logger.warn(
          { txid, error: error instanceof Error ? error.message : String(error) },
          'Could not read committed root back from chain',
        );
        return null;
      }
    },

    async persistJournal(args) {
      const { data, error } = await db.rpc('persist_supplementary_journal', {
        p_batch_id: args.batchId,
        p_txid: args.txid,
        p_fingerprint_root: args.fingerprintRoot,
        p_anchor_ids: args.anchorIds,
        p_leaf_order: args.leafOrder as unknown as Json,
      });
      if (error) {
        // Unknown persistence outcome: the row may have committed. Report a
        // CONFLICT so the caller defers WITHOUT broadcasting, rather than
        // risking a second transaction for the same cohort.
        return {
          journalId: '',
          outcome: 'CONFLICT' as const,
          conflictReason: `journal persistence outcome unknown: ${error.message}`,
        };
      }
      const row = data as unknown as {
        journal_id: string;
        outcome: 'CREATED' | 'EXACT_REPLAY' | 'CONFLICT';
        conflict_reason?: string;
      };
      return {
        journalId: row.journal_id,
        outcome: row.outcome,
        conflictReason: row.conflict_reason,
      };
    },

    async resolveJournal(journalId, action, reason) {
      const { data, error } = await db.rpc('resolve_supplementary_journal', {
        p_journal_id: journalId,
        p_action: action,
        p_reason: reason,
      });
      if (error) {
        logger.error({ journalId, action, error: error.message }, 'Journal resolution failed');
        return false;
      }
      return Boolean(data);
    },

    async insertProofs(rows) {
      const { data, error } = await db.rpc('insert_supplementary_proofs', {
        p_rows: rows as unknown as Json,
      });
      if (error) throw new Error(`supplementary proof insert failed: ${error.message}`);
      return Number(data ?? 0);
    },

    sleep(ms: number) {
      return new Promise<void>((resolve) => setTimeout(resolve, ms));
    },

    log(level, msg, meta) {
      logger[level]({ job: 'supplementary-proof-anchor', ...meta }, msg);
    },
  };
}
