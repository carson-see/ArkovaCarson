# Treasury spend reconciliation — 2026-08-21

Full-history audit of the production treasury
`bc1qtm2kk33k6ht4agt48kh7rfkmmhfkapqn4zwerc`
(`TREASURY_ADDRESS`, `src/lib/platform.ts:31`), covering 2026-03-26 → 2026-08-21.

Chain data was pulled from two independent Esplora mirrors
(`blockstream.info`, `mempool.space`) and cross-checked; both reported identical
address statistics. Database figures are exact `count(*)` against prod
`vzwyaatejekddvltxyye` via MCP, not estimates.

## Lifetime spend

| | sats | BTC | USD @ spot $76,756 |
|---|---:|---:|---:|
| Deposited (9 funding txs) | 1,198,805 | 0.01198805 | $920 |
| Fees paid | 828,189 | 0.00828189 | $636 |
| **Remaining** | **370,616** | **0.00370616** | **$284** |

Valued at time-of-spend rather than spot, lifetime fees are ≈ **$607**.

The books close exactly: `1,198,805 − 828,189 = 370,616`.

**100% of outflow is miner fees.** All 3,314 outbound transactions carry exactly
one OP_RETURN and return change to self; **zero satoshis** were ever paid to a
third party. There is no per-transaction payment leg to optimise — only fee.

## Per-anchor economics

Prod holds **3,556,355 SECURED** anchors, of which 3,556,333 trace to this
address.

| Basis | sats/anchor | USD/anchor | Per 10,000 |
|---|---:|---:|---:|
| All-in (every sat ever spent) | 0.233 | $0.000179 | **$1.79** |
| Productive only (txs traceable to prod anchors) | 0.164 | $0.000126 | **$1.26** |

Per transaction: mean fee 250 sats ($0.19) at **1.59 sat/vB** across a fixed
157 vB. Fee efficiency is at the floor; there is nothing to win there.

**The lever is batch fill, not fee rate.** Cost per anchor is `fee ÷ batch size`,
and the fee is fixed regardless of Merkle tree size. Current mean is 1,446
anchors/tx (median 847, cap 10,000); 182 transactions anchored a single document
each. At a full 10,000-anchor batch the same 250-sat fee yields **$0.19 per
10,000** — roughly 9× cheaper than the realised all-in rate.

Runway on the remaining balance: ~1,480 more transactions, or roughly 2.1M more
anchors at current batch sizes. At the August burn rate (~3,500 sats/day),
about 105 days.

## Monthly

| Month | txs | fee sats | sats/tx | USD @ time |
|---|---:|---:|---:|---:|
| 2026-03 | 672 | 126,378 | 188 | $87.52 |
| 2026-04 | 2,071 | 491,296 | 237 | $371.49 |
| 2026-05 | 244 | 109,240 | 448 | $83.73 |
| 2026-06 | 15 | 8,484 | 566 | $5.31 |
| 2026-07 | 27 | 18,663 | 691 | $12.02 |
| 2026-08 | 284 | 73,971 | 260 | $46.59 |

## Finding 1 — 853 orphaned transactions (29.4% of fee spend)

| | txs | fee sats | USD @ spot |
|---|---:|---:|---:|
| Matched to prod anchors | 2,460 | 584,280 | $448 |
| **Orphaned** | **853** | **243,752** | **$187** |
| Total (confirmed) | 3,313 | 828,032 | $635 |

Orphans by month: 2026-03 (193 txs / 37,374 sats), 2026-04 (597 / 165,832),
2026-05 (58 / 38,630), 2026-06 (1 / 165), 2026-07 (2 / 942), 2026-08 (2 / 809).

These are **not malformed**. They carry the same 38-byte OP_RETURN as matched
batches and are interleaved on the same days — e.g. 2026-04-17 saw 184 orphaned
alongside 224 matched. They are real anchoring broadcasts whose anchor rows are
not in the prod database.

**Leading hypothesis, NOT confirmed:** a non-prod environment sharing the mainnet
treasury key, writing its anchors to a staging database. This fits the known
staging-worker secret drift, but could not be verified — the staging project
`ujtlwnoqfhtitcmsnrpq` refused the credentials available during this audit.

**Landed:** `scripts/ops/treasury-anchor-reconcile.ts` makes this a repeatable
check rather than a manual audit, and reports the reverse direction (phantom
txids) too.

**Open:** confirm or refute the staging hypothesis with staging DB access. Until
then, 29.4% of lifetime fee spend is unattributed.

## Finding 2 — SECURED count overstated by 5.02%

```
pg_class.reltuples : 3,735,017
select count(*)    : 3,556,441
drift              : +178,576  (+5.02%)
```

`refresh_cache_anchor_status_counts()` derives SECURED by subtracting counted
buckets from a `reltuples` planner estimate, so SECURED inherits the bias. Prod
published SECURED = 3,734,931 against a true 3,556,355.

Not staleness: `last_analyze` 42 min old, `n_mod_since_analyze` = 312,
`n_dead_tup` = 108, `n_tup_del` = 0, VACUUM same day. ANALYZE's page-sample
extrapolation is biased on this table — `anchors` carries wide, unevenly
distributed jsonb, so tuples-per-page is not uniform.

Blast radius is **platform-admin only**: `/api/treasury/status` is gated behind
the platform-admin whitelist. The exposure is a human reading the admin
dashboard and quoting the figure externally.

**Landed:** migration `0416` counts SECURED directly (824 ms on prod via
index-only scan) instead of deriving it.

## Finding 3 — 24 false-SECURED anchors

24 rows claim `status = 'SECURED'` while their receipt does not resolve on the
production network:

- **21 rows**, heights 297,455…297,853 (2026-03-27…03-30). Their txids return
  **200 on Bitcoin signet**, 404 on mainnet and testnet4. Real anchors, wrong
  network. Signet tip was 318,773 on 2026-08-21, consistent with ~297k in
  March 2026.
- **3 rows**, `chain_block_height IS NULL` (2026-06-22), filenames
  `DEMO — CPE Sample N (safe to delete)`; their txids resolve on **no** network.

Arkova's lowest genuine mainnet anchor is height 942,403.

This corrects the previously recorded belief that prod had **zero**
false-SECUREDs.

Root cause: `anchors_chain_data_consistency` was
`status <> 'SECURED' OR chain_tx_id IS NOT NULL` — it constrains the txid to be
present and never constrained the height.

Two trigger guards for this invariant already exist
(`enforce_secured_anchor_chain_present`, `enforce_secured_anchor_proof_complete`)
and **both are default-OFF GUCs that are not armed on prod** — verified
2026-08-21: `current_setting('arkova.secured_enforce_chain_present', true)` IS
NULL. The guards were written but never switched on.

**Landed:** migration `0415` (quarantine + tightened constraint) and
`scripts/ci/check-false-secured-anchors.ts` (network-aware detector).

## Method notes

- Address stats agreed exactly across both mirrors:
  `funded_txo_sum` 365,400,890 / `spent_txo_sum` 365,030,117 / `tx_count` 3,322.
- 3,323 transactions retrieved (3,322 confirmed + 1 pending), matching the
  address's own `tx_count` exactly — the crawl is complete, not sampled.
- A transaction counts as *ours* only when the treasury address funds at least
  one input; the 9 incoming deposits are somebody else's fee and are excluded
  from spend.
- Txid ↔ anchor comparison used 10-hex-character prefixes (40 bits); at 2,486
  distinct database txids the collision probability is ~3×10⁻⁶.
