# BL-2 — Bitcoin confirmation end-to-end on the fullsoak rig (Day-0 close-out)

Premortem item: **BL-2** of `docs/staging/SOAK-PREMORTEM-SOC2-2026-08-11.md` §3.
Executed: 2026-08-12. **All timestamps UTC.**

| Field | Value |
|---|---|
| Cloud Run service | `arkova-worker-fullsoak-2026-08-staging` (project `arkova1`, region `us-central1`) |
| Revision under test | `arkova-worker-fullsoak-2026-08-staging-00012-f45` (100% traffic) |
| Image digest | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` |
| `git_sha` (from `/health`) | `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` |
| Supabase project ref | `gnkuaywlpmsaezwvlvhk` (isolated fullsoak rig) |
| Network | signet (`BITCOIN_NETWORK=signet`, `USE_MOCKS=false`, `ENABLE_PROD_NETWORK_ANCHORING=true`) |
| Rig URL | `https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app` |

**Final verdict: BL-2 PASS on `arkova-worker-fullsoak-2026-08-staging-00013-mrw` — all four sub-criteria.
See §4.10.** Phases 0–2 ran against `00012-f45` and produced a FAIL (§3); §3's two failure causes were
closed by one CTO-authorised, pre-clock configuration change (`BITCOIN_UTXO_PROVIDER=getblock` + VPC
connector, **same image digest**), documented in Phases 3 and 4.

| Phase | Revision | What it establishes |
|---|---|---|
| 0–1 | `00012-f45` | Rig baseline; promotion of 5 pre-existing anchors; run-lease TTL self-heal (F-D0-1) |
| 2 | `00012-f45` | 5 new anchors created on the serving revision, broadcast at a live-market fee, confirmed on two explorers; forced flush watched end to end |
| 3 | — | Recovery of the Bitcoin Core signet RPC node the `getblock` provider needs |
| 4 | **`00013-mrw`** | **BL-2 PASS: 12/12 SECURED, 12/12 proof rows with 80-byte headers, all txids double-verified** |

**Rig integrity.** Phases 0–2 ran with the rig fully frozen. The single revision change in Phase 4 was
explicitly authorised, carries prod's unchanged image digest, and altered exactly one env var plus VPC
egress. Every mutation of `anchors` / `anchor_proofs` anywhere in this document was performed by the
worker's own jobs, invoked over authenticated HTTP (`POST /jobs/*`) or by the rig's own schedulers. **All
SQL in this document is read-only `SELECT`.** Full attestation in §5.

---

## 0. Rig baseline captured before any action

### 0.1 `/health` — 2026-08-12T13:45:15Z

```json
{"status":"healthy","version":"0.1.0","git_sha":"f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58",
 "uptime":781,"network":"signet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}
```

`uptime: 781` at 13:45:15Z ⇒ process start ≈ **13:32:14Z**, i.e. the 13:31Z deploy of `00012-f45`.

### 0.2 Anchoring env on `00012-f45` (`gcloud run revisions describe`)

```
USE_MOCKS                      = false
ENABLE_PROD_NETWORK_ANCHORING  = true
BITCOIN_NETWORK                = signet
BITCOIN_UTXO_PROVIDER          = mempool
BITCOIN_FEE_STRATEGY           = mempool
FORCE_DYNAMIC_FEE_ESTIMATION   = true      <- the BL-2 recommended fix, live on the serving revision
BATCH_ANCHOR_MAX_SIZE          = 10000
BITCOIN_RPC_URL / RPC_AUTH / TREASURY_WIF  = Secret Manager refs
```

### 0.3 Boot log of `00012-f45` — BL-2 sub-criterion 4 (fee estimator read FROM THE LOG)

`gcloud logging read` scoped to `revision_name="arkova-worker-fullsoak-2026-08-staging-00012-f45"`:

```json
2026-08-12T13:32:25.284611Z {"msg":"Creating mempool fee estimator","baseUrl":"https://mempool.space/signet/api","network":"signet","strategy":"mempool","target":"halfHour","level":30}
2026-08-12T13:32:25.485965Z {"msg":"Worker service started","env":"production","mocks":false,"network":"signet","port":3001,"level":30}
2026-08-12T13:32:39.921733Z {"msg":"Creating Mempool.space UTXO provider","baseUrl":"https://mempool.space/signet/api","provider":"mempool","level":30}
2026-08-12T13:32:39.921762Z {"msg":"Creating mempool fee estimator","baseUrl":"https://mempool.space/signet/api","network":"signet","strategy":"mempool","target":"halfHour","level":30}
2026-08-12T13:32:39.921770Z {"msg":"Using BitcoinChainClient (signet)","feeEstimator":"Mempool.space","utxoProvider":"Mempool.space REST API","network":"signet","level":30}
2026-08-12T13:32:39.921778Z {"msg":"Bitcoin chain client initialized","feeEstimator":"Mempool.space","provider":"Mempool.space REST API","signer":"WIF (ECPair)","address":"tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7","level":30}
```

**`feeEstimator: "Mempool.space"`** on the serving revision, captured from the boot log, not inferred from env.
`mocks: false`, `signer: "WIF (ECPair)"`, `strategy: "mempool"`.

### 0.4 Anchoring flag snapshot at boot (`flagRegistry` init log, same revision)

```
ENABLE_PROD_NETWORK_ANCHORING     {source: env, value: true}
ENABLE_BATCH_ANCHORING            {source: db,  value: true}
ENABLE_PUBLIC_RECORD_ANCHORING    {source: db,  value: true}
ENABLE_ATTESTATION_ANCHORING      {source: db,  value: true}
ENABLE_CONFIRMATION_PROOF_BACKFILL{source: env, value: false}
```

Note on the last one: `ENABLE_CONFIRMATION_PROOF_BACKFILL=false` gates only the **in-process schedule
registration** (`setupScheduledJobs`). The HTTP route `POST /jobs/populate-confirmation-proofs` calls
`runConfirmationProofBackfill()` directly, which no-ops only on `config.useMocks ||
!config.enableProdNetworkAnchoring` — both of which are favourable here. The Cloud Scheduler job
`arkova-worker-fullsoak-2026-08-staging-populate-confirmation-proofs` (`0-59/5 * * * *`) is ENABLED and is the
real trigger on this rig.

### 0.5 Confirmation semantics on this network

`services/worker/src/jobs/check-confirmations.ts:494` — `getMinConfirmations()` returns `6` on mainnet, **`1`
on signet/testnet**. Signet tip at 13:47:32Z was **317379**; the Phase-1 block is 317376 ⇒ 4 confirmations.

---

## PHASE 1 — promote the 5 pre-existing SUBMITTED anchors

Phase 1 is a **recovery / regression observation**, not the BL-2 PASS. These five anchors were created
*before* `00012-f45` was serving, under the Static fee estimator, and one of them carries a fixture-derived
fingerprint (§1.6). The BL-2 PASS criterion explicitly requires an anchor created **after** the final
revision is serving — that is Phase 2.

### 1.1 Pre-state — `anchors` at 2026-08-12T13:45Z

```
SELECT id, public_id, status, chain_tx_id, chain_block_height, created_at, updated_at, org_id
FROM anchors ORDER BY created_at;
```

| public_id | status | chain_tx_id | chain_block_height | created_at |
|---|---|---|---|---|
| ARK-2026-9E74FF50 | SUBMITTED | `81baf563…2bd` | 317262 | 2026-08-11 16:27:48Z |
| ARK-2026-DD555097 | SUBMITTED | `3a3eec24…9a9` | 317294 | 2026-08-11 17:54:31Z |
| ARK-2026-BA3660AE | SUBMITTED | `3a3eec24…9a9` | 317294 | 2026-08-11 17:54:32Z |
| ARK-2026-96538D45 | SUBMITTED | `3a3eec24…9a9` | 317294 | 2026-08-11 17:54:33Z |
| ARK-2026-F6C93E15 | SUBMITTED | `3a3eec24…9a9` | 317294 | 2026-08-11 17:55:23Z |

`chain_block_height` at this point holds the **broadcast-time tip**, not the confirmation height.
Total anchors in the rig DB: 5. `SELECT count(*) FROM anchors WHERE chain_block_height > 400000` ⇒ **0**.

### 1.2 Pre-state — `anchor_proofs` at 2026-08-12T13:46Z

All five proof rows existed already (written at broadcast time by `batch-anchor.ts`) with
**`block_height`, `block_hash` and `block_header` all NULL** — the confirmation-proof backfill is what fills
them.

| public_id | receipt_id (txid) | batch_id | merkle_index | block_header octets | created_at |
|---|---|---|---|---|---|
| ARK-2026-9E74FF50 | `81baf563…2bd` | `batch_1786468975011_1` | 0 | NULL | 2026-08-11 17:22:55Z |
| ARK-2026-96538D45 | `3a3eec24…9a9` | `batch_1786492802079_4` | 0 | NULL | 2026-08-12 00:00:02Z |
| ARK-2026-BA3660AE | `3a3eec24…9a9` | `batch_1786492802079_4` | 1 | NULL | 2026-08-12 00:00:02Z |
| ARK-2026-F6C93E15 | `3a3eec24…9a9` | `batch_1786492802079_4` | 2 | NULL | 2026-08-12 00:00:02Z |
| ARK-2026-DD555097 | `3a3eec24…9a9` | `batch_1786492802079_4` | 3 | NULL | 2026-08-12 00:00:02Z |

### 1.3 Chain-side pre-verification of both txids (both explorers), 2026-08-12T13:45:04Z

Captured with `curl` at **2026-08-12T13:45:04Z**, verbatim:

```
$ curl -s https://mempool.space/signet/api/tx/81baf563289b377d2612305ac72be811acb60e5420b91dbdcb5b85be962dd2bd/status
{"confirmed":true,"block_height":317376,"block_hash":"000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f","block_time":1786540593}

$ curl -s https://blockstream.info/signet/api/tx/81baf563289b377d2612305ac72be811acb60e5420b91dbdcb5b85be962dd2bd/status
{"confirmed":true,"block_height":317376,"block_hash":"000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f","block_time":1786540593}

$ curl -s https://mempool.space/signet/api/tx/3a3eec2401294d77d62ad2fd8da40997ebe1f79e85352df96c1b5066303339a9/status
{"confirmed":true,"block_height":317376,"block_hash":"000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f","block_time":1786540593}

$ curl -s https://blockstream.info/signet/api/tx/3a3eec2401294d77d62ad2fd8da40997ebe1f79e85352df96c1b5066303339a9/status
{"confirmed":true,"block_height":317376,"block_hash":"000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f","block_time":1786540593}
```

Both explorers agree byte-for-byte: `confirmed: true`, height **317376**, hash
`000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f`, `block_time` 1786540593 =
**2026-08-12T13:16:33Z**.

### 1.4 Fee rates of the two Phase-1 transactions

From `https://mempool.space/signet/api/tx/<txid>` (full tx object), 2026-08-12T13:47Z:

| txid | fee (sats) | vsize (vB) | fee rate (sat/vB) |
|---|---|---|---|
| `81baf563…2bd` (single) | 157 | 156.25 | **1.005** |
| `3a3eec24…9a9` (batch of 4) | 471 | 156.25 | **3.014** |

Both were broadcast under the **Static** estimator on earlier revisions and were lifted into block 317376 by
CPFP. They are *not* evidence of the dynamic estimator; that evidence is Phase 2 §2.4.

### 1.5 F-D0-1 — `check-confirmations` run-lease TTL self-heal, observed end to end

The `13:31Z` deploy of `00012-f45` killed the instance of `00011-bif` that was holding the
`check-confirmations` run lease. Per `services/worker/src/jobs/run-lease.ts`, a crashed holder is recovered
by the TTL alone (`CHECK_CONFIRMATIONS_RUN_LEASE.ttlMs = 35 min`; the CAS predicate is
`status.eq.completed,scheduled_for.lt.<now>`). **The lease row was deliberately NOT cleared by hand — the
self-heal is the designed recovery and observing it is the evidence.**

**Lease row BEFORE (2026-08-12T13:50:17Z):**

```
id            2e9d6f30-5c14-4a7b-8f92-6b3c0d81ae45
type          check-confirmations:lease
status        processing
scheduled_for 2026-08-12 14:00:49.411+00      <- TTL expiry
updated_at    2026-08-12 13:25:49.411+00      <- last heartbeat before the deploy
holder        arkova-worker-fullsoak-2026-08-staging-00011-bif:1:745c5458-224f-41fc-9d00-d5d4412fe62e
acquired_at   2026-08-12T01:22:00.712Z
ttl_remaining 00:10:32
```

The holder string names revision **`00011-bif`** — a revision that no longer exists in the serving set.

**Blocked-run probe (pre-TTL), 2026-08-12T13:45:39Z:**

```
$ curl -s -X POST .../jobs/check-confirmations
{"checked":0,"confirmed":0}
```

Rig log for that request (`correlationId req_46ca4a146ce4d8453c1cb2dd`):

```json
2026-08-12T13:45:39.779907Z {"msg":"Starting confirmation check for SUBMITTED anchors","level":30}
2026-08-12T13:45:40.184571Z {"msg":"Run skipped — another instance holds the run lease","lease":"confirmation check","holder":"arkova-worker-fullsoak-2026-08-staging-00012-f45:1:f10bb510-f563-4fef-85fe-c34cd3b11ca2","level":30}
```

This is the important part: `{"checked":0,"confirmed":0}` is the **same JSON body** a genuinely-empty run
returns. The HTTP response cannot distinguish "nothing to do" from "lease-blocked" — only the log line can.
That is itself a finding (see §3, F-D0-2).

A second, independent blocked run had already been logged at **13:36:15Z** (Cloud Scheduler tick), same
message, same lease — so the block was continuous from the 13:31Z deploy to the TTL, not a one-off.

**First POST after the TTL — 2026-08-12T14:00:57Z:**

```
$ curl -s -X POST .../jobs/check-confirmations      # first attempt, 8 s after TTL expiry
{"checked":4,"confirmed":5}
```

**Lease row AFTER (2026-08-12T14:01:14Z):**

```
id            2e9d6f30-5c14-4a7b-8f92-6b3c0d81ae45
type          check-confirmations:lease
status        completed                        <- released by withRunLease's finally
scheduled_for NULL
updated_at    2026-08-12 14:00:58.383+00
holder        arkova-worker-fullsoak-2026-08-staging-00012-f45:1:f34073b9-290b-4331-9878-a10c18dff18c
acquired_at   2026-08-12T14:00:57.744Z         <- new holder, 00012-f45, claimed 8 s after TTL
```

**F-D0-1 verdict: the TTL self-heal works exactly as designed and required no operator intervention.**
The dead `00011-bif` holder blocked the job for **35 min 26 s** (13:25:32Z last heartbeat → 14:00:57Z
re-claim), which is within `ttlMs = 35 min` plus the interval between claim attempts. The lease was
re-claimed by `00012-f45`, the run completed, and the lease was released to `completed` / `scheduled_for
NULL` in the same second. No row was edited by hand.

**Cost of the stall, for the record:** the two transactions confirmed at **13:16:33Z**; promotion landed at
**14:00:58Z**. Confirmation-to-SECURED latency was therefore **44 min 25 s**, of which ~35 min was the stuck
lease and the rest the 30-minute Cloud Scheduler cadence. Worth noting against R3 (anchor SUBMITTED > 6 h):
the mechanism that delays promotion after a deploy is bounded at TTL + cadence ≈ 65 min worst case.

### 1.6 Promotion result — all 5 anchors SECURED at block 317376

```
$ curl -s -X POST .../jobs/check-confirmations        # 2026-08-12T14:00:57Z
{"checked":4,"confirmed":5}
```

`checked` counts unique-tx lookups scanned this pass; `confirmed` counts anchors promoted. **5 anchors
promoted.** Verified by SQL at 14:01:14Z:

```
SELECT public_id, status, chain_tx_id, chain_block_height, chain_block_hash,
       chain_confirmations, chain_timestamp, updated_at FROM anchors ORDER BY created_at;
```

| public_id | status | chain_tx_id | chain_block_height | chain_block_hash | chain_confirmations | chain_timestamp | updated_at |
|---|---|---|---|---|---|---|---|
| ARK-2026-9E74FF50 | **SECURED** | `81baf563…2bd` | **317376** | `000000069c…1f0f` | 6 | 2026-08-12 13:16:33Z | 14:00:58.265733Z |
| ARK-2026-DD555097 | **SECURED** | `3a3eec24…9a9` | **317376** | `000000069c…1f0f` | 6 | 2026-08-12 13:16:33Z | 14:00:58.278944Z |
| ARK-2026-BA3660AE | **SECURED** | `3a3eec24…9a9` | **317376** | `000000069c…1f0f` | 6 | 2026-08-12 13:16:33Z | 14:00:58.278944Z |
| ARK-2026-96538D45 | **SECURED** | `3a3eec24…9a9` | **317376** | `000000069c…1f0f` | 6 | 2026-08-12 13:16:33Z | 14:00:58.278944Z |
| ARK-2026-F6C93E15 | **SECURED** | `3a3eec24…9a9` | **317376** | `000000069c…1f0f` | 6 | 2026-08-12 13:16:33Z | 14:00:58.278944Z |

Full `chain_block_hash` on all five rows:
`000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f` — **byte-identical to the `block_hash`
both explorers returned in §1.3.** The DB is not merely claiming a height; the height, the hash and the
block time (`chain_timestamp = 2026-08-12 13:16:33Z` = `block_time 1786540593`) all agree with two
independent third parties.

**Mock detector (premortem §3 corollary control):**

```
SELECT count(*) FROM anchors WHERE chain_block_height > 400000;   ⇒  0
```

`MockChainClient` seeds `mockBlockHeight = 800000`; signet's tip is ~317,38x. Zero rows above 400000 across
the whole rig ⇒ no mock output anywhere in the anchor set. Re-checked after Phase 2 (§2.7).

### 1.7 `populate-confirmation-proofs` — FAILS to write `block_header` (F-D0-3, blocking for BL-2 #3)

```
$ curl -s -X POST .../jobs/populate-confirmation-proofs        # 2026-08-12T14:00:58Z
{"skipped":false,"scanned":5,"txAttempted":2,"txConfirmed":0,"txPending":2,"txStale":0,
 "anchorsUpdated":0,"anchorsMissing":0}
```

The job ran (`skipped: false`), scanned all 5 proof rows, attempted both unique txs — and returned
**`txConfirmed: 0`, `txPending: 2`, `anchorsUpdated: 0`**. `block_header` is still NULL on every row.
Verified post-run in §2.7.

**Root cause, from source, not inference.** `jobs/confirmation-proof-backfill.ts:57` builds the
inclusion-proof provider with `createUtxoProvider({ type: config.bitcoinUtxoProvider, … })`. The rig sets
`BITCOIN_UTXO_PROVIDER=mempool`, so that returns `MempoolUtxoProvider`, which **deliberately does not
implement `getTxOutProof`** — its own comment at `chain/utxo-provider.ts:758` says so:

> mempool.space has NO `gettxoutproof`-equivalent that returns the serialized CMerkleBlock format
> `parseTxOutProof` expects … We deliberately do NOT implement `getTxOutProof` here: the confirmation-proof
> fetch then reports `pending` for a mempool-only provider rather than fabricating an unverifiable branch
> (§1.5). GetBlock RPC is the supported inclusion-proof source (DISC-03).

and `chain/confirmation-proof.ts:640` is the branch that fires:

```ts
if (typeof provider.getTxOutProof !== 'function' || typeof provider.getBlockHeaderHex !== 'function') {
  return { status: 'pending', chainTxId, blockHash, confirmations,
           reason: 'provider does not support inclusion-proof fetch (gettxoutproof)' };
}
```

This is **correct, honest behaviour** — §1.5 in action, refusing to fabricate a branch it cannot verify. It
is also an **absolute bar on BL-2 sub-criterion 3 for as long as the rig runs `BITCOIN_UTXO_PROVIDER=mempool`**.
`grep` confirms `updateAnchorConfirmationProofs` (`utils/anchorProofs.ts`) is the *only* writer of
`anchor_proofs.block_header` in the worker, so there is no second path that could populate it.

**And it is a rig↔prod divergence, which makes it a BL-1 finding too.** Read live at 14:03Z:

| | rig `…-fullsoak-2026-08-staging` | prod `arkova-worker` |
|---|---|---|
| `BITCOIN_UTXO_PROVIDER` | **`mempool`** | **`getblock`** |
| `BITCOIN_FEE_STRATEGY` | `mempool` | `mempool` |
| `BITCOIN_NETWORK` | `signet` | `mainnet` |

`getblock` selects `GetBlockHybridProvider`, which **does** implement `getTxOutProof`
(`chain/utxo-provider.ts:964`). So production materialises confirmation proofs and the rig cannot. The
network difference (signet vs mainnet) is intended and unavoidable; the **provider** difference is not
required by it — the rig already carries `BITCOIN_RPC_URL` and `BITCOIN_RPC_AUTH` secret refs, so the
GetBlock path is provisioned but not selected. It also means rig **broadcast** goes via mempool.space
(`utxoProvider: "Mempool.space REST API"` in the boot log) whereas prod broadcasts via GetBlock RPC — a
second untested-path divergence on the same variable.

**Not fixed here, deliberately.** The rig is frozen (`00012-f45`); changing
`BITCOIN_UTXO_PROVIDER` is a new revision, which resets the soak clock and invalidates BL-1 digest parity
evidence. Escalated as a Day-0 gate decision — see §3.

---

## PHASE 2 — new anchors created and broadcast on the final revision (the BL-2 PASS attempt)

### 2.1 Provenance: these anchors were created after `00012-f45` began serving

`00012-f45` process start ≈ **13:32:14Z** (§0.1). Five new anchors were created by the behavioural-probe
session through real API/connector flows between **13:57:16Z and 14:03:01Z**, i.e. entirely on the final
revision, and were broadcast by that revision's chain client.

| public_id | org | created_at | chain_tx_id | submitted_at (`updated_at`) |
|---|---|---|---|---|
| ARK-2026-BAC1FC13 | Arkova Inc. | 13:57:16.680763Z | `eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223` | 13:59:04.531324Z |
| ARK-2026-AEC77DB2 | Arkova Inc. | 13:57:18.043427Z | `eb28b03a…d223` | 13:59:04.531324Z |
| ARK-2026-EEDA3CEC | Acme Corporation | 13:57:17.428917Z | `d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc` | 13:59:05.677582Z |
| ARK-2026-F180C87A | Acme Corporation | 13:57:18.699490Z | `d73a3f0b…d7bc` | 13:59:05.677582Z |
| ARK-DOC-S3DQE5 | Acme Corporation | 14:03:01.715550Z | `b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70` | 14:03:03.015792Z |

Per-org isolation is visible in the batching itself: the two Arkova anchors went into one tx and the two Acme
anchors into a different tx — the org-scoped drain never mixed the two tenants into a shared Merkle batch.

### 2.2 Forced-flush observation, end to end (premortem §7 step 15)

Three forced flushes were observed on the final revision. All three are the **same code path** the daily
`batch-anchors-forced-flush` uses — `processBatchAnchors({ force: true, orgId })`
(`routes/cron.ts:281` → `jobs/batch-anchor.ts:1746`, "Trigger D").

**Flush 1 + 2 — org-queue-scheduler tick, 13:59:03–13:59:05Z** (`correlationId req_fb4db6c7674fe7f15db635f8`):

```json
13:59:03.857287Z {"msg":"Treasury pre-flight check passed","address":"tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7","totalSats":745777,"utxoCount":1}
13:59:03.912297Z {"msg":"Forced org batch flush","orgId":"aaaaaaaa-0000-4000-8000-000000000001","oldestAgeMs":107232,"pendingCountSentinel":1,"pendingThreshold":3000,"pendingThresholdCrossed":false,"batchSize":10000,"batchSizeCrossed":false}
13:59:04.016575Z {"msg":"Claimed anchors for batch processing","claimed":2,"eligible":2,"target":10000}
13:59:04.041228Z {"msg":"Preparing fingerprint anchor transaction (build + sign, no broadcast)","fingerprint":"d1630f76a2e8a5e28a0c9f727ec5018e061586b183cd9cfa3507803d2b252f9f"}
13:59:04.138688Z {"msg":"Transaction built and signed (not yet broadcast)","txId":"eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223","fee":628,"utxoValue":745777}
13:59:04.365599Z {"msg":"Signed transaction broadcast","txId":"eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223"}
13:59:04.559107Z {"msg":"Batch anchor processing complete","batchId":"batch_1786543144037_2","count":2,"total":2,"merkleRoot":"d1630f76a2e8a5e28a0c9f727ec5018e061586b183cd9cfa3507803d2b252f9f","txId":"eb28b03a…d223"}
13:59:05.031890Z {"msg":"Treasury pre-flight check passed","totalSats":745149,"utxoCount":1}
13:59:05.094022Z {"msg":"Forced org batch flush","orgId":"bbbbbbbb-0000-4000-8000-000000000001","oldestAgeMs":107666,"pendingCountSentinel":1,"pendingThreshold":3000,"batchSize":10000}
13:59:05.188089Z {"msg":"Claimed anchors for batch processing","claimed":2,"eligible":2,"target":10000}
13:59:05.271930Z {"msg":"Transaction built and signed (not yet broadcast)","txId":"d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc","fee":628,"utxoValue":745149}
13:59:05.512790Z {"msg":"Signed transaction broadcast","txId":"d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc"}
13:59:05.703546Z {"msg":"Batch anchor processing complete","batchId":"batch_1786543145188_2","count":2,"total":2,"merkleRoot":"4d307864cee84e9acca9991314d49e41614ce598e0ce73339d6289bd121c6128","txId":"d73a3f0b…d7bc"}
```

**Flush 3 — connector-artifact drain, 14:03:02–14:03:03Z** (`correlationId req_e7b387c2a5344d70d26ac3a3`):

```json
14:03:01.929396Z {"msg":"connector-artifact reset stuck broadcasts → PENDING for prompt batch submit","orgId":"bbbb…0001","resetCount":1}
14:03:02.240466Z {"msg":"Treasury pre-flight check passed","totalSats":744521,"utxoCount":1}
14:03:02.299286Z {"msg":"Forced org batch flush","orgId":"bbbbbbbb-0000-4000-8000-000000000001","oldestAgeMs":584,"pendingCountSentinel":1,"batchSize":10000}
14:03:02.399362Z {"msg":"Claimed anchors for batch processing","claimed":1,"eligible":1,"target":10000}
14:03:02.562490Z {"msg":"Transaction built and signed (not yet broadcast)","txId":"b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70","fee":628,"utxoValue":744521}
14:03:02.837373Z {"msg":"Signed transaction broadcast","txId":"b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70"}
14:03:03.043182Z {"msg":"Batch anchor processing complete","batchId":"batch_1786543382400_1","count":1,"total":1,"txId":"b31195ea…ce70"}
14:03:03.222827Z {"msg":"connector-artifact anchored","anchorId":"e1737709-8abe-4c09-856b-2a6d7b578837","anchorStatus":"SUBMITTED","artifactId":"c81421fa-7b52-4842-b81e-1b71ddee2c4f","batchId":"batch_1786543382400_1","processed":1}
14:03:03.224393Z {"msg":"connector-artifact drain pass complete","claimed":1,"anchored":1,"failed":0,"confirmed":0,"reconfirmRequeued":0}
```

**Queue depth around the flushes:**

| Moment | PENDING | SUBMITTED | SECURED | `job_queue` non-lease depth |
|---|---|---|---|---|
| 13:46:30Z (before probe anchors existed) | 0 | 5 | 0 | — |
| 13:57:16–13:57:18Z (4 anchors created) | 4 | 5 | 0 | — |
| after flush 1+2 (13:59:05Z) | 0 | 9 | 0 | — |
| 14:03:01Z (1 connector anchor created) | 1 | 9 | 0 | — |
| after flush 3 (14:03:03Z) | 0 | 5 | 5 | — |
| 14:04:53Z (measured) | **0** | 5 | 5 | **0** |

The flush **drained completely and the PENDING count fell to zero** in every case: 4 → 0 and 1 → 0.
`triggerB_shouldFireOnAge` could not have fired here (`pendingThreshold` 3,000 was never crossed —
`pendingThresholdCrossed: false` in the logs), so the drain is attributable to Trigger D (`force`) alone.
This closes the premortem §2.2 open question — *"nobody has yet watched a flush drain on this rig"* — with a
watched drain.

**Own explicit GLOBAL forced flush #1 — 2026-08-12T14:05:02Z (empty-queue control):**

```
$ curl -s -X POST '.../jobs/batch-anchors?force=true'
{"processed":0,"batchId":null,"merkleRoot":null,"txId":null}
```

`processed: 0` because the queue was already empty by then. Kept as the negative control.

**Own explicit GLOBAL forced flush #2 — 2026-08-12T14:34:53Z (the real one, depth 2 → 0):**

Queue depth immediately before, by SQL at **14:34:41.397Z**:

| public_id | status | org | created_at |
|---|---|---|---|
| ARK-2026-2432CB45 | PENDING | `aaaaaaaa-…0001` (Arkova) | 14:11:50.485853Z |
| ARK-2026-9476A947 | PENDING | `bbbbbbbb-…0001` (Acme) | 14:11:51.215839Z |

→ **PENDING = 2**, SUBMITTED = 5, SECURED = 5.

```
$ curl -s -X POST '.../jobs/batch-anchors?force=true'      # 2026-08-12T14:34:53Z
{"processed":2,"batchId":"batch_1786545294586_2",
 "merkleRoot":"85df2bca0f38b55665fc760c73c9c857036c7222a78cadb7f4b4a129cb12b078",
 "txId":"910e557ca07656b829908bfcc85dd38a04c04f310c5d2846c4c0fe9bffb8c296"}
```

Rig log, `correlationId req_fad72fc6d6c1fe61c020efe0` — note this run took the **global** Trigger-D path
(`orgId: null`, `pendingCountSource: "global_threshold_probe"`), unlike the org-scoped flushes above:

```json
14:34:54.395879Z {"msg":"Treasury pre-flight check passed","totalSats":743265,"utxoCount":1}
14:34:54.480619Z {"msg":"Forced batch flush (daily 3am EST sweep)","orgId":null,"oldestAgeMs":1383996,"pendingCountSentinel":1,"pendingCountSource":"global_threshold_probe","pendingThreshold":3000,"pendingThresholdCrossed":false,"batchSize":10000,"batchSizeCrossed":false}
14:34:54.585446Z {"msg":"Claimed anchors for batch processing","claimed":2,"eligible":2,"target":10000}
14:34:54.587527Z {"msg":"Preparing fingerprint anchor transaction (build + sign, no broadcast)","fingerprint":"85df2bca0f38b55665fc760c73c9c857036c7222a78cadb7f4b4a129cb12b078"}
14:34:54.743311Z {"msg":"Transaction built and signed (not yet broadcast)","txId":"910e557ca07656b829908bfcc85dd38a04c04f310c5d2846c4c0fe9bffb8c296","fee":628,"utxoValue":743265}
14:34:54.953873Z {"msg":"Signed transaction broadcast","txId":"910e557ca07656b829908bfcc85dd38a04c04f310c5d2846c4c0fe9bffb8c296"}
14:34:55.145506Z {"msg":"Batch anchor processing complete","batchId":"batch_1786545294586_2","count":2,"total":2,"merkleRoot":"85df2bca…b078","txId":"910e557c…c296"}
```

Queue depth immediately after (14:37:58.926Z): **PENDING = 0**, SUBMITTED = 7, SECURED = 5. The two rows
drained in **~1.4 s**, wall-clock, from claim to broadcast. `oldestAgeMs: 1383996` (23 min) with
`pendingThresholdCrossed: false` confirms again that only `force` could have fired this — Trigger B needs
3,000 pending rows and Trigger A needs 10,000.

`910e557c…c296`: fee 628 sats / 156.25 vB = **4.019 sat/vB**, OP_RETURN `ARKV` + root
`85df2bca0f38b55665fc760c73c9c857036c7222a78cadb7f4b4a129cb12b078` — identical to the batch `merkleRoot` in
the log and to `anchor_proofs.merkle_root`.

The `force` parameter name was read off the handler, not guessed:
`services/worker/src/routes/cron.ts:281` — `const force = req.query.force === 'true' || req.query.force === '1';`

### 2.3 New broadcasts — chain-side facts at 14:01–14:04Z

| txid | anchors | fee (sats) | vsize (vB) | fee rate (sat/vB) | broadcast at |
|---|---|---|---|---|---|
| `eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223` | 2 (Arkova) | 628 | 156.25 | **4.019** | 13:59:04.365Z |
| `d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc` | 2 (Acme) | 628 | 156.25 | **4.019** | 13:59:05.512Z |
| `b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70` | 1 (Acme, connector) | 628 | 156.25 | **4.019** | 14:03:02.837Z |

### 2.4 Fee-rate criterion — the dynamic estimator is provably the one that priced these

`GET https://mempool.space/signet/api/v1/fees/recommended`, sampled at 13:47:32Z, 14:01:37Z and 14:04:06Z —
identical all three times, spanning every broadcast:

```json
{"fastestFee":4,"halfHourFee":4,"hourFee":4,"economyFee":2,"minimumFee":1}
```

| Quantity | Value |
|---|---|
| `fastestFee` at broadcast time | **4** sat/vB |
| Fee rate actually paid | **4.019** sat/vB (628 sats / 156.25 vB) |
| Criterion "paid ≥ fastestFee" | **PASS** (4.019 ≥ 4) |

**Arithmetic tie-back to the estimator, exact.** `chain/signet.ts:451` computes `fee = Math.ceil(finalSize *
feeRate)`. `628 = 4 × 157`, and 157 vB is the builder's projected `finalSize` for this 1-in/2-out
P2WPKH+OP_RETURN shape (actual vsize 156.25). So the estimator returned **`feeRate = 4`** — exactly
mempool.space's `halfHourFee`, which is the field `MempoolFeeEstimator` reads for its configured target
(`TARGET_FIELD_MAP.halfHour = 'halfHourFee'`, `chain/fee-estimator.ts:153-158`; boot log records
`target: "halfHour"`).

**Contrast with the pre-fix path**, which is the whole point of BL-2's recommended fix: the Phase-1 single
tx paid **1.005 sat/vB** — the relay floor produced by the Static estimator — and sat unmined for 21+ blocks
(premortem §2.2). With `FORCE_DYNAMIC_FEE_ESTIMATION=true`, the same code path now prices at the live
network rate. That is a **4× fee-rate increase attributable to the flag**, measured on the wire.

**Caveat on log evidence, stated rather than papered over.** The estimator's chosen rate is logged at
`logger.debug` (`chain/fee-estimator.ts:240` `'Mempool fee estimate'`; `chain/signet.ts:736` `'Fee rate
estimated'`), and the rig emits at `info` and above — so **no log line carries the sat/vB number**. The
`info`-level line carries only `fee: 628`. The rate is therefore established by (a) the boot-log estimator
identity, (b) the exact `Math.ceil(157 × 4) = 628` arithmetic, and (c) the on-chain fee rate both explorers
report. That is three independent legs, but it is not a log line, and it should not be written up as one.
Filed as F-D0-4.

### 2.5 Independent check the premortem did not ask for: the OP_RETURN commits the DB's Merkle root

BL-2's criteria are all about the *confirmation*; nothing in them checks that the bytes on chain are the
bytes the database claims. That check is cheap, so it was done. OP_RETURN output parsed straight out of each
raw transaction as served by mempool.space:

| tx | OP_RETURN len | magic | root committed on chain | `anchor_proofs.merkle_root` in the rig DB | match |
|---|---|---|---|---|---|
| `eb28b03a…d223` | 36 B | `ARKV` | `d1630f76a2e8a5e28a0c9f727ec5018e061586b183cd9cfa3507803d2b252f9f` | `d1630f76…2f9f` | ✅ |
| `d73a3f0b…d7bc` | 36 B | `ARKV` | `4d307864cee84e9acca9991314d49e41614ce598e0ce73339d6289bd121c6128` | `4d307864…6128` | ✅ |
| `b31195ea…ce70` | 36 B | `ARKV` | `c6358e744a15867e04356a9b2ea6f61c8ae4c5f228f6e72b5fa2c91a63be3545` | `c6358e74…3545` | ✅ |

36 bytes = 4-byte `ARKV` magic + 32-byte root, matching `octet_length(op_return_payload) = 36` on all ten
proof rows. The app-tree branch is therefore genuinely committed on chain for every Phase-2 anchor.

### 2.6 Confirmation watch

Polled every ~110 s from 14:06:20Z. The signet tip sat at **317381** (mined 13:56:36Z) for 26 minutes — the
network, not the transaction, was the wait. The fee rate was never the constraint: sampled at 14:18:47Z the
signet mempool held 28,572 txs / 15,088,625 vB, of which only **175,456 vB (~0.18 of one block) was at or
above 4.019 sat/vB**. Our transactions were ahead of ~99% of the mempool by fee rate the entire time.

```
POLL at=2026-08-12T14:06:20Z tip=317381 ; eb28b03a={"confirmed":false} ; d73a3f0b={"confirmed":false} ; b31195ea={"confirmed":false}
POLL at=2026-08-12T14:08:10Z tip=317381 ; …all false…
POLL at=2026-08-12T14:10:01Z tip=317381 ; …all false…
POLL at=2026-08-12T14:11:53Z tip=317381 ; …all false…
POLL at=2026-08-12T14:13:43Z tip=317381 ; …all false…
POLL at=2026-08-12T14:15:34Z tip=317381 ; …all false…
POLL at=2026-08-12T14:17:25Z tip=317381 ; …all false…
POLL at=2026-08-12T14:19:16Z tip=317381 ; …all false…
POLL at=2026-08-12T14:21:06Z tip=317381 ; …all false…
POLL at=2026-08-12T14:22:57Z tip=317382 ; eb28b03a={"confirmed":true,"block_height":317382,…} ; d73a3f0b={"confirmed":true,…} ; b31195ea={"confirmed":true,…} ; confirmed_count=3
AT_LEAST_ONE_CONFIRMED 2026-08-12T14:22:57Z
```

**All three transactions confirmed together in block 317382**, `block_time 1786544541` =
**2026-08-12T14:22:21Z**. Time from broadcast to confirmation: **23 min 17 s** for the 13:59:04 pair,
**19 min 18 s** for the 14:03:02 tx — one block interval, i.e. as fast as the network allowed.

**Both explorers, verbatim, captured 2026-08-12T14:23:32Z:**

```
$ curl -s https://mempool.space/signet/api/tx/eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223/status
{"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}
$ curl -s https://blockstream.info/signet/api/tx/eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223/status
{"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}

$ curl -s https://mempool.space/signet/api/tx/d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc/status
{"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}
$ curl -s https://blockstream.info/signet/api/tx/d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc/status
{"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}

$ curl -s https://mempool.space/signet/api/tx/b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70/status
{"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}
$ curl -s https://blockstream.info/signet/api/tx/b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70/status
{"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}
```

Six responses, two independent explorers, byte-identical height / hash / block time on all three
transactions. **BL-2 sub-criterion 2 is satisfied for the Phase-2 anchors on the chain side.**

The fourth Phase-2 transaction, `910e557c…c296` (my own forced flush, §2.2), was broadcast at 14:34:54Z and
was still `{"confirmed":false}` at 14:53:07Z with the tip at 317383. It is not needed for the PASS — the
criterion is *one* anchor and three transactions already satisfy it — and is recorded for completeness.
At 4.019 sat/vB it is priced identically to the three that confirmed in one block interval, so nothing about
it suggests a fee problem; it is simply younger than one signet block interval at the time of writing.
No intervention was taken on it (premortem step 8's 45-minute threshold had not elapsed, and would not
justify chain-side action if it had).

### 2.6a Worker-side promotion of the Phase-2 anchors — blocked by a hung `check-confirmations` run (F-D0-5)

The Phase-2 transactions are confirmed on chain (§2.6). Promoting the anchors to `SECURED` requires
`check-confirmations`, and from **14:16:00.220Z** onward that job has been unable to run, because a previous
invocation took the run lease, **never finished, and is still heartbeating the lease**.

**Timeline, from the rig's own logs and the lease row:**

| Time (UTC) | Event |
|---|---|
| 14:14:00.170Z | in-process run starts (**no `correlationId`** ⇒ node-cron, not HTTP) |
| 14:14:05.095Z | `Checking SUBMITTED anchors grouped by tx_id` — `uniqueTxIds: 3`, `currentTipHeight: 317381`, `minConfirmations: 1` |
| 14:14:07.838Z | `Confirmation check complete` — `txChecked: 3`, `anchorsConfirmed: 0` (correct: txs not yet mined). Run took **7.7 s** |
| 14:16:00.220Z | next in-process run starts, takes the lease (`holder …00012-f45:1:8ce98a73-…`) |
| 14:16:10.424Z | `Checking SUBMITTED anchors grouped by tx_id` — same 3 txs, same tip |
| — | **no `Confirmation check complete` line, ever** |
| 14:18:01Z onward | every subsequent invocation logs `Run skipped — already in progress on this instance` and returns `{"checked":0,"confirmed":0}` |
| 14:22:21Z | the three txs are mined into block 317382 — the run that should promote them cannot start |
| 14:27:50.198Z | lease heartbeat fires, `scheduled_for` → 15:02:50 |
| 14:39:30.199Z | lease heartbeat fires again, `scheduled_for` → 15:14:30 |
| 14:51:10.518Z | lease heartbeat fires a third time, `scheduled_for` → **15:26:10** |
| 14:53:04Z | observation stopped. SECURED = 5, SUBMITTED = 7. Still held. |

**31 forced `POST /jobs/check-confirmations` calls** were made between 14:23:25Z and 14:52:43Z — every one
returned `{"checked":0,"confirmed":0}`. **Zero warn/error log lines** were emitted by the rig in that window
other than routine `db-health-monitor` dead-tuple alerts — no timeout, no rate-limit, no fallback, nothing.

The three heartbeats are 700 s ± 1 s apart (14:16:00.220 → 14:27:50.198 → 14:39:30.199 → 14:51:10.518),
which is `ttlMs/3` to the second. There is no ambiguity about whether the holder is dead: it is alive, its
timers are being serviced on schedule, and only its run body is parked.

**Why the TTL cannot rescue this one.** F-D0-1's recovery worked because the `00011-bif` holder was *killed*
— its heartbeat died with it, so `scheduled_for` went stale and the CAS
(`status.eq.completed,scheduled_for.lt.<now>`) matched. Here the holder's **process is alive**: its
`startRunLeaseHeartbeat` interval (`ttlMs/3` ≈ 11 min 40 s) keeps firing exactly on schedule and pushing
`scheduled_for` forward, while the run body itself never returns. The lease is renewed forever and
`releaseRunLease` — which only runs in `withRunLease`'s `finally` — is never reached. Observed renewals are
700 s apart to the millisecond (14:16:00.220 → 14:27:50.198 → 14:39:30.199), which is the heartbeat, not a
coincidence.

**And a second instance would not help.** `withRunLease` short-circuits on the per-process `inFlight` set
*before* it ever consults the lease, so this instance is self-blocking; and any other instance would fail the
DB CAS because the lease is genuinely held and unexpired. The `job_queue` lease is global.

**Most likely mechanism, stated as a hypothesis with its evidence.** The body is parked inside
`Promise.allSettled(batch.map(… fetchTxStatus …))` at `check-confirmations.ts:925`. `fetchTxStatus`
(`:676`) guards the *request* with `AbortSignal.timeout(10000)` but then does `await response.json()` with
**no timeout on the body read** — a stalled response body after headers have arrived is a hang with no
bound. `Promise.allSettled` cannot settle while one member never settles, so the run parks permanently.
Timer starvation is ruled out as the cause: the heartbeat `setInterval` on the same event loop fired twice,
on time, so timers are being serviced. This is a hypothesis about *which* await is parked; the *fact* that
the run is parked and heartbeating is directly observed.

**Deliberately not worked around.** Clearing or expiring the lease row by hand is a direct write to rig
state and is exactly the intervention F-D0-1 exists to avoid; redeploying or restarting the service breaks
the freeze and resets the soak clock. Neither was done. This is reported as a blocking Day-0 finding.

**Outcome as of 2026-08-12T14:53:04Z, when observation stopped:** the five Phase-2 anchors on the three
confirmed transactions, plus the two on `910e557c…c296`, remain `SUBMITTED`. SECURED = 5 (the Phase-1
cohort), SUBMITTED = 7. `anchor_proofs.block_header` is NULL on all 12 rows — but note that even if
promotion had succeeded, F-D0-3 would still hold `block_header` at NULL, so **sub-criterion 3 fails
independently of this blockage**.

### 2.7 Post-Phase-2 database state

Full join of `anchors` × `anchor_proofs`, read at **2026-08-12T14:41:57Z**:

| public_id | status | chain_tx_id | chain_block_height | chain_block_hash | `octet_length(block_header)` | merkle_index |
|---|---|---|---|---|---|---|
| ARK-2026-9E74FF50 | SECURED | `81baf563…2bd` | 317376 | `000000069c…1f0f` | **NULL** | 0 |
| ARK-2026-96538D45 | SECURED | `3a3eec24…9a9` | 317376 | `000000069c…1f0f` | **NULL** | 0 |
| ARK-2026-BA3660AE | SECURED | `3a3eec24…9a9` | 317376 | `000000069c…1f0f` | **NULL** | 1 |
| ARK-2026-F6C93E15 | SECURED | `3a3eec24…9a9` | 317376 | `000000069c…1f0f` | **NULL** | 2 |
| ARK-2026-DD555097 | SECURED | `3a3eec24…9a9` | 317376 | `000000069c…1f0f` | **NULL** | 3 |
| ARK-2026-BAC1FC13 | SUBMITTED | `eb28b03a…d223` | 317381 (broadcast tip) | NULL | **NULL** | 1 |
| ARK-2026-AEC77DB2 | SUBMITTED | `eb28b03a…d223` | 317381 (broadcast tip) | NULL | **NULL** | 0 |
| ARK-2026-EEDA3CEC | SUBMITTED | `d73a3f0b…d7bc` | 317381 (broadcast tip) | NULL | **NULL** | 0 |
| ARK-2026-F180C87A | SUBMITTED | `d73a3f0b…d7bc` | 317381 (broadcast tip) | NULL | **NULL** | 1 |
| ARK-DOC-S3DQE5 | SUBMITTED | `b31195ea…ce70` | 317381 (broadcast tip) | NULL | **NULL** | 0 |
| ARK-2026-2432CB45 | SUBMITTED | `910e557c…c296` | 317383 (broadcast tip) | NULL | **NULL** | 0 |
| ARK-2026-9476A947 | SUBMITTED | `910e557c…c296` | 317383 (broadcast tip) | NULL | **NULL** | 1 |

Aggregates at the same instant:

```
total anchors                             12
anchor_proofs rows                        12   (1:1, none missing)
anchor_proofs with block_header NOT NULL   0
distinct octet_length(block_header)        0   (no rows to measure)
anchors WHERE chain_block_height > 400000  0   <- mock detector, still clean after Phase 2
```

Note the `chain_block_height` on SUBMITTED rows is the **broadcast-time tip**, not a confirmation height —
it is only overwritten with the real block height by the SECURED promotion, which is what §2.6a blocks. The
mock detector is unaffected either way: signet tips are ~317,38x and mock output would be 800,000.

---

## 3. BL-2 verdict on revision `00012-f45` — SUPERSEDED by §4.10

> **This section is the verdict as it stood on revision `00012-f45` at 14:54Z. It is retained unedited
> because it is what drove the CTO's decision to authorise the freeze break. The binding verdict for the
> soak is §4.10, on revision `00013-mrw`: all four sub-criteria PASS.**

BL-2's PASS criterion is *one anchor, created after the final rig revision is serving, traversing the entire
lifecycle*, with each of four sub-criteria evidenced independently of the database that claims it.

| # | BL-2 sub-criterion | Phase 1 (pre-existing anchors) | Phase 2 (anchors created on `00012-f45`) | Overall |
|---|---|---|---|---|
| **1** | `anchors.status = 'SECURED'` | **PASS** — 5/5 SECURED at 14:00:58Z (§1.6) | **FAIL (blocked)** — 7 anchors still SUBMITTED; `check-confirmations` hung since 14:16:00Z and heartbeating its lease (§2.6a) | **FAIL** |
| **2** | `chain_tx_id` resolves `confirmed: true` **with a block height** on **two** independent signet explorers | **PASS** — both txs, both explorers, height 317376 (§1.3) | **PASS** — all three txs, both explorers, height 317382 (§2.6) | **PASS** |
| **3** | matching `anchor_proofs` row with `block_header` = **80 raw bytes** | **FAIL** — `block_header` NULL on all 5; `txPending: 2`, `anchorsUpdated: 0` (§1.7) | **FAIL** — NULL on all 12 rows (§2.7) | **FAIL** |
| **4** | rig boot log reads `feeEstimator` as the intended estimator, **captured from the log** | **PASS** — `"feeEstimator":"Mempool.space"`, `"strategy":"mempool"`, `"target":"halfHour"` on `00012-f45` (§0.3) | same revision, same log line | **PASS** |

**Overall BL-2: FAIL.** Two of four sub-criteria are unmet, for two *independent* causes, neither of which
is "the chain didn't cooperate":

- **#3 is a configuration defect and cannot pass on this rig as configured.** `BITCOIN_UTXO_PROVIDER=mempool`
  selects a provider that has no `gettxoutproof` equivalent, so `block_header` can never be written. Prod
  runs `getblock`, which can. This is a rig↔prod divergence (BL-1) as much as a BL-2 failure.
- **#1 is a worker defect that also exists in production code.** A hung `check-confirmations` run holds and
  indefinitely renews the global run lease, permanently disabling SUBMITTED→SECURED promotion, while every
  invocation returns a success-shaped `{"checked":0,"confirmed":0}`.

**What DID pass is worth stating precisely, because it is the part BL-2 was written to establish.** The
premortem's core claim was *"Bitcoin confirmation has never once completed on this rig"* and *"the fee path
under test is not the fee path in production"*. Both are now closed:

- Confirmation has completed on this rig — twice, in blocks 317376 and 317382, verified on two independent
  explorers, with zero mock output anywhere in the anchor set.
- The dynamic estimator is live and demonstrably pricing: **4.019 sat/vB paid vs `fastestFee` 4**, against
  **1.005 sat/vB** on the Static path that produced the 21-block stall. Broadcast→confirmation was one block
  interval (19–23 min), not 4 h 56 m.
- A forced flush was watched end to end, four times, draining to zero (§2.2) — closing premortem §2.2's
  open question.

**Recommendation for the Day-0 gate.** BL-2 should not be signed off as PASS. The two failures are cheap to
close and both require breaking the freeze once, so they should be closed *together* in a single new
revision, before the clock starts:

1. Set `BITCOIN_UTXO_PROVIDER=getblock` on the rig (prod parity; unblocks sub-criterion 3 and puts the real
   prod broadcast path under test).
2. Restart clears the hung run; re-run Phase 2 on the new revision to obtain the actual PASS.
3. Treat F-D0-5 as a production defect in its own right — it is not a rig artifact. A remediation task has
   been queued for it separately (bound the run body against the TTL; add a body-read timeout to the
   mempool.space `fetch(...).json()` sites; make lease-blocked runs distinguishable in the response). That
   change is T2 (worker behaviour + anchoring) and needs its own soak; it is **not** a prerequisite for
   restarting the rig, because a restart alone clears the current hang.

**Final state at 2026-08-12T14:54:39Z**, for whoever picks this up: SECURED 5, SUBMITTED 7, PENDING 0,
`anchor_proofs` with `block_header` 0/12, mock detector 0, `check-confirmations:lease` still `processing`
with `scheduled_for 15:26:10.518Z` and climbing.

---

## 4. Findings raised by this work

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **F-D0-1** | Informational (closed) | `check-confirmations` run-lease TTL self-heal works. A holder killed by deploy blocked the job for 35 m 26 s and was recovered by the TTL with **no** manual intervention. | §1.5 |
| **F-D0-2** | Low | `POST /jobs/check-confirmations` returns `{"checked":0,"confirmed":0}` for BOTH "nothing to do" and "lease-blocked". The HTTP response cannot distinguish them; only the log line can. A Cloud Scheduler job that is silently no-opping for 35+ minutes looks identical to a healthy one. | §1.5, §2.6a |
| **F-D0-3** | **Blocking (BL-2 #3, BL-1 parity)** | Rig `BITCOIN_UTXO_PROVIDER=mempool` vs prod `getblock`. `MempoolUtxoProvider` implements no `getTxOutProof`, so `fetchConfirmationProof` returns `pending` and `anchor_proofs.block_header` is never written — on this rig it **cannot** be. Also means rig broadcast goes via mempool.space while prod broadcasts via GetBlock RPC: two prod paths untested. | §1.7 |
| **F-D0-4** | Low | The fee estimator's chosen sat/vB is logged only at `debug` (`chain/fee-estimator.ts:240`, `chain/signet.ts:736`); the rig emits `info` and above. The `info` line carries `fee: 628` but no rate. Any "the estimator chose N sat/vB" claim has to be derived, not quoted. Promoting one of those two lines to `info` would make the fee path directly auditable. | §2.4 |
| **F-D0-5** | **Blocking (BL-2 #1) — and a production defect** | A `check-confirmations` run started by the **in-process node-cron** at 14:16:00.220Z never completed. Its `startRunLeaseHeartbeat` keeps renewing the lease every 700 s, so the TTL never expires and `releaseRunLease` (in `finally`) is never reached. `withRunLease`'s per-process `inFlight` guard also short-circuits *before* the lease check, so the holding instance self-blocks. Net effect: **SUBMITTED→SECURED promotion is permanently disabled with no self-heal, no alarm, and a 200 response.** 31 forced invocations over 29 minutes all returned `{"checked":0,"confirmed":0}`; three lease heartbeats observed 700 s apart; zero warn/error logs. | §2.6a |

### F-D0-5 blast radius — this is not a rig-only problem

The rig runs prod's image digest, so the code is identical. Scaling config read live at 14:41Z:

| | rig | prod `arkova-worker` |
|---|---|---|
| `minScale` | 1 | **2** |
| `maxScale` | 5 | 10 |
| `containerConcurrency` | 160 | 80 |
| CPU throttling | default (throttled between requests) | default (throttled between requests) |

`minScale ≥ 1` means the holding instance is never reclaimed for idleness, so a hung run persists for the
instance's lifetime. The lease is a **global** `job_queue` row, so one hung instance blocks promotion for
every instance and every tenant. In production that is 1.18M-anchors-stuck-in-SUBMITTED territory — the
exact incident class the 2026-04-29 drain-RPC hotfix was written for (`check-confirmations.ts:975`), reached
by a different route.

Three defensive changes worth considering, in decreasing order of value:

1. **Bound the run, not just the lease.** `withRunLease` should race `body()` against a deadline derived
   from `ttlMs` and abandon (releasing the lease) rather than heartbeat forever. Today the heartbeat's only
   stop condition is `'lost'`, which a hung-but-alive run never reaches.
2. **Timeout the response body, not only the request.** `fetchTxStatus` guards the request with
   `AbortSignal.timeout(10000)` but then `await response.json()` unbounded (`check-confirmations.ts:683-688`).
   The same shape appears wherever `fetch` + `.json()` is used against mempool.space.
3. **Make "lease-blocked" observable.** Emit a distinguishable response field or a `warn` when a run is
   skipped, and alert on `check-confirmations` having no `Confirmation check complete` line for > 2 cadences.
   Per BL-5, the rig has no monitoring at all today, so this failure produced no signal of any kind.

---

## Phase 3 — RPC node recovery

CTO ruling on the §3 verdict: one deliberate pre-clock freeze break to set `BITCOIN_UTXO_PROVIDER=getblock`,
closing sub-criteria 1 and 3 together. Phase 3 makes the GetBlock-compatible RPC node ready for that deploy.
The Cloud Run deploy itself is owned by the main session; **nothing in this phase touched
`arkova-worker-fullsoak-2026-08-staging`, its env, or the VPC connector.** Every Cloud Run / connector fact
below is a read-only `describe`.

### 3.1 How bitcoind actually runs — not a systemd unit

`systemctl start bitcoind` failed because there is no such unit and never was. The VM
`arkova-s33-rig-b1-bitcoin-core-signet` (project `arkova1`, zone `us-central1-a`, `e2-standard-2`) runs
**Container-Optimized OS**; `/etc/systemd/system/` holds nothing but a `.keep` file. bitcoind runs as a
**Docker container started by the VM's `startup-script` metadata on every boot**:

| Property | Value |
|---|---|
| Container | `arkova-rig-b1-bitcoin-core` (id `7cfc0401a99b`) |
| Image | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/bitcoin-core-signet@sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8` (pinned by digest) |
| Bitcoin Core | **v31.1.0** (`/Satoshi:31.1.0/`, protocol 70016) |
| Restart policy | `unless-stopped` |
| Entrypoint | `/usr/local/bin/bitcoind -signet -conf=/home/bitcoin/.bitcoin/bitcoin.conf` |
| Data disk | `/dev/sdb` → `/var/lib/arkova-rig-b1-bitcoin` (98 G, **26 G used, 68 G free**), datadir `.bitcoin/` |
| VM IPs | internal **10.33.10.10**, external 35.226.132.220 |

The GCE *container declaration* path is **not** in use — `konlet-startup` logged `No metadata present - not
running containers` and `metadata/…/gce-container-declaration` returns 404. The container comes from
`startup-script`, which on this boot ran cleanly:

```
Aug 12 14:59:41Z  Starting google-startup-scripts.service...
Aug 12 14:59:42Z  Found startup-script in metadata.
Aug 12 14:59:43Z  Digest: sha256:cdc306adc6ef6017326681ff09c4d3247ce77026bed17feccdc163a96519c8f8
Aug 12 14:59:43Z  Status: Image is up to date for …/bitcoin-core-signet@sha256:cdc306ad…
Aug 12 14:59:44Z  7cfc0401a99b900b32333da7fa35e8c490386dd3bbb901e48af57b05c1a51de8
```

The script is hardened in ways worth recording: it validates every metadata key against an **immutable
allowlist** (exact image digest, `rpc-bind` must be `10.33.10.10`, `rpc-allow-cidr` must be
`10.33.11.0/28`, Core version `31.1`, source SHA-256, treasury split txid/digest/output-count/total-sats)
and `exit 2`s if any differ; it fetches the RPC credential from Secret Manager with the VM's own service
account so **the secret never enters metadata, argv, env, or logs**; and it installs a COS host `iptables`
rule in addition to the VPC firewall. **No installation was needed and nothing was installed.**

*Aside for the teardown runbook:* the VM's SA lacks `logging.logEntries.create`, so the startup script's
`ping` log write fails with `IAM_PERMISSION_DENIED` (visible in the Jul 27 boot). It is non-fatal — the
script continues and the node comes up — but it means the node's own boot telemetry never reaches Cloud
Logging. Not fixed here.

### 3.2 `bitcoin.conf` — verified against what the provider needs

Read at `/var/lib/arkova-rig-b1-bitcoin/.bitcoin/bitcoin.conf` (mtime 2026-08-12 14:59, i.e. rewritten by
this boot's startup script). Credential redacted:

```ini
signet=1
server=1
txindex=1
listen=1
disablewallet=0
dbcache=4096
[signet]
rpcbind=127.0.0.1
rpcallowip=127.0.0.1/32
rpcbind=10.33.10.10
rpcallowip=10.33.11.0/28
rpcuser=arkova_s33_b1
rpcpassword=<REDACTED>
```

- `txindex=1` ✅ — required for `getrawtransaction` / `gettxoutproof` on non-wallet transactions.
- `signet=1` ✅, `server=1` ✅, `pruned=false` ✅ (a pruned node cannot serve historical proofs).
- `rpcbind` / `rpcallowip` cover **both** `127.0.0.1/32` and **`10.33.11.0/28`** ✅ — the connector range.
- One deviation from the brief worth naming: the node uses **`rpcuser`/`rpcpassword`, not `rpcauth`**. That
  is functionally what the worker needs — `BITCOIN_RPC_AUTH` is consumed as an HTTP-basic `user:pass`
  string — and it is what the Secret Manager value contains (§3.4). No change required; recorded so nobody
  later "fixes" a mismatch that isn't one.
- Binding is to `10.33.10.10` specifically, **not** `0.0.0.0`. Confirmed live:

```
LISTEN 0 128  10.33.10.10:38332  0.0.0.0:*  users:(("bitcoind",pid=1297,fd=13))
LISTEN 0 128    127.0.0.1:38332  0.0.0.0:*  users:(("bitcoind",pid=1297,fd=12))
```

### 3.3 Sync timeline — caught up in ~4.5 minutes

The node had been offline since roughly 2026-08-07 (its stored tip carried `time 1786089312`). It was
already running when this phase began — the Docker restart policy plus the startup script brought it up
**14:59:44Z**, 19 s after the VM booted.

| Time (UTC) | `blocks` | `headers` | `initialblockdownload` | `verificationprogress` |
|---|---|---|---|---|
| 15:01:52 | 316,601 | 317,385 | **true** | 0.9990089 |
| 15:02:45 | 317,105 | 317,385 | true | 0.999640 |
| 15:03:49 | 317,384 | 317,385 | **false** | 0.999999 |
| 15:05:41 | **317,385** | **317,385** | **false** | **1** |

784 blocks recovered in **≈ 4 min from first observation**, on 10 outbound peers. Final state:

```json
{"chain":"signet","blocks":317385,"headers":317385,
 "bestblockhash":"000000096277be9336f7b0dc635fe50e5ce7b253ac73188d8aa4a3edf7f6df01",
 "verificationprogress":1,"initialblockdownload":false,"pruned":false,"size_on_disk":21254642169}
```

**`getindexinfo` — txindex fully synced to the tip:**

```json
{"txindex":{"synced":true,"best_block_height":317385}}
```

### 3.4 RPC auth from Secret Manager — verified live, value never printed

The secret was piped over SSH stdin into a shell variable and fed to `curl` via a `-K -` config on stdin, so
it appears in no argv, no log, and no output. Verified three ways at **2026-08-12T15:04Z**:

| Check | Result |
|---|---|
| `sha256` of `arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth` (local) | `e93997a5…04b2a4`, length 110 |
| `sha256` of `rpcuser:rpcpassword` derived from the node's `bitcoin.conf` | `e93997a5…04b2a4`, length 110 |
| Equality | **MATCH — the Secret Manager value *is* the node's credential** |

```
# live call, Secret Manager credential, loopback
$ curl -K - -d '{"jsonrpc":"1.0","id":"bl2","method":"getblockcount","params":[]}' http://127.0.0.1:38332/
{"result":317385,"error":null,"id":"bl2"}
HTTP_STATUS=200

# negative control — deliberately wrong password
HTTP_STATUS=401

# same credential against the LAN bind
$ curl … http://10.33.10.10:38332/
HTTP_STATUS=403
```

The **403 on `10.33.10.10` is the correct and expected result, not a fault.** The request originates from
the VM itself (source `10.33.10.10`), which is in neither `127.0.0.1/32` nor `10.33.11.0/28`, so bitcoind's
`rpcallowip` rejects it. Critically, a 403 means the request *reached bitcoind's HTTP server* — it proves
the `10.33.10.10:38332` bind is live and the ACL is enforcing exactly the intended allowlist. A connection
refusal or timeout would have been the failure signal. Traffic from the connector at `10.33.11.x` is inside
the allowed CIDR.

`arkova-s33-rig-b1-bitcoin-core-signet-rpc-url` reads `http://10.33.10.10:38332` — matching the live bind.

### 3.5 Proof-path sanity — exactly the two calls `fetchConfirmationProof` makes

Run against the recovered node for the Phase-2 transactions in block **317382**
(`getblockhash 317382` → `0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b`, matching both
public explorers in §2.6):

**`getblockheader <hash> false`** — the raw header:

```
0000002005fd2fe7f46ea7b7e8d01d3d0eb5a51e9a3c35c1788118917669a2f20e00000037a9257fae748fe9a1f26754ada9fa80b0833bae93bc5fdd19a1af45e536bd3f9d817c6a9f6a141d3b97220c
```

**160 hex characters = exactly 80 raw bytes** — which is precisely what
`confirmation-proof.ts`'s `BLOCK_HEADER_HEX_RE = /^[0-9a-fA-F]{160}$/` demands and what BL-2 sub-criterion 3
requires `octet_length(anchor_proofs.block_header)` to be. Independently verified offline:

```
double-SHA256(header) = 0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b   -> MATCH
merkleroot in header  = 3fbd36e545afa119dd5fbc93ae3b83b080faa9ad5467f2a1e98f74ae7f25a937
block time in header  = 1786544541  (= 2026-08-12T14:22:21Z, matching both explorers)
```

**`gettxoutproof`** — the CMerkleBlock inclusion proof, for all three Phase-2 transactions:

| txid | proof length | `verifytxoutproof` round-trip |
|---|---|---|
| `eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223` | 818 hex | returns the same txid ✅ |
| `d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc` | 818 hex | returns the same txid ✅ |
| `b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70` | 818 hex | returns the same txid ✅ |

Proof for `eb28b03a…d223`, verbatim:

```
0000002005fd2fe7f46ea7b7e8d01d3d0eb5a51e9a3c35c1788118917669a2f20e00000037a9257fae748fe9a1f26754ada9fa80b0833bae93bc5fdd19a1af45e536bd3f9d817c6a9f6a141d3b97220cd80100000a14580da465c8a7002a8396f43a932761966546147a88117a6b71e26999899dc325ab212e3eaccac049d312c84d5231e069b8130031f9dd476850d28a3af4f4cec20fc8d989512d218a37bcceb86ba5a02d96b9ddf12fd163acee43b82a55a6c19564dffd6ae58cd172d979dc819ef85e9ab674d90edc3c6b9e0ef53fba2ce65923d2d4448e08709e86614db52e1b1e8a355df953aad74179442e7bc03ab028eb27608b5a6464c23940fa081e488848f25621c433c67bcc046eb11b3e2a72bcb8f70882e51291a2c871e2f4ada0e41faa933efb30c4832e2f665408ca2ea7d808c6bb36f499ce59d8c8f6c097e3389cc1e4d6e64c353980f724fe10366c438188feca23a8cfff9756055941b9e59f2c6f370f6f972210d833edb9f51d23f9b01089d4cdbaec0f0d2abede48e1a5b3f4ff8d2649165d924ff5937e5c9bf2d868de035d3d00
```

**The proof's first 160 hex characters are byte-identical to the `getblockheader` output.** That is the
exact cross-check `fetchConfirmationProof` performs (`parsed.blockHeader !== headerHex ⇒ stale`), so it will
pass rather than mark the proof stale.

`getrawtransaction eb28b03a…d223 true` also resolves through txindex (`confirmations: 4`, correct
`blockhash`), confirming the index serves non-wallet transactions — the prerequisite for the whole path.

### 3.6 Network path — firewall and connector both verified

**GCP firewall** (`gcloud compute firewall-rules describe`), unchanged and correct:

| Field | Value |
|---|---|
| name | `arkova-s33-rig-b1-bitcoin-core-signet-rpc` ✅ |
| network | `arkova-s33-rig-b1-bitcoin-core-signet-vpc` ✅ |
| direction / priority | INGRESS / 1000, `disabled: false` |
| sourceRanges | `['10.33.11.0/28']` ✅ |
| allowed | `tcp:38332` ✅ |
| targetTags | none (applies to every instance on the network) |

Sibling rule `arkova-s33-rig-b1-bitcoin-core-signet-iap-ssh` (`35.235.240.0/20`, tcp:22) is what this
session's SSH used.

**COS host firewall** — a second layer the VPC rule does not cover, installed by the startup script and
verified present on this boot:

```
-A INPUT -s 10.33.11.0/28 -d 10.33.10.10/32 -p tcp -m tcp --dport 38332 -j ACCEPT
```

**VPC connector** — created by the main session while this phase ran, verified **READY** and correctly
aligned:

```
CONNECTOR_ID      NETWORK                                    IP_CIDR_RANGE  STATE  MIN  MAX
fullsoak-btc-rpc  arkova-s33-rig-b1-bitcoin-core-signet-vpc  10.33.11.0/28  READY   2    3
```

Its network and CIDR match the firewall rule's `sourceRanges` and the node's `rpcallowip` exactly.

### 3.7 Prerequisite the deploy still needs — the connector is NOT attached yet

Read-only `describe` of `arkova-worker-fullsoak-2026-08-staging` at 15:06Z. The secret wiring is **already
correct** — no change needed there:

| Env var | Source | Resolves to |
|---|---|---|
| `BITCOIN_RPC_URL` | secret `arkova-s33-rig-b1-bitcoin-core-signet-rpc-url:latest` | `http://10.33.10.10:38332` ✅ |
| `BITCOIN_RPC_AUTH` | secret `arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth:latest` | verified working in §3.4 ✅ |
| `BITCOIN_UTXO_PROVIDER` | literal | `mempool` ← the one value the deploy changes |

But:

```
run.googleapis.com/vpc-access-connector = None
run.googleapis.com/vpc-access-egress    = None
run.googleapis.com/network-interfaces   = None
```

**The service has no VPC egress configured**, so `10.33.10.10` is currently unreachable from it. Setting
`BITCOIN_UTXO_PROVIDER=getblock` without also attaching `fullsoak-btc-rpc` would make every UTXO listing,
**every broadcast**, and every inclusion-proof fetch fail — strictly worse than today. The deploy must set
both in the same revision:

```
--vpc-connector fullsoak-btc-rpc  --vpc-egress private-ranges-only
```

`private-ranges-only` is sufficient and preferable: only `10.33.10.10` needs the VPC, while mempool.space
(fee estimator, and `GetBlockHybridProvider`'s own address-query fallback) must keep egressing to the
internet. The runtime service account `270018525501-compute@developer.gserviceaccount.com` already reads
both secrets, so no IAM change is required.

Two further notes for whoever runs the deploy:

- **Do not set `MEMPOOL_API_URL`.** `createUtxoProvider({type:'getblock'})` derives its mempool base from
  `MEMPOOL_URLS[network]` when the var is unset, which is the correct signet endpoint. Setting it is a known
  contract hazard (inconsistent `/api` handling) and previously froze a soak's confirmations.
- **Switching to `getblock` moves broadcast onto this node**, not just proof reads. The node therefore has
  to stay up for the whole 7-day soak, and its liveness belongs in BL-5's monitoring scope — today nothing
  watches it, and a dead node would stall anchoring outright rather than degrade it.

### 3.8 NODE READY

| Check | Status |
|---|---|
| bitcoind process running, correct binary and conf | ✅ Docker `arkova-rig-b1-bitcoin-core`, Core v31.1.0, digest-pinned |
| `blocks == headers`, `initialblockdownload: false` | ✅ 317,385 / 317,385, `false`, progress 1 |
| Not pruned | ✅ `pruned: false`, 21.25 GB on disk, 68 GB free |
| `txindex` synced | ✅ `{"synced": true, "best_block_height": 317385}` |
| Secret Manager RPC auth accepted by the node | ✅ HTTP 200 `{"result":317385}`; wrong password → 401 |
| Secret == node credential | ✅ sha256 `e93997a5…04b2a4` on both sides |
| `getblockheader <hash> false` returns 80 raw bytes | ✅ 160 hex, dSHA256 == block 317382 hash |
| `gettxoutproof` returns a verifiable proof | ✅ all three Phase-2 txids, `verifytxoutproof` round-trips |
| Proof's embedded header == fetched header | ✅ byte-identical (the worker's stale-check passes) |
| GCP firewall `…-rpc`, correct network/range/port | ✅ `10.33.11.0/28` → tcp:38332, enabled |
| COS host iptables rule | ✅ present and reboot-installed by the startup script |
| VPC connector `fullsoak-btc-rpc` | ✅ READY, same network, `10.33.11.0/28` |
| Cloud Run VPC egress attached | ❌ **not yet — owned by the main session's deploy (§3.7)** |

**NODE READY.** The RPC node satisfies every requirement of `GetBlockHybridProvider` and of BL-2
sub-criterion 3. The single remaining gap is on the Cloud Run side: attach `fullsoak-btc-rpc` with
`--vpc-egress private-ranges-only` in the same revision that sets `BITCOIN_UTXO_PROVIDER=getblock`.

---

## Phase 4 — final revision close-out (`00013-mrw`)

The §3 verdict was accepted and the CTO authorised **one deliberate pre-clock freeze break** to close
sub-criteria 1 and 3 together. Phase 4 re-runs BL-2 against the resulting revision.

### 4.1 The freeze break — what changed, and what deliberately did not

| Field | Value |
|---|---|
| New revision | `arkova-worker-fullsoak-2026-08-staging-00013-mrw` |
| Revision created | **2026-08-12T15:09:42.414804Z** |
| `ContainerReady` | 2026-08-12T15:09:45.778634Z |
| `ContainerHealthy` | 2026-08-12T15:10:02.472140Z |
| `MinInstancesProvisioned` | 2026-08-12T15:10:05.896578Z |
| **`Ready` = True** | **2026-08-12T15:10:05.965578Z** ← soak clock-start leg |
| `Active` = True | 2026-08-12T15:10:06.095865Z |
| Traffic | 100% to `00013-mrw` (`latestRevision: true`) |

**Image digest is UNCHANGED** —
`us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18`,
byte-identical to `00012-f45` and to prod. **BL-1 digest parity is preserved across the freeze break**: this
is a configuration change, not a new build, so no untested code entered the rig.

Deltas from `00012-f45`, read live at 15:11Z:

| Setting | `00012-f45` | `00013-mrw` |
|---|---|---|
| `BITCOIN_UTXO_PROVIDER` | `mempool` | **`getblock`** |
| `run.googleapis.com/vpc-access-connector` | *(none)* | **`fullsoak-btc-rpc`** |
| `run.googleapis.com/vpc-access-egress` | *(none)* | **`private-ranges-only`** |
| `USE_MOCKS` | false | false |
| `ENABLE_PROD_NETWORK_ANCHORING` | true | true |
| `BITCOIN_NETWORK` | signet | signet |
| `BITCOIN_FEE_STRATEGY` | mempool | mempool |
| `FORCE_DYNAMIC_FEE_ESTIMATION` | true | true |
| `MEMPOOL_API_URL` | unset | **unset** (deliberately — §3.7) |

### 4.2 Boot truth on `00013-mrw`, captured from the log

`gcloud logging read` scoped to `revision_name="…-00013-mrw"`:

```json
2026-08-12T15:10:02.319838Z {"msg":"Creating mempool fee estimator","baseUrl":"https://mempool.space/signet/api","network":"signet","strategy":"mempool","target":"halfHour","level":30}
2026-08-12T15:10:19.807739Z {"msg":"Worker service started","env":"production","mocks":false,"network":"signet","port":3001,"level":30}
2026-08-12T15:10:25.881347Z {"msg":"Creating GetBlock hybrid UTXO provider","provider":"getblock","rpcUrl":"http://10.33.10.10:38332","mempoolBaseUrl":"https://mempool.space/signet/api","level":30}
2026-08-12T15:10:25.881362Z {"msg":"Creating WIF signing provider","provider":"wif","level":30}
2026-08-12T15:10:25.881369Z {"msg":"Creating mempool fee estimator","baseUrl":"https://mempool.space/signet/api","network":"signet","strategy":"mempool","target":"halfHour","level":30}
2026-08-12T15:10:25.881377Z {"msg":"Using BitcoinChainClient (signet)","feeEstimator":"Mempool.space","utxoProvider":"GetBlock Hybrid (RPC broadcast + Mempool UTXO)","network":"signet","level":30}
2026-08-12T15:10:25.881384Z {"msg":"Bitcoin chain client initialized","feeEstimator":"Mempool.space","provider":"GetBlock Hybrid (RPC broadcast + Mempool UTXO)","signer":"WIF (ECPair)","address":"tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7","level":30}
2026-08-12T15:10:25.881389Z {"msg":"Chain client initialized","level":30}
2026-08-12T15:10:25.881394Z {"msg":"Scheduled jobs configured (including chain maintenance)","level":30}
```

`rpcUrl` resolves to **`http://10.33.10.10:38332`** — the recovered node from Phase 3, reached over the
`fullsoak-btc-rpc` connector. `mocks: false`. Zero errors or warnings in the boot window. `feeEstimator`
still reads **`Mempool.space`**, so the BL-2 sub-criterion 4 evidence carries forward unchanged onto the new
revision.

### 4.3 F-D0-3 corrected: this is a parity WIN, not merely a parity fix

The Phase-1 framing of F-D0-3 said the rig's `mempool` provider diverged from prod's `getblock`. That was
true but understated *what `getblock` is*. `GetBlockHybridProvider` is not "RPC instead of mempool" — it is
**RPC for broadcast and inclusion proofs, mempool.space for UTXO listing and fee estimation**, and the boot
log names it exactly that: `GetBlock Hybrid (RPC broadcast + Mempool UTXO)`.

That hybrid split *is* production's architecture. So the rig has not just been unblocked for BL-2 #3 — it
has moved from testing an architecture that exists nowhere in production to testing **prod's exact chain
architecture**, on prod's exact image digest:

| Path | `00012-f45` (mempool) | `00013-mrw` (getblock hybrid) | prod |
|---|---|---|---|
| Broadcast | mempool.space REST | **GetBlock/Core RPC `sendrawtransaction`** | Core RPC |
| Inclusion proof (`gettxoutproof`) | **unsupported ⇒ always `pending`** | **Core RPC** | Core RPC |
| Block header (`getblockheader`) | supported | Core RPC | Core RPC |
| UTXO listing | mempool.space REST | mempool.space REST | mempool.space REST |
| Fee estimation | mempool.space | mempool.space | mempool.space |

F-D0-3 should therefore be recorded as **closed, with an upgrade**: the finding identified a rig↔prod
divergence whose repair also put two previously-untested production code paths (RPC broadcast, RPC
inclusion-proof fetch) under soak for the first time on this rig.

### 4.4 `910e557c…c296` — two-explorer confirmation

The one Phase-2 transaction still unconfirmed when §2.6 was written. Captured **2026-08-12T15:11:57Z**:

```
$ curl -s https://mempool.space/signet/api/tx/910e557ca07656b829908bfcc85dd38a04c04f310c5d2846c4c0fe9bffb8c296/status
{"confirmed":true,"block_height":317384,"block_hash":"0000000ec51f8989749a47b18e4ed5957ca3dedbd86ee9fbc4b5ca4b9b6c7808","block_time":1786545267}

$ curl -s https://blockstream.info/signet/api/tx/910e557ca07656b829908bfcc85dd38a04c04f310c5d2846c4c0fe9bffb8c296/status
{"confirmed":true,"block_height":317384,"block_hash":"0000000ec51f8989749a47b18e4ed5957ca3dedbd86ee9fbc4b5ca4b9b6c7808","block_time":1786545267}
```

**All four Phase-2 transactions are now confirmed and double-verified.** Every txid produced on the final
revision family resolves `confirmed: true` with a block height on two independent explorers.

**A caveat worth recording, because it looks like an error and is not.** Block 317384's header timestamp is
`1786545267` = **14:34:27Z**, which is 27 s *before* the worker broadcast this transaction (14:34:54.953Z),
and the block was still absent from both explorers at 14:53:07Z when the tip read 317383. Bitcoin block
timestamps are miner-set and constrained only to exceed median-time-past and not run more than 2 h ahead —
signet's signer back-dated this one. The practical consequence: **`anchors.chain_timestamp` is a header
value, not an observation time, and must never be presented as "when this was anchored."** That is exactly
why §1.5 of the constitution requires the UI to call it *Network Observed Time* and why proof packages state
what is measured versus asserted. No action needed; recorded so a future reader does not chase it as a
clock bug.

### 4.5 Sub-criterion 3 closed first — the Phase-1 five backfilled 4 minutes after the deploy

`populate-confirmation-proofs` takes **no run lease**, so it did not have to wait for the stuck
`check-confirmations` lease. It was forced at **15:14:00Z**, three and a half minutes after `00013-mrw`
became Ready, against the five already-SECURED Phase-1 anchors:

```
$ curl -s -X POST '.../jobs/populate-confirmation-proofs'          # 2026-08-12T15:14:00Z
{"skipped":false,"scanned":5,"txAttempted":2,"txConfirmed":2,"txPending":0,"txStale":0,
 "anchorsUpdated":5,"anchorsMissing":0}
```

Compare against the identical call on `00012-f45` (§1.7): `txConfirmed: 0`, `txPending: 2`,
`anchorsUpdated: 0`. **The only change between the two is `BITCOIN_UTXO_PROVIDER`.**

Rig log, `correlationId req_a2b437b05155be9ceb0e84ab`:

```json
15:14:00.508779Z {"msg":"Creating GetBlock hybrid UTXO provider","provider":"getblock","rpcUrl":"http://10.33.10.10:38332","mempoolBaseUrl":"https://mempool.space/signet/api"}
15:14:01.072854Z {"msg":"confirmation-proof population complete","txAttempted":2,"txConfirmed":2,"txPending":0,"txStale":0,"anchorsUpdated":5,"anchorsMissing":0}
```

Total elapsed 0.58 s for two `getblockheader` + `gettxoutproof` round-trips over the VPC connector to
`10.33.10.10`. The connector path is not merely reachable — it is fast.

**Stored headers verified as raw bytes, not text:**

```sql
SELECT a.public_id, ap.block_height, ap.block_hash,
       octet_length(ap.block_header) AS block_header_octets, encode(ap.block_header,'hex')
FROM anchor_proofs ap JOIN anchors a ON a.id = ap.anchor_id WHERE ap.block_header IS NOT NULL;
```

| public_id | block_height | `octet_length(block_header)` |
|---|---|---|
| ARK-2026-9E74FF50 | 317376 | **80** |
| ARK-2026-DD555097 | 317376 | **80** |
| ARK-2026-BA3660AE | 317376 | **80** |
| ARK-2026-96538D45 | 317376 | **80** |
| ARK-2026-F6C93E15 | 317376 | **80** |

**80, not 160** — so the column holds the raw 80-byte header via `toByteaHex`'s `\x` prefix, not an ASCII
hex encoding of it. That distinction is the entire point of BL-2 sub-criterion 3 and of the BUG-4 fix in
`utils/anchorProofs.ts:161`.

**Cross-check against the node, byte-for-byte.** Stored value for block 317376:

```
00000020178adcfe72a82ba7fb229cc8be60e8571e64e85ef58832344006da06010000006209346a8ef0a10bfa9da449ad26af7652551fda4281b10485219a6c19f448bb31727c6a9f6a141d7b3abf08
```

`bitcoin-cli -signet getblockheader 000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f false`
on `arkova-s33-rig-b1-bitcoin-core-signet` returns **the identical 160-hex string**. Independently verified
offline: `double-SHA256(header) = 000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f`, equal
to `anchor_proofs.block_hash` and to the `block_hash` both public explorers reported in §1.3, and the
header's embedded time decodes to `1786540593` = 2026-08-12T13:16:33Z. Four independent sources agree on
the same 80 bytes.

Node headers captured for reference across all three blocks that hold rig anchors:

| height | block hash | raw header (160 hex) |
|---|---|---|
| 317376 | `000000069c134dd3…dd11f0f` | `00000020178adcfe…7b3abf08` |
| 317382 | `0000000c987e1ef2…9face6b` | `0000002005fd2fe7…3b97220c` |
| 317384 | `0000000ec51f8989…9b6c7808` | `000000208bdcc146…ab37ae03` |

### 4.6 Sub-criterion 1 — waiting out the stuck lease, then promotion

F-D0-5's holder (`…00012-f45:1:8ce98a73-…`) died when traffic cut over at ~15:10, so its heartbeat stopped.
Last renewal was **15:02:50.519Z**, fixing the TTL at **15:37:50.519Z** — 35 min later, exactly `ttlMs`.
The lease row was again **not touched by hand**.

That the new revision was blocked *only* by the DB lease, and not self-blocked, is visible at 15:14:00Z when
the in-process cron on `00013-mrw` tried to run:

```json
15:14:00.840742Z {"msg":"Run skipped — another instance holds the run lease","lease":"confirmation check","holder":"arkova-worker-fullsoak-2026-08-staging-00013-mrw:1:66cbbd7f-…"}
```

`another instance holds the run lease` — the CAS path, not `already in progress on this instance`. A fresh
process reaches the lease correctly; only the orphaned row stands in the way. This is the F-D0-5 recovery
that a deploy provides and that a hung-but-alive holder never does.

**Promotion, 11 seconds after the TTL lapsed.** The lease expired at 15:37:50.519Z; the rig's own
in-process cron tick at **15:38:01.165Z** (no `correlationId` — node-cron, not HTTP) won the CAS and ran to
completion in **12.1 s**:

```json
15:38:01.165440Z {"msg":"Starting confirmation check for SUBMITTED anchors"}
15:38:04.607806Z {"msg":"Checking SUBMITTED anchors grouped by tx_id","uniqueTxIds":4,"scannedRows":7,"currentTipHeight":317386,"minConfirmations":1,"wrapped":false}
15:38:13.019038Z {"msg":"Bulk confirmed anchor group (shared tx)","txId":"eb28b03ac07b2e447941d7aa53f95d358a1e1b2eb54d61869e70088e44d4d223","blockHeight":317382,"confirmations":5,"confirmed":2}
15:38:13.198303Z {"msg":"Bulk confirmed anchor group (shared tx)","txId":"d73a3f0b76eda27b8dd564b335d77808325ab76dab777c3ae0110e795084d7bc","blockHeight":317382,"confirmations":5,"confirmed":2}
15:38:13.240248Z {"msg":"Bulk confirmed anchor group (shared tx)","txId":"910e557ca07656b829908bfcc85dd38a04c04f310c5d2846c4c0fe9bffb8c296","blockHeight":317384,"confirmations":3,"confirmed":2}
15:38:13.247413Z {"msg":"Bulk confirmed anchor group (shared tx)","txId":"b31195ea86f9e45d0a9feb8816aec722026c2898bf957dde1fd84b4ec82cce70","blockHeight":317382,"confirmations":5,"confirmed":1}
15:38:13.247429Z {"msg":"Confirmation check complete","txChecked":4,"anchorsConfirmed":7,"candidateRows":7,"scannedRows":7,"wrapped":false}
```

**`anchorsConfirmed: 7`** — every remaining SUBMITTED anchor, across all four transactions, in one pass.
`anchor.secured` webhooks fanned out immediately after (15:38:22–15:38:27Z, `anchorsDispatched` 4/4/2/4).

The lease then released cleanly: `status: completed`, `scheduled_for: NULL`, last holder
`…-00013-mrw:1:4846a79f-…`.

*Footnote on the forced POSTs.* The 10 explicit `POST /jobs/check-confirmations` calls made from 15:38:12Z
onward all returned `{"checked":0,"confirmed":0}` — because the in-process tick beat them by 12 s and the
per-process `inFlight` guard short-circuited the rest (`Run skipped — already in progress on this
instance`, 15:38:13.028Z). Benign here, but it is F-D0-2 demonstrating itself a second time: the response
body is identical whether the run did everything, nothing, or was blocked. The promotion is attributable
from the logs, not from any HTTP response.

### 4.7 Proof population for the newly-SECURED seven

```
15:40:18.723651Z {"msg":"confirmation-proof population complete","txAttempted":4,"txConfirmed":4,"txPending":0,"txStale":0,"anchorsUpdated":7,"anchorsMissing":0}
```

`txPending: 0`, `txStale: 0`, `anchorsMissing: 0`. Combined with §4.5's five, **all 12 anchors now carry a
populated `block_header`.**

### 4.8 Final database state — 2026-08-12T15:46:02Z

```sql
SELECT count(*) FROM anchors;                                             -- 12
SELECT count(*) FROM anchors WHERE status='SECURED';                      -- 12
SELECT count(*) FROM anchors WHERE status<>'SECURED';                     --  0
SELECT count(*) FROM anchor_proofs;                                       -- 12
SELECT count(*) FROM anchor_proofs WHERE octet_length(block_header)=80;   -- 12
SELECT count(*) FROM anchor_proofs WHERE block_header IS NULL;            --  0
SELECT count(*) FROM anchor_proofs WHERE octet_length(block_header)<>80;  --  0
SELECT count(*) FROM anchors WHERE chain_block_height > 400000;           --  0   <- mock detector
-- anchors.chain_block_hash vs anchor_proofs.block_hash disagreement:        0
-- distinct block_header values:                                             3
```

Per-anchor, ordered by block:

| public_id | status | chain_tx_id | block height | `chain_block_hash` == `proof.block_hash` | `octet_length(block_header)` | merkle_index |
|---|---|---|---|---|---|---|
| ARK-2026-9E74FF50 | SECURED | `81baf563…2bd` | 317376 | ✅ | **80** | 0 |
| ARK-2026-96538D45 | SECURED | `3a3eec24…9a9` | 317376 | ✅ | **80** | 0 |
| ARK-2026-BA3660AE | SECURED | `3a3eec24…9a9` | 317376 | ✅ | **80** | 1 |
| ARK-2026-F6C93E15 | SECURED | `3a3eec24…9a9` | 317376 | ✅ | **80** | 2 |
| ARK-2026-DD555097 | SECURED | `3a3eec24…9a9` | 317376 | ✅ | **80** | 3 |
| ARK-2026-AEC77DB2 | SECURED | `eb28b03a…d223` | 317382 | ✅ | **80** | 0 |
| ARK-2026-BAC1FC13 | SECURED | `eb28b03a…d223` | 317382 | ✅ | **80** | 1 |
| ARK-2026-EEDA3CEC | SECURED | `d73a3f0b…d7bc` | 317382 | ✅ | **80** | 0 |
| ARK-2026-F180C87A | SECURED | `d73a3f0b…d7bc` | 317382 | ✅ | **80** | 1 |
| ARK-DOC-S3DQE5 | SECURED | `b31195ea…ce70` | 317382 | ✅ | **80** | 0 |
| ARK-2026-2432CB45 | SECURED | `910e557c…c296` | 317384 | ✅ | **80** | 0 |
| ARK-2026-9476A947 | SECURED | `910e557c…c296` | 317384 | ✅ | **80** | 1 |

**All three distinct headers verified against the node and offline:**

| height | rows | `octet_length` | `dSHA256(header)` == `block_hash` | identical to node `getblockheader` | header time |
|---|---|---|---|---|---|
| 317376 | 5 | 80 | **true** | **true** | 2026-08-12T13:16:33Z |
| 317382 | 5 | 80 | **true** | **true** | 2026-08-12T14:22:21Z |
| 317384 | 2 | 80 | **true** | **true** | 2026-08-12T14:34:27Z |

Each of the twelve rows therefore carries an 80-byte header that (a) came from our own Bitcoin Core node,
(b) hashes to the block hash the DB records, and (c) hashes to the block hash **two independent public
explorers** report for that transaction. There is no step in that chain that relies on the database's own
claim about itself.

### 4.9 Two-explorer sweep, all six rig transactions — 2026-08-12T15:47:33Z

Every txid the rig has ever produced, checked against both explorers in one pass. `IDENTICAL` means the two
responses were compared byte-for-byte and matched:

```
eb28b03a…d223  IDENTICAL  {"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}
d73a3f0b…d7bc  IDENTICAL  {"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}
b31195ea…ce70  IDENTICAL  {"confirmed":true,"block_height":317382,"block_hash":"0000000c987e1ef21a5e717c8315065dfffabe5645c9083328a440a289face6b","block_time":1786544541}
910e557c…c296  IDENTICAL  {"confirmed":true,"block_height":317384,"block_hash":"0000000ec51f8989749a47b18e4ed5957ca3dedbd86ee9fbc4b5ca4b9b6c7808","block_time":1786545267}
81baf563…d2bd  IDENTICAL  {"confirmed":true,"block_height":317376,"block_hash":"000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f","block_time":1786540593}
3a3eec24…39a9  IDENTICAL  {"confirmed":true,"block_height":317376,"block_hash":"000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f","block_time":1786540593}
```

Six transactions, twelve responses, two independent explorers: **all `confirmed: true`, all with a block
height, zero disagreements.** Every `block_height` matches the corresponding `anchors.chain_block_height`,
and every `block_hash` matches `anchors.chain_block_hash` and `anchor_proofs.block_hash`.

---

## 4.10 BL-2 VERDICT — revision `00013-mrw`

| # | BL-2 sub-criterion | Verdict | Artifact |
|---|---|---|---|
| **1** | `anchors.status = 'SECURED'` | **PASS** | 12 of 12 anchors SECURED, 0 not-SECURED, at 15:46:02Z. Promotion by the worker's own `check-confirmations` run at 15:38:13.247Z — `{"msg":"Confirmation check complete","txChecked":4,"anchorsConfirmed":7}` plus §1.6's earlier 5. §4.6, §4.8 |
| **2** | `chain_tx_id` resolves `confirmed: true` **with a block height** on **two** independent signet explorers | **PASS** | 6/6 txids, 12/12 responses, mempool.space and blockstream.info byte-identical, heights 317376 / 317382 / 317384, captured 15:47:33Z. §4.9 |
| **3** | matching `anchor_proofs` row with `block_header` = **80 raw bytes** | **PASS** | 12 of 12 proof rows, `octet_length(block_header) = 80` (not 160 ⇒ raw `bytea`, not hex text). 0 NULL, 0 wrong length. All 3 distinct headers byte-identical to the node's `getblockheader … false` and each `dSHA256` == the recorded `block_hash`. §4.5, §4.7, §4.8 |
| **4** | rig boot log reads `feeEstimator` as the intended estimator, **captured from the log** | **PASS** | `00013-mrw` boot, 15:10:25.881377Z: `{"msg":"Using BitcoinChainClient (signet)","feeEstimator":"Mempool.space","utxoProvider":"GetBlock Hybrid (RPC broadcast + Mempool UTXO)","network":"signet"}`, `mocks: false`, `signer: "WIF (ECPair)"`. §4.2 |

**Overall BL-2 on `arkova-worker-fullsoak-2026-08-staging-00013-mrw`: PASS — all four sub-criteria.**

Supporting controls, all still clean:

| Control | Result |
|---|---|
| Mock detector `chain_block_height > 400000` | **0** (would be 800,000 under `MockChainClient`) |
| `anchors.chain_block_hash` vs `anchor_proofs.block_hash` | **0 disagreements** across 12 rows |
| Anchors with no `anchor_proofs` row | **0** (`anchorsMissing: 0` on every backfill pass) |
| Proofs `pending` / `stale` after the provider change | **0 / 0** (`txPending: 0`, `txStale: 0`) |
| On-chain OP_RETURN root vs `anchor_proofs.merkle_root` | matched on all four Phase-2 txs (§2.5) |
| Fee rate vs `fastestFee` at broadcast | 4.019 ≥ 4 sat/vB on every Phase-2 broadcast (§2.4) |
| Image digest vs prod | identical (`sha256:8ace89d4…`) across `00012-f45` and `00013-mrw` |

**What the whole BL-2 exercise established, end to end:** an anchor created through a real API/connector
flow on the final revision is batched, Merkle-committed, signed, broadcast at a live-market fee rate,
mined, promoted to SECURED by the worker's own job, and given an 80-byte block header plus a Merkle
inclusion path fetched from Arkova's own Bitcoin Core node — with every stage corroborated by at least one
source that is not the database making the claim. That is the product, proven working on prod's image.

### 4.11 Findings status after Phase 4

| ID | Status |
|---|---|
| **F-D0-1** lease TTL self-heal | **Confirmed twice.** Recovered the deploy-killed holder at 14:00:57Z (35 m 26 s) and the traffic-cut holder at 15:38:01Z (35 m 11 s after its last heartbeat). Both without any manual edit. Working as designed. |
| **F-D0-2** lease-blocked and empty runs return identical JSON | **Open (low).** Demonstrated a second time at 15:38:12–15:45:02Z: 10 forced calls returned `{"checked":0,"confirmed":0}` while the work had already succeeded. The response body carries no information about what happened. |
| **F-D0-3** rig↔prod UTXO-provider divergence | **CLOSED, with an upgrade.** `getblock` on `00013-mrw` both unblocks sub-criterion 3 and moves the rig onto prod's exact hybrid chain architecture — RPC broadcast + RPC inclusion proofs + mempool UTXO/fees. Two production code paths are now under soak that never were before. §4.3 |
| **F-D0-4** fee rate logged only at `debug` | **Open (low).** Unchanged by this deploy. Any sat/vB claim still has to be derived from `fee` + vsize rather than quoted from a log line. |
| **F-D0-5** hung `check-confirmations` run deadlocks promotion | **Open (blocking for production).** The rig recovered only because the deploy killed the holder — that is not a fix, it is a restart. A hung-but-alive holder still renews its lease forever, still self-blocks its instance via `inFlight`, still returns 200, and still emits no warning. Remediation task queued: bound `body()` against the TTL in `withRunLease`, add a response-body timeout to the mempool.space `fetch(...).json()` sites, and make lease-blocked runs distinguishable. **Prod exposure is unchanged.** |

### 4.12 Soak clock-start inputs from this phase

| Leg | Value |
|---|---|
| Final revision | `arkova-worker-fullsoak-2026-08-staging-00013-mrw` |
| **Revision `Ready` = True (`status.conditions[].lastTransitionTime`)** | **2026-08-12T15:10:05.965578Z** |
| Revision created | 2026-08-12T15:09:42.414804Z |
| Traffic 100% to `00013-mrw` | yes, `latestRevision: true` |
| Image digest | `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` (== prod) |
| BL-2 closed at | 2026-08-12T15:47:33Z (last verification capture) |

Per BL-4, the clock start is the **later** of the revision start and the `SOAK_GATE_DISABLED=false`
timestamp. This document supplies the revision leg only; the gate variable is not this session's to read or
flip, and no claim is made about it here.

---

## 5. Rig-integrity attestation

*(Phases 0–2, on revision `00012-f45`.)*

- No deploy, restart, revision change, env change, scheduler change, or secret change was made to
  `arkova-worker-fullsoak-2026-08-staging`. It served `00012-f45` at 100% traffic throughout.
- Every `anchors` / `anchor_proofs` mutation in this document was performed by the worker's own jobs,
  reached over authenticated HTTP (`POST /jobs/check-confirmations`, `/jobs/populate-confirmation-proofs`,
  `/jobs/batch-anchors?force=true`) or by the rig's own Cloud Scheduler / in-process schedules.
- **No direct INSERT/UPDATE was issued against `anchors` or `anchor_proofs`.** All SQL run against
  `gnkuaywlpmsaezwvlvhk` was `SELECT`.
- The stuck `check-confirmations:lease` row was **not** edited, deleted, or expired by hand — in Phase 1
  because the TTL self-heal was the evidence, and in §2.6a because doing so would be exactly the
  intervention this exercise is meant to avoid.
- 517 unauthenticated-payload `GET /health` requests were issued over 120 s at 14:35:47–14:37:47Z as a
  read-only attempt to give the throttled instance CPU. This is traffic, not a configuration change, and it
  did not unblock the hung run.

**Phase 3 additions to the attestation:**

- On `arkova-s33-rig-b1-bitcoin-core-signet` the work was **read-only**: `systemctl`/`docker ps`/`docker
  inspect`/`bitcoin-cli` queries, config and log reads, and RPC calls that only read
  (`getblockchaininfo`, `getindexinfo`, `getnetworkinfo`, `getblockhash`, `getblockheader`,
  `gettxoutproof`, `verifytxoutproof`, `getrawtransaction`, `getblockcount`). Nothing was installed,
  restarted, reconfigured, or written. bitcoind was already running when the phase began — it was brought up
  by the VM's own `startup-script` at 14:59:44Z, 19 s after the VM booted.
- No change was made to `arkova-worker-fullsoak-2026-08-staging`, to the `fullsoak-btc-rpc` VPC connector,
  to any firewall rule, or to any Secret Manager secret. Every Cloud Run, connector, firewall and secret
  fact in Phase 3 came from a `describe` / `list` / `versions access` read.
- The RPC credential was never printed, echoed, or placed in argv: it was piped over SSH stdin into a shell
  variable and handed to `curl` through a `-K -` stdin config. Only its SHA-256 and byte length appear in
  this document.

**Phase 4 additions to the attestation:**

- The `00012-f45` → `00013-mrw` revision change was **not** made by this session — it was performed by the
  main session under explicit CTO authorisation as a pre-clock freeze break. Every fact recorded about it
  here comes from a read-only `gcloud run revisions describe` / `services describe` / `logging read`.
- The freeze break carried **prod's unchanged image digest** `sha256:8ace89d4…c1e18`. No new code entered
  the rig; BL-1 digest parity survives the change.
- All twelve SECURED promotions and all twelve `block_header` writes were performed by the worker's own
  `check-confirmations` and `populate-confirmation-proofs` jobs. The 15:38:01Z promotion pass was triggered
  by the rig's **own in-process cron**, not by this session — the ten forced POSTs around it all no-opped.
- The `check-confirmations:lease` row was **never** edited, cleared, or expired by hand in any phase. Both
  recoveries (14:00:57Z and 15:38:01Z) were the designed TTL self-heal.
- No write of any kind was issued to `anchors`, `anchor_proofs`, or `job_queue` from SQL. The only SQL run
  in Phase 4 was `SELECT` over `anchors`, `anchor_proofs`, `job_queue` and `information_schema`.
- The Bitcoin Core node was queried read-only in Phase 4 (`getblockhash`, `getblockheader`) to obtain the
  independent header values used for the byte-for-byte cross-check.

---

_Prepared 2026-08-12 by the BL-2 close-out session. All timestamps UTC. Claims verified against live
gcloud / Supabase MCP / mempool.space / blockstream.info output captured in-line above._

