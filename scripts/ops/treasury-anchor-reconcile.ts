#!/usr/bin/env -S npx tsx
/**
 * Treasury ↔ anchor reconciliation.
 *
 * Every satoshi the treasury spends is supposed to buy anchors. This walks the
 * treasury address's full on-chain spend history and joins it against
 * `anchors.chain_tx_id`, so fee burn that produced no anchors becomes visible
 * instead of being invisible until someone audits by hand.
 *
 * WHY THIS EXISTS (measured 2026-08-21, treasury
 * bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc, 2026-03-26 … 2026-08-21):
 *
 *   outbound txs        3,314   (all anchoring: one OP_RETURN each, zero
 *                                value ever paid to a third party)
 *   total fees          828,189 sats  (0.00828189 BTC)
 *   matched to anchors  2,460 txs / 584,280 sats
 *   ORPHANED            853 txs / 243,752 sats  = 29.4% of all fee spend
 *
 * The 853 orphans are structurally identical to real batches — same 38-byte
 * OP_RETURN, interleaved on the same days as matched ones, concentrated
 * 2026-03 … 2026-05 — so they are not malformed. They are broadcasts whose
 * anchor rows are not in the prod database. The leading hypothesis is a non-prod
 * environment sharing the mainnet treasury key; that was NOT confirmed, because
 * the staging project was not reachable with the credentials available at the
 * time. This script is the standing check that would have surfaced it early.
 *
 * It also reports the reverse direction — PHANTOM txids, where an anchor row
 * cites a transaction the treasury never broadcast. On prod that class is real:
 * 21 rows cite Bitcoin SIGNET transactions and 3 cite transactions that resolve
 * on no network (see migration 0415).
 *
 * Usage:
 *   npx tsx scripts/ops/treasury-anchor-reconcile.ts \
 *     --project-ref vzwyaatejekddvltxyye --format json
 *
 *   --address           Treasury address. Default: src/lib/platform.ts value.
 *   --project-ref       Supabase project ref, or PROD_PROJECT_REF env.
 *   --service-role-key  Service role key, or SUPABASE_SERVICE_ROLE_KEY env.
 *   --max-orphan-sats   Exit 1 above this orphaned-fee total. Default: 0
 *                       (report-only exits 0 unless --strict).
 *   --strict            Exit 1 if any orphan is found.
 *
 * Exit 0 = within tolerance. Exit 1 = over tolerance. Exit 2 = could not run.
 */

import { createClient } from '@supabase/supabase-js';

/**
 * Minimal structural view of the client: just the one paged query this needs.
 * Avoids depending on @supabase/supabase-js' generic defaults, which differ
 * between the value returned by createClient() and the exported SupabaseClient
 * type and produce a spurious `never` inference here.
 */
type AnchorTxidReader = {
  from(table: string): {
    select(columns: string): {
      not(column: string, op: string, value: null): {
        range(from: number, to: number): PromiseLike<{
          data: { chain_tx_id: string | null }[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
};

export const DEFAULT_TREASURY_ADDRESS = 'bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc';

/** Esplora mirrors, tried in order. mempool.space rate-limits aggressively. */
export const ESPLORA_HOSTS = ['https://blockstream.info/api', 'https://mempool.space/api'];

// ---------------------------------------------------------------------------
// Pure core — no IO, unit-tested by treasury-anchor-reconcile.test.ts
// ---------------------------------------------------------------------------

export interface SpendTx {
  txid: string;
  /** Miner fee in satoshis. */
  fee: number;
  /** Block time (unix seconds); undefined while unconfirmed. */
  blockTime?: number;
}

export interface Reconciliation {
  /** On-chain spends that map to at least one anchor row. */
  matched: string[];
  /** On-chain spends with no anchor row: fee burned, nothing recorded. */
  orphans: SpendTx[];
  /** Anchor txids the treasury never broadcast (wrong network, or fabricated). */
  phantoms: string[];
  totalFeeSats: number;
  orphanFeeSats: number;
  /** Orphaned share of all fee spend, 0…1. */
  orphanFeeRatio: number;
}

/**
 * Join on-chain treasury spends against the txids the database claims.
 *
 * Both sides are compared case-insensitively: Esplora returns lowercase hex, and
 * nothing guarantees the database column does.
 */
export function reconcile(spends: SpendTx[], dbTxids: Iterable<string>): Reconciliation {
  const db = new Set<string>();
  for (const t of dbTxids) {
    if (t) db.add(t.toLowerCase());
  }

  const matched: string[] = [];
  const orphans: SpendTx[] = [];
  const onChain = new Set<string>();
  let totalFeeSats = 0;
  let orphanFeeSats = 0;

  for (const s of spends) {
    const id = s.txid.toLowerCase();
    onChain.add(id);
    totalFeeSats += s.fee;
    if (db.has(id)) {
      matched.push(id);
    } else {
      orphans.push(s);
      orphanFeeSats += s.fee;
    }
  }

  const phantoms = [...db].filter((t) => !onChain.has(t)).sort();

  return {
    matched,
    orphans,
    phantoms,
    totalFeeSats,
    orphanFeeSats,
    orphanFeeRatio: totalFeeSats === 0 ? 0 : orphanFeeSats / totalFeeSats,
  };
}

/** Group orphaned spend by calendar month, for the "when did this start" view. */
export function orphansByMonth(orphans: SpendTx[]): Record<string, { txs: number; feeSats: number }> {
  const out: Record<string, { txs: number; feeSats: number }> = {};
  for (const o of orphans) {
    if (o.blockTime === undefined) continue;
    const month = new Date(o.blockTime * 1000).toISOString().slice(0, 7);
    out[month] ??= { txs: 0, feeSats: 0 };
    out[month].txs += 1;
    out[month].feeSats += o.fee;
  }
  return out;
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

interface EsploraTx {
  txid: string;
  fee: number;
  weight: number;
  status: { confirmed: boolean; block_time?: number };
  vin: { prevout?: { scriptpubkey_address?: string } | null }[];
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Page the full confirmed history. Esplora returns 25 per page and continues via
 * /txs/chain/:last_txid. Hosts rotate on failure — a single mirror will
 * rate-limit long before 3,300 transactions are drained.
 */
export async function fetchTreasurySpends(address: string): Promise<SpendTx[]> {
  const out: SpendTx[] = [];
  const seen = new Set<string>();
  let last = '';
  let host = 0;
  let failures = 0;

  for (;;) {
    const base = ESPLORA_HOSTS[host];
    const url = last
      ? `${base}/address/${address}/txs/chain/${last}`
      : `${base}/address/${address}/txs`;

    let page: EsploraTx[];
    try {
      page = (await getJson(url)) as EsploraTx[];
      if (!Array.isArray(page)) throw new Error('non-array response');
    } catch (err) {
      failures += 1;
      if (failures > 12) throw new Error(`Esplora unreachable after 12 attempts: ${String(err)}`);
      host = (host + 1) % ESPLORA_HOSTS.length;
      await new Promise((r) => setTimeout(r, failures * 15_000));
      continue;
    }

    failures = 0;
    if (page.length === 0) break;

    for (const tx of page) {
      if (seen.has(tx.txid)) continue;
      seen.add(tx.txid);
      // Only OUR spends: the address must fund at least one input. Incoming
      // deposits are somebody else's fee and must not be attributed to us.
      const isSpend = tx.vin.some((v) => v.prevout?.scriptpubkey_address === address);
      if (!isSpend) continue;
      out.push({ txid: tx.txid, fee: tx.fee, blockTime: tx.status.block_time });
    }

    last = page[page.length - 1].txid;
    await new Promise((r) => setTimeout(r, 1_200));
  }

  return out;
}

/** Page every distinct chain_tx_id out of the anchors table. */
async function fetchAnchorTxids(client: AnchorTxidReader): Promise<string[]> {
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('anchors')
      .select('chain_tx_id')
      .not('chain_tx_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`anchors query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (row.chain_tx_id) ids.add(row.chain_tx_id);
    }
    if (data.length < PAGE) break;
  }
  return [...ids];
}

async function main(): Promise<void> {
  const address = arg('--address') ?? DEFAULT_TREASURY_ADDRESS;
  const projectRef = arg('--project-ref') ?? process.env.PROD_PROJECT_REF;
  const supabaseUrl =
    arg('--supabase-url') ?? (projectRef ? `https://${projectRef}.supabase.co` : undefined);
  const serviceRoleKey = arg('--service-role-key') ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const asJson = (arg('--format') ?? 'text') === 'json';
  const strict = process.argv.includes('--strict');
  const maxOrphanSats = Number(arg('--max-orphan-sats') ?? '0');

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      'Missing connection details. Provide --project-ref (or PROD_PROJECT_REF) and ' +
        '--service-role-key (or SUPABASE_SERVICE_ROLE_KEY).',
    );
    process.exit(2);
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [spends, dbTxids] = await Promise.all([
    fetchTreasurySpends(address),
    fetchAnchorTxids(client as unknown as AnchorTxidReader),
  ]);

  const r = reconcile(spends, dbTxids);
  const byMonth = orphansByMonth(r.orphans);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          address,
          spendTxs: spends.length,
          matchedTxs: r.matched.length,
          orphanTxs: r.orphans.length,
          phantomTxids: r.phantoms.length,
          totalFeeSats: r.totalFeeSats,
          orphanFeeSats: r.orphanFeeSats,
          orphanFeeRatio: Number(r.orphanFeeRatio.toFixed(4)),
          orphansByMonth: byMonth,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Treasury ${address}`);
    console.log(`  spends            ${spends.length}`);
    console.log(`  matched           ${r.matched.length}`);
    console.log(`  ORPHANED          ${r.orphans.length} txs, ${r.orphanFeeSats} sats ` +
      `(${(r.orphanFeeRatio * 100).toFixed(1)}% of ${r.totalFeeSats} sats)`);
    console.log(`  PHANTOM txids     ${r.phantoms.length} (anchor cites a tx we never broadcast)`);
    for (const [month, v] of Object.entries(byMonth).sort()) {
      console.log(`    ${month}  ${v.txs} orphan txs, ${v.feeSats} sats`);
    }
  }

  const over = strict ? r.orphans.length > 0 : r.orphanFeeSats > maxOrphanSats;
  process.exit(over ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
