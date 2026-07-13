# S3.3 L1-6 — Treasury runway paper model: org-scoped drain fee exposure

_Lane 1 (Trust & Chain), 2026-07-10. **PAPER MODEL — every number below is asserted from the fee model, NOT measured on-chain** (§1.5 / R-7: this doc states what is asserted; nothing here is measured). Purpose: quantify the mainnet cost multiplier of moving from today's ~1 global batch tx/day to org-scoped drains (N txs/day), before anyone flips that topology on in prod._

---

## 1. Assumptions (all of them, explicitly)

| # | Assumption | Basis | Status |
|---|---|---|---|
| A1 | Anchor tx shape: 1 × P2WPKH input, 1 × OP_RETURN output (36-byte payload: `ARKV` 4B + Merkle root 32B), 1 × P2WPKH change | `signet.ts` tx builder; `estimateTxVsize(true, 36)` | asserted from code, not measured |
| A2 | Tx virtual size: **157 vB** (in-tree model: input 68 + OP_RETURN 11+36 + change 31 + overhead 11). With the optional 8B metadata hash (44B payload): 165 vB | `signet.ts:356-369` | asserted from code |
| A3 | Tx size is INDEPENDENT of leaf count — 1 leaf or 10,000 leaves is the same 157 vB (one 32-byte root on-chain) | Merkle batching design (BTC-001) | asserted |
| A4 | Today's baseline: **~1 tx/day** (nightly 03:00 ET forced flush; intraday Trigger A/B txs occur only above 10k/3k+3h volume) | prod Scheduler topology audit, `docs/lane1/s33-prod-drain-topology.md` | topology verified; tx/day rate asserted, not measured from chain history |
| A5 | Org-scoped topology: each active org with pending anchors drains **once per 24h cadence** → **N txs/day** where N = active orgs with pending; single-input per tx (pre-split treasury, no multi-input fallback) | `org-queue-scheduler.ts` + 0294 cadence | asserted |
| A6 | Fee rates modeled at 2 / 10 / 50 sat/vB. 50 = the base Trigger C ceiling (`maxFeeThresholdSatPerVbyte` default); dynamic ceiling can reach 200 under aged backlog | `batch-anchor.ts` triggerC | rates are scenario inputs, NOT a fee-market forecast |
| A7 | Illustrative treasury balance **B = 5,000,000 sats (0.05 BTC)** for runway rows. Placeholder — NOT a treasury read. Runway scales linearly: `days = B / (N × 157 × r)` | — | illustrative only |
| A8 | Ignored: multi-input fallback bloat (+68 vB/input), consolidation-cron txs, revocation/attestation txs, dust accumulation, fee-estimator error vs actual next-block rates | scope bound | known omissions |

## 2. Cost per tx and the N× multiplier

Fee per anchor tx = 157 vB × r:

| r (sat/vB) | sats/tx |
|---|---|
| 2 | 314 |
| 10 | 1,570 |
| 50 | 7,850 |

**The structural point:** today N orgs share ONE 157 vB tx/day. Org-scoped drains pay 157 vB **per org** — the daily cost multiplier is exactly **N×** for the same anchor volume. Nothing about org isolation adds on-chain bytes per org beyond a whole extra tx; nothing amortizes it away.

## 3. Runway sensitivity (N txs/day, 157 vB, B = 5,000,000 sats illustrative)

Daily spend (sats/day = N × 157 × r), monthly (×30), and runway (days = B / daily):

| N orgs | r=2: daily / monthly / runway | r=10: daily / monthly / runway | r=50: daily / monthly / runway |
|---|---|---|---|
| **5** | 1,570 / 47,100 / **3,184 d** | 7,850 / 235,500 / **637 d** | 39,250 / 1,177,500 / **127 d** |
| **25** | 7,850 / 235,500 / **637 d** | 39,250 / 1,177,500 / **127 d** | 196,250 / 5,887,500 / **25 d** |
| **50** | 15,700 / 471,000 / **318 d** | 78,500 / 2,355,000 / **64 d** | 392,500 / 11,775,000 / **13 d** |
| **100** | 31,400 / 942,000 / **159 d** | 157,000 / 4,710,000 / **32 d** | 785,000 / 23,550,000 / **6 d** |

Baseline comparison (today, 1 tx/day): 314 / 1,570 / 7,850 sats/day → runway 15,924 / 3,184 / 637 days on the same B.

Reading: at 100 active orgs in a 50 sat/vB fee environment the illustrative treasury lasts **under a week**, vs ~21 months today. Even the benign case (25 orgs, 10 sat/vB) is a **25× standing cost increase** for identical anchor volume. Credit pricing ($1.25/credit, no per-doc fee — see fee & credit model) does not currently price per-org tx fan-out; if org-scoped drains ship to prod, either treasury top-up cadence, org-drain batching tiers, or pricing must absorb the N× multiplier. That is a founder/CPO decision input, not a lane decision.

## 4. UTXO pre-split cost line (L1-2b input)

Org-scoped drains need ≥N spendable treasury UTXOs per pass — sequential per-org txs chaining off one UTXO's unconfirmed change hit the ~25-descendant mempool ancestor/descendant policy ceiling (lane1-report §2.4). One-time split tx: 1 input + N P2WPKH outputs + change ≈ `78.5 + 31 × N` vB:

| Split into | vB | @2 sat/vB | @10 | @50 |
|---|---|---|---|---|
| 5 | 234 | 468 | 2,340 | 11,700 |
| 25 | 854 | 1,708 | 8,540 | 42,700 |
| 50 | 1,629 | 3,258 | 16,290 | 81,450 |
| 100 | 3,179 | 6,358 | 31,790 | 158,950 |

One-time cost is negligible vs the recurring N× drain cost (a 100-way split at 10 sat/vB costs ~1/5th of a single day's 100-org drain at the same rate). The real cost of the split is operational: `chain-maintenance.ts` UTXO consolidation actively UNDOES it — the consolidation cron must be fenced during org-scoped windows (L1-2b AC: "consolidation cron proven not to undo split mid-window").

Recurring side-effect (not in the table): N txs/day also create N change outputs/day of UTXO-set churn, which is what the consolidation cron exists to fight — the two policies need an explicit truce (consolidate to a floor ≥ N, never below).

## 5. What this model is NOT

- NOT a fee forecast (r values are scenario inputs; mainnet next-block rates are volatile and unmodeled).
- NOT a treasury balance statement (B is an illustrative placeholder; a real runway readout requires a prod treasury read via the paths in HANDOFF "Bitcoin paths", out of scope for a paper model).
- NOT measured on-chain — no mainnet or signet tx was constructed, sized, or broadcast for this doc. First empirical check: L1-2 signet rig broadcasts will produce REAL vB sizes to diff against A2 (signet vB == mainnet vB for identical tx shape, so the size model — though not the fee market — validates on signet).
- NOT a claim that 10k-leaf batches cost more than 1-leaf batches (A3 — they don't, that is the point of Merkle batching).

_Last refreshed: 2026-07-10 by Lane 1 — paper model; assumptions A1–A8 above are the complete basis._
