# Prod mainnet evidence (SUPPLEMENTARY) — 2026-08-12

> Run `2026-08-12T17:04:13Z` · prod worker `https://arkova-worker-kvojbeutfa-uc.a.run.app` · prod Supabase `vzwyaatejekddvltxyye`
> Prod `git_sha` `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` · network `mainnet` · uptime `13500s` · health checks `{"database": "ok", "anchoring": "ok", "kms": "ok"}`
> Host `Arkovas-Mac-mini.local` · repo HEAD `49358d607b47217cfe81caf44d17b5e4a595cc88`

## Measured vs asserted (§1.5)

**MEASURED** — production's own Bitcoin **mainnet** operation during the soak window: its health,
its anchor creation and SECURED promotion over the last 24 h, its most recent transaction id and
block height, its materialized proof rows, and independent confirmation of that transaction by two
mainnet block explorers with no shared infrastructure with Arkova.

**NOT ASSERTED** — that the **rig** tested mainnet. It did not, and must not: the rig is signet by
design (BTC9). Mainnet signing and broadcast remain **DECLARED-UNTESTED** for this soak and this
file does not convert that row. Also not asserted: that prod is under test (prod is change-frozen
for the window and every access here is a SELECT or a public GET), or that prod's volume and the
rig's controlled cohort are comparable.

## Production anchoring, last 24 hours

| | value |
|---|---|
| Anchors created | **6553** |
| …of which SECURED | **6553** |
| Status split | SECURED=6553 |
| Latest mainnet txid | `69b0b0d193cf132f15edceea513d2e5dbf2646bc5b6f47660b0d39307ee95dab` |
| …block height | **962153** |
| …network observed time | 2026-08-12 14:15:50+00 |
| …anchor | `ARK-FED-T8CCPC` |
| `anchor_proofs` rows | 514998 total (+6553 in 24 h) |
| `anchors` (planner estimate) | ~3463999 |

The proof-row count is reported next to the anchor count deliberately: the gap between them is the
open **G8** decision (backfill the historical proof gap before launch, or publish the limitation).
This artifact states it rather than omitting it.

## Independent confirmation

| explorer | result |
|---|---|
| mempool.space | `True|962153|000000000000000000011d6e` |
| blockstream.info | `True|962153|000000000000000000011d6e` |

Two explorers, queried separately, both resolving the same transaction id to the same block height
as the Arkova database records. Neither shares infrastructure with Arkova, and neither was told what
height to expect.

## Assertions

| id | assertion | expected | observed | result |
|---|---|---|---|---|
| `M1` | Production worker reports healthy | http 200 + status=healthy | http 200, status=healthy, checks={"database": "ok", "anchoring": "ok", "kms": "ok"} | **PASS** |
| `M2` | Production is on the Bitcoin MAINNET network | network=mainnet | network=mainnet, git_sha=f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58, uptime=13500s | **PASS** |
| `M3` | Prod created anchors in the last 24 h | >0 | 6553 created, 6553 of them SECURED | **PASS** |
| `M4` | Prod carries a recent mainnet chain_tx_id + block height | 64-hex txid + height | `69b0b0d193cf132f15ed…` at height 962153 (2026-08-12 14:15:50+00, `ARK-FED-T8CCPC`) | **PASS** |
| `M5` | The block height is a real mainnet height, not a mock seed | >850000 (mock seeds 800000) | 962153 | **PASS** |
| `M6` | Prod proof rows counted (the G8 coverage gap, stated not hidden) | a count, whatever it is | anchor_proofs total=514998, +6553 in 24 h, against ~3463999 anchors (planner estimate) | **PASS** |
| `M7` | mempool.space confirms the prod txid on mainnet | confirmed=True | True|962153|000000000000000000011d6e | **PASS** |
| `M8` | blockstream.info independently confirms the same txid | confirmed=True | True|962153|000000000000000000011d6e | **PASS** |
| `M9` | Both explorers and the Arkova DB agree on the block height | all three equal | db=962153 mempool=962153 blockstream=962153 | **PASS** |
| `M10` | The RIG holds no mainnet-height anchor — it did not touch mainnet | 0 rig anchors above height 850000 | 0 | **PASS** |


---

`PROD_MAINNET_EVIDENCE: 10 pass / 0 fail / 0 skip — PASS`

_Read-only. No prod write, no prod cron invocation, no prod flag/secret/revision/scheduler change.
The rig was not touched at all beyond one SELECT proving it holds no mainnet-height anchor._
