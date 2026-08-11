/**
 * SCRUM-3188 — supplementary proof anchor job.
 *
 * This job signs and broadcasts REAL mainnet transactions against 2.97M live
 * customer records, so the tests below are weighted toward the ways it could do
 * harm rather than the ways it could succeed:
 *
 *   - it must never broadcast twice for one cohort (money);
 *   - it must never write a proof it has not verified against the chain (lies);
 *   - it must never touch the original attestation (evidence destruction);
 *   - dry-run must be genuinely inert (the operator's safety net).
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildMerkleTree } from '../utils/merkle.js';
import {
  runSupplementaryProofAnchor,
  type SupplementaryPorts,
  type SupplementaryCohortRow,
} from './supplementary-proof-anchor.js';

const fp = (s: string) => createHash('sha256').update(s).digest('hex');
const ORIGINAL_TX = 'a'.repeat(64);

function cohort(n: number, offset = 0): SupplementaryCohortRow[] {
  return Array.from({ length: n }, (_, i) => ({
    anchorId: `00000000-0000-4000-8000-${String(i + offset).padStart(12, '0')}`,
    fingerprint: fp(`leaf-${i + offset}`),
    chainTxId: ORIGINAL_TX,
    orgId: 'org-1',
  }));
}

/** Root the cohort will commit, computed the same way the job does. */
function rootFor(rows: SupplementaryCohortRow[]): string {
  const ordered = [...rows].sort((a, b) =>
    a.fingerprint.localeCompare(b.fingerprint) || a.anchorId.localeCompare(b.anchorId),
  );
  return buildMerkleTree(ordered.map((r) => r.fingerprint)).root;
}

interface Harness {
  ports: SupplementaryPorts;
  broadcasts: string[];
  journalWrites: Array<{ txid: string; batchId: string }>;
  proofWrites: Array<Record<string, unknown>[]>;
  resolutions: Array<{ id: string; action: string }>;
}

function harness(overrides: Partial<SupplementaryPorts> = {}, batches = 1): Harness {
  const broadcasts: string[] = [];
  const journalWrites: Array<{ txid: string; batchId: string }> = [];
  const proofWrites: Array<Record<string, unknown>[]> = [];
  const resolutions: Array<{ id: string; action: string }> = [];
  const liveTxids = new Set<string>();

  let served = 0;
  const ports: SupplementaryPorts = {
    countRemaining: vi.fn(async () => (batches - served) * 3),
    claimCohort: vi.fn(async () => (served++ < batches ? cohort(3, served * 100) : [])),
    getFeeRate: vi.fn(async () => 3),
    getConfirmedBalanceSats: vi.fn(async () => 413_658),
    prepareTx: vi.fn(async (root: string) => ({
      txId: createHash('sha256').update(`tx:${root}`).digest('hex'),
      txHex: `hex:${root}`,
      feeSats: 469,
      opReturnData: `41524b56${root}`,
    })),
    broadcast: vi.fn(async (txHex: string) => {
      broadcasts.push(txHex);
      const root = txHex.slice(4);
      return {
        receiptId: createHash('sha256').update(`tx:${root}`).digest('hex'),
        blockHeight: 961_990,
        blockTimestamp: '2026-08-11T10:00:00Z',
        confirmations: 0,
      };
    }),
    // The chain is the judge: echo back exactly what the OP_RETURN commits.
    readCommittedRoot: vi.fn(async (txid: string) => {
      const w = journalWrites.find((j) => j.txid === txid);
      return w ? (w as unknown as { root: string }).root : null;
    }),
    persistJournal: vi.fn(async (args) => {
      if (liveTxids.has(args.txid)) {
        return { journalId: 'j-existing', outcome: 'EXACT_REPLAY' as const };
      }
      liveTxids.add(args.txid);
      const rec = { txid: args.txid, batchId: args.batchId, root: args.fingerprintRoot };
      journalWrites.push(rec);
      return { journalId: `j-${journalWrites.length}`, outcome: 'CREATED' as const };
    }),
    resolveJournal: vi.fn(async (journalId: string, action: string) => {
      resolutions.push({ id: journalId, action });
      return true;
    }),
    insertProofs: vi.fn(async (rows: Record<string, unknown>[]) => {
      proofWrites.push(rows);
      return rows.length;
    }),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };

  return { ports, broadcasts, journalWrites, proofWrites, resolutions };
}

describe('dry run is genuinely inert', () => {
  it('signs nothing, broadcasts nothing, writes nothing — and still reports the cost', async () => {
    const h = harness();
    const result = await runSupplementaryProofAnchor({ dryRun: true }, h.ports);

    expect(h.ports.prepareTx).not.toHaveBeenCalled();
    expect(h.ports.broadcast).not.toHaveBeenCalled();
    expect(h.ports.persistJournal).not.toHaveBeenCalled();
    expect(h.ports.insertProofs).not.toHaveBeenCalled();

    expect(result.dryRun).toBe(true);
    expect(result.estimate.totalSats).toBeGreaterThan(0);
    expect(result.estimate.transactions).toBeGreaterThan(0);
    expect(result.satsSpent).toBe(0);
    expect(result.anchorsProven).toBe(0);
  });

  it('previews the real committed root of the first batch without signing it', async () => {
    const h = harness();
    const result = await runSupplementaryProofAnchor({ dryRun: true }, h.ports);
    expect(result.previewRoot).toBe(rootFor(cohort(3, 100)));
    expect(h.ports.broadcast).not.toHaveBeenCalled();
  });
});

describe('anti-double-broadcast (the highest-stakes property)', () => {
  it('does NOT broadcast when the journal reports EXACT_REPLAY on resume', async () => {
    // Models a crash AFTER the journal committed but BEFORE/DURING broadcast.
    // The resumed run re-signs the same deterministic bytes, so the journal
    // recognises the txid and refuses a second broadcast.
    const h = harness({
      persistJournal: vi.fn(async () => ({ journalId: 'j-1', outcome: 'EXACT_REPLAY' as const })),
    });
    await runSupplementaryProofAnchor({ dryRun: false }, h.ports);

    expect(h.ports.prepareTx).toHaveBeenCalled();   // it re-signed
    expect(h.ports.broadcast).not.toHaveBeenCalled(); // but never re-broadcast
    expect(h.ports.insertProofs).not.toHaveBeenCalled();
  });

  it('does NOT broadcast on a journal CONFLICT', async () => {
    const h = harness({
      persistJournal: vi.fn(async () => ({
        journalId: 'j-1',
        outcome: 'CONFLICT' as const,
        conflictReason: 'txid already live under a different cohort',
      })),
    });
    const r = await runSupplementaryProofAnchor({ dryRun: false }, h.ports);
    expect(h.ports.broadcast).not.toHaveBeenCalled();
    expect(r.batchesCompleted).toBe(0);
  });

  it('journals BEFORE broadcasting, never after', async () => {
    const order: string[] = [];
    const h = harness();
    (h.ports.persistJournal as ReturnType<typeof vi.fn>).mockImplementation(async (a: { txid: string; fingerprintRoot: string; batchId: string }) => {
      order.push('journal');
      h.journalWrites.push({ txid: a.txid, batchId: a.batchId, ...( { root: a.fingerprintRoot } as object) } as never);
      return { journalId: 'j-1', outcome: 'CREATED' as const };
    });
    (h.ports.broadcast as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('broadcast');
      return { receiptId: 'x'.repeat(64), blockHeight: 1, blockTimestamp: 'now', confirmations: 0 };
    });
    await runSupplementaryProofAnchor({ dryRun: false, maxBatches: 1 }, h.ports);
    expect(order[0]).toBe('journal');
  });

  it('HOLDs (never reverts, never retries) when the broadcast outcome is unknown', async () => {
    // A timeout/5xx means the tx MAY be live. Reverting here and re-signing
    // later is exactly how you pay twice.
    const h = harness({
      broadcast: vi.fn(async () => { throw new Error('ETIMEDOUT talking to provider'); }),
    });
    const r = await runSupplementaryProofAnchor({ dryRun: false }, h.ports);

    expect(h.resolutions.map((x) => x.action)).toContain('HOLD');
    expect(h.resolutions.map((x) => x.action)).not.toContain('REVERT');
    expect(r.batchesCompleted).toBe(0);
    expect(h.ports.insertProofs).not.toHaveBeenCalled();
  });

  it('stops the whole run after an unknown broadcast outcome', async () => {
    // Continuing past an ambiguous broadcast would stack unresolved journals
    // and unbounded spend.
    const h = harness(
      { broadcast: vi.fn(async () => { throw new Error('socket hang up'); }) },
      5,
    );
    const r = await runSupplementaryProofAnchor({ dryRun: false }, h.ports);
    expect((h.ports.prepareTx as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(r.stoppedReason).toMatch(/unknown|ambiguous/i);
  });
});

describe('never write an unverified proof', () => {
  it('writes NOTHING when the chain committed a different root than we planned', async () => {
    const h = harness({ readCommittedRoot: vi.fn(async () => 'f'.repeat(64)) });
    const r = await runSupplementaryProofAnchor({ dryRun: false }, h.ports);

    expect(h.ports.insertProofs).not.toHaveBeenCalled();
    expect(h.resolutions.map((x) => x.action)).toContain('HOLD');
    expect(r.anchorsProven).toBe(0);
  });

  it('writes NOTHING when the committed root cannot be read back at all', async () => {
    const h = harness({ readCommittedRoot: vi.fn(async () => null) });
    await runSupplementaryProofAnchor({ dryRun: false }, h.ports);
    expect(h.ports.insertProofs).not.toHaveBeenCalled();
  });

  it('writes verified rows carrying both the new tx and the original attestation', async () => {
    const h = harness();
    const r = await runSupplementaryProofAnchor({ dryRun: false, maxBatches: 1 }, h.ports);

    expect(h.proofWrites).toHaveLength(1);
    const rows = h.proofWrites[0];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.is_supplementary).toBe(true);
      expect(row.supplements_chain_tx_id).toBe(ORIGINAL_TX);
      expect(row.receipt_id).not.toBe(ORIGINAL_TX);
      expect(row.proof_completeness_class).toBe('supplementary_anchored');
    }
    expect(r.anchorsProven).toBe(3);
  });
});

describe('the original attestation is never touched', () => {
  it('exposes no port capable of writing to anchors', () => {
    // Structural guarantee: the job physically cannot modify chain_tx_id,
    // chain_timestamp, chain_block_height or chain_block_hash, because no
    // dependency it is given can write to the anchors table.
    const h = harness();
    const portNames = Object.keys(h.ports);
    expect(portNames).not.toContain('updateAnchor');
    expect(portNames).not.toContain('updateAnchors');
    expect(portNames.some((p) => /anchorUpdate|setChainTx|writeAnchor/i.test(p))).toBe(false);
  });
});

describe('spend guards', () => {
  it('refuses to sign anything when the fee rate exceeds the ceiling', async () => {
    const h = harness({ getFeeRate: vi.fn(async () => 40) });
    const r = await runSupplementaryProofAnchor(
      { dryRun: false, feeCeilingSatVb: 5 }, h.ports,
    );
    expect(h.ports.prepareTx).not.toHaveBeenCalled();
    expect(r.stoppedReason).toMatch(/ceiling/i);
  });

  it('refuses to sign anything that would breach the treasury reserve', async () => {
    // 100,200 confirmed against a 100,000 reserve leaves 200 spendable — less
    // than the 469 sats one batch costs at 3 sat/vB.
    const h = harness({ getConfirmedBalanceSats: vi.fn(async () => 100_200) });
    const r = await runSupplementaryProofAnchor(
      { dryRun: false, treasuryReserveSats: 100_000 }, h.ports,
    );
    expect(h.ports.prepareTx).not.toHaveBeenCalled();
    expect(r.stoppedReason).toMatch(/reserve/i);
  });

  it('makes partial progress and halts AT the reserve floor rather than through it', async () => {
    // The guard is deliberately per-batch, not whole-run: a long backlog should
    // get as far as it safely can and stop, leaving production anchoring funded.
    let balance = 101_407; // reserve + 1407 = exactly 3 batches at 469 sats
    const h = harness({
      getConfirmedBalanceSats: vi.fn(async () => balance),
      broadcast: vi.fn(async (txHex: string) => {
        balance -= 469;
        const root = txHex.slice(4);
        return {
          receiptId: createHash('sha256').update(`tx:${root}`).digest('hex'),
          blockHeight: 961_990,
          blockTimestamp: '2026-08-11T10:00:00Z',
          confirmations: 0,
        };
      }),
    }, 50);

    const r = await runSupplementaryProofAnchor(
      { dryRun: false, treasuryReserveSats: 100_000 }, h.ports,
    );
    expect(r.batchesCompleted).toBe(3);
    expect(r.stoppedReason).toMatch(/reserve/i);
    expect(balance).toBeGreaterThanOrEqual(100_000);
  });

  it('re-checks the fee rate on every batch, not just the first', async () => {
    let calls = 0;
    const h = harness({ getFeeRate: vi.fn(async () => (++calls > 1 ? 40 : 3)) }, 5);
    const r = await runSupplementaryProofAnchor(
      { dryRun: false, feeCeilingSatVb: 5 }, h.ports,
    );
    expect(r.batchesCompleted).toBe(1);
    expect(r.stoppedReason).toMatch(/ceiling/i);
  });
});

describe('resumability, rate limiting, prioritisation', () => {
  it('honours maxBatches', async () => {
    const h = harness({}, 10);
    const r = await runSupplementaryProofAnchor({ dryRun: false, maxBatches: 3 }, h.ports);
    expect(r.batchesCompleted).toBe(3);
    expect(h.broadcasts).toHaveLength(3);
  });

  it('paces between batches so the provider is never hammered', async () => {
    const h = harness({}, 3);
    await runSupplementaryProofAnchor(
      { dryRun: false, maxBatches: 3, pauseBetweenBatchesMs: 250 }, h.ports,
    );
    expect(h.ports.sleep).toHaveBeenCalledWith(250);
  });

  it('stops cleanly when the backlog is exhausted', async () => {
    const h = harness({}, 2);
    const r = await runSupplementaryProofAnchor({ dryRun: false, maxBatches: 99 }, h.ports);
    expect(r.batchesCompleted).toBe(2);
    expect(r.stoppedReason).toMatch(/exhausted|complete/i);
  });

  it('passes the operator prioritisation through to the claim query', async () => {
    const h = harness();
    await runSupplementaryProofAnchor({
      dryRun: false,
      maxBatches: 1,
      priorityOrgIds: ['f52cd07a-6d8a-4387-9346-23babec84e5c'],
      deprioritizedCredentialTypes: ['PUBLICATION', 'SEC_FILING'],
    }, h.ports);

    expect(h.ports.claimCohort).toHaveBeenCalledWith(
      expect.any(Number),
      ['f52cd07a-6d8a-4387-9346-23babec84e5c'],
      ['PUBLICATION', 'SEC_FILING'],
    );
  });

  it('is idempotent: a cohort already proven is simply not returned again', async () => {
    const h = harness({}, 0);
    const r = await runSupplementaryProofAnchor({ dryRun: false }, h.ports);
    expect(r.batchesCompleted).toBe(0);
    expect(h.ports.prepareTx).not.toHaveBeenCalled();
  });

  it('defaults to dry run when the caller says nothing', async () => {
    const h = harness();
    const r = await runSupplementaryProofAnchor({}, h.ports);
    expect(r.dryRun).toBe(true);
    expect(h.ports.broadcast).not.toHaveBeenCalled();
  });
});
