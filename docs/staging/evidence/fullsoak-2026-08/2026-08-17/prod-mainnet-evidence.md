# Prod mainnet evidence (SUPPLEMENTARY) — 2026-08-17

> Run `2026-08-17T14:30:05Z` · prod worker `https://arkova-worker-kvojbeutfa-uc.a.run.app` · prod Supabase `vzwyaatejekddvltxyye`
> Prod `git_sha` `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` · network `mainnet` · uptime `58288s` · health checks `{"database": "ok", "anchoring": "ok", "kms": "ok"}`
> Host `Arkovas-Mac-mini.local` · repo HEAD ``

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
| Anchors created | **2763** |
| …of which SECURED | **2763** |
| Status split | SECURED=2763 |
| Latest mainnet txid | `3c63d19cdd43efb7517a073cd93309e6cfb0d7d911a3abb78cb026704d0a627f` |
| …block height | **962887** |
| …network observed time | 2026-08-17 12:18:43+00 |
| …anchor | `ARK-SEC-RGZB6N` |
| `anchor_proofs` rows | 568723 total (+2763 in 24 h) |
| `anchors` (planner estimate) | ~3643824 |

The proof-row count is reported next to the anchor count deliberately: the gap between them is the
open **G8** decision (backfill the historical proof gap before launch, or publish the limitation).
This artifact states it rather than omitting it.

## Independent confirmation

| explorer | result |
|---|---|
| mempool.space | `True|962887|00000000000000000001531d` |
| blockstream.info | `True|962887|00000000000000000001531d` |

Two explorers, queried separately, both resolving the same transaction id to the same block height
as the Arkova database records. Neither shares infrastructure with Arkova, and neither was told what
height to expect.

## Assertions

| id | assertion | expected | observed | result |
|---|---|---|---|---|
| `M1` | Production worker reports healthy | http 200 + status=healthy | http 200, status=healthy, checks={"database": "ok", "anchoring": "ok", "kms": "ok"} | **PASS** |
| `M2` | Production is on the Bitcoin MAINNET network | network=mainnet | network=mainnet, git_sha=f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58, uptime=58288s | **PASS** |
| `M3` | Prod created anchors in the last 24 h | >0 | 2763 created, 2763 of them SECURED | **PASS** |
| `M4` | Prod carries a recent mainnet chain_tx_id + block height | 64-hex txid + height | `3c63d19cdd43efb7517a…` at height 962887 (2026-08-17 12:18:43+00, `ARK-SEC-RGZB6N`) | **PASS** |
| `M5` | The block height is a real mainnet height, not a mock seed | >850000 (mock seeds 800000) | 962887 | **PASS** |
| `M6` | Prod proof rows counted (the G8 coverage gap, stated not hidden) | a count, whatever it is | anchor_proofs total=568723, +2763 in 24 h, against ~3643824 anchors (planner estimate) | **PASS** |
| `M7` | mempool.space confirms the prod txid on mainnet | confirmed=True | True|962887|00000000000000000001531d | **PASS** |
| `M8` | blockstream.info independently confirms the same txid | confirmed=True | True|962887|00000000000000000001531d | **PASS** |
| `M9` | Both explorers and the Arkova DB agree on the block height | all three equal | db=962887 mempool=962887 blockstream=962887 | **PASS** |
| `M10` | The RIG holds no mainnet-height anchor — it did not touch mainnet | 0 rig anchors above height 850000 | 0 | **PASS** |


---

`PROD_MAINNET_EVIDENCE: 10 pass / 0 fail / 0 skip — PASS`

_Read-only. No prod write, no prod cron invocation, no prod flag/secret/revision/scheduler change.
The rig was not touched at all beyond one SELECT proving it holds no mainnet-height anchor._
