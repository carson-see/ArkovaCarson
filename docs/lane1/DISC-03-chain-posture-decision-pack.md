# DISC-03 — Chain-Posture Decision Pack (S3-C1, Lane 1)

> **Status:** DECISION RECORD — PO decisions D1/D2 locked; **Carson's formal
> confirmation of items (a)–(d) below is PENDING.** This pack is the instrument
> that records that confirmation.
>
> **Source-of-truth note:** per CLAUDE.md §0.4 this markdown is an internal
> engineering note, NOT product documentation. The canonical DISC-03 record is
> the Confluence pack ([page 86966274](https://arkova.atlassian.net/wiki/spaces/A/pages/86966274),
> Sprint 1); this file is the S3 code-verified companion and supersedes the S1
> pack **on the OP_RETURN version-byte item only** once Carson countersigns
> decision (b) below.
>
> **Verification basis:** every code claim below was read from the working tree
> at `origin/main` merge-base `f927494e` (branch `lane1/s3-disc03-decision-pack`)
> on 2026-07-06. File:line citations are against that head. **No live prod
> runtime was queried in this session** (prod/staging access is out of scope for
> this task); where prod runtime state matters it is labelled as
> *asserted/deploy-config reality* vs *last recorded prod verification*.

---

## 0. HARD CONSTRAINT (read first)

**NO mainnet broadcast from the S3-P0 producer wave until BOTH of the
following hold:**

1. **Decisions (a), (b), and (c) below are formally Carson-confirmed** (this
   pack countersigned, or equivalent written confirmation on the Jira story /
   Confluence pack).
2. **A real-DB / real-key staging soak has proven, empirically:**
   - the **`anchor_proofs.block_header` bytea round-trip** — the raw 80-byte
     header must be stored as bytea (`\x<hex>`), read back byte-identical, and
     re-parse to the same `merkleroot`. Hex-text written into bytea silently
     stores 2× ASCII garbage; **mocked unit tests cannot catch this** — only a
     real-Postgres soak does (Bug Tracker precedent: the bytea-vs-text storage
     class, 2026-06).
   - **no double-broadcast on resume** — a worker restart / job re-pickup
     mid-anchor must not rebroadcast a new transaction for the same anchor
     (idempotency across the `sendrawtransaction` boundary; note
     `GetBlockHybridProvider.broadcastTx` already treats duplicate-tx errors as
     success, `services/worker/src/chain/utxo-provider.ts:620-624`, but that
     guard only covers byte-identical re-broadcasts — a rebuilt tx with a
     different fee/UTXO selection is a NEW txid and a real double-spend of
     treasury funds).

This constraint governs the **S3-P0 producer wave** (PO decision D1: producer +
real mainnet this sprint). It does not retroactively describe the existing
batch-anchor path already live in prod (~2.97M anchors).

---

## 1. Verified code reality (read, not asserted)

### 1.1 The OP_RETURN marker — 4-byte ASCII `ARKV`, **no version byte**

- `services/worker/src/chain/signet.ts:42-43`:

  ```ts
  // OP_RETURN prefix for Arkova anchors (4 bytes: 'ARKV')
  const OP_RETURN_PREFIX = Buffer.from('ARKV');
  ```

- Payload layout (`signet.ts:45-48`): max OP_RETURN data 80 bytes; without
  metadata `ARKV(4) + SHA-256 fingerprint(32) = 36` bytes; with metadata
  `ARKV(4) + fingerprint(32) + truncated metadata hash(8) = 44` bytes
  (16-byte metadata hash optional via `METADATA_HASH_BYTES=16`,
  `signet.ts:62-66` → 52 bytes total).
- Write path, single-input: `buildOpReturnTransaction`
  (`signet.ts:400`), payload concat at `signet.ts:419-421`:

  ```ts
  const opReturnData = metadataHashBytes
    ? Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes, metadataHashBytes])
    : Buffer.concat([OP_RETURN_PREFIX, fingerprintBytes]);
  ```

- Write path, multi-input: `buildMultiInputOpReturnTransaction`
  (`signet.ts:525`), identical concat at `signet.ts:541-543`.
- Read/verify path: `extractAnchorFingerprint` (`signet.ts:116-143`)
  structurally decompiles the script, requires exactly
  `[OP_RETURN, <buffer>]`, requires the `ARKV` prefix **at offset 0**
  (`signet.ts:136-138`), then reads the 32-byte fingerprint at bytes 4..36
  (`signet.ts:140-142`). There is **no version byte anywhere in the write or
  read path** — inserting one (e.g. `0x01` after `ARKV`) would shift the
  fingerprint offset and break every existing on-chain anchor against the
  current parser.

### 1.2 Confirmation-proof source — GetBlock RPC default; mempool fallback has NO `gettxoutproof`

- Module header, `services/worker/src/chain/confirmation-proof.ts:16-21`:

  > SOURCE (DISC-03): GetBlock RPC is the default — `getblockheader <hash>
  > false` for the raw header and `gettxoutproof [<txid>] <blockhash>` for the
  > Merkle branch. Broadcast is already GetBlock-sovereign; this keeps the
  > inclusion-proof read on the same node. A documented mempool.space fallback
  > (`/api/block/:hash/header` + `/api/tx/:txid/merkle-proof`) is provided for
  > providers without the RPC methods, but GetBlock is preferred.

- GetBlock implementations: `GetBlockHybridProvider.getBlockHeaderHex`
  (`utxo-provider.ts:657-661`, `getblockheader <hash> false`) and
  `GetBlockHybridProvider.getTxOutProof` (`utxo-provider.ts:669-674`,
  `gettxoutproof [txids] (blockhash)` — blockhash pinned so a reorged-out tx
  fails loudly). `RpcUtxoProvider` has the same pair
  (`utxo-provider.ts:373-385`).
- Mempool fallback limitation, `utxo-provider.ts:497-503` (verbatim):

  > NOTE: mempool.space has NO `gettxoutproof`-equivalent that returns the
  > serialized CMerkleBlock format `parseTxOutProof` expects (its
  > `/tx/:txid/merkle-proof` returns a different JSON shape — block_height,
  > merkle[], pos). We deliberately do NOT implement `getTxOutProof` here:
  > the confirmation-proof fetch then reports `pending` for a mempool-only
  > provider rather than fabricating an unverifiable branch (§1.5). GetBlock
  > RPC is the supported inclusion-proof source (DISC-03).

  (`MempoolUtxoProvider.getBlockHeaderHex` DOES exist as a header-only
  fallback, `utxo-provider.ts:488-495`.)
- Production wiring: the confirmation-proof cron builds its provider from
  `config.bitcoinUtxoProvider`
  (`services/worker/src/jobs/confirmation-proof-backfill.ts:56-65`) — i.e. the
  proof source **follows the same `BITCOIN_UTXO_PROVIDER` selection as
  broadcast**. With `getblock` selected, header + inclusion proof come from the
  same sovereign node that broadcast the tx.
- Empirical confirmation (S1, recorded in HANDOFF.md 2026-06-23 entries): live
  GetBlock curl-matrix vs mainnet blocks 954869 and 955029 confirmed both
  `getblockheader` and `gettxoutproof` work on the prod token.

### 1.3 Broadcast / UTXO / fee reality — the honest path-by-path table

**Correction of a stale premise:** `GetBlockHybridProvider` is **not**
"built-but-unselected." The 2026-05-30 prod audit did find prod running
`BITCOIN_UTXO_PROVIDER=mempool` (HANDOFF.md, 2026-05-30 reconciliation entry),
but commit `fe2acad9` (2026-06-05, "fix(deploy): restore sovereign Bitcoin
broadcast — BITCOIN_UTXO_PROVIDER=getblock", on `main`) restored the getblock
selection in the deploy workflow, and the R-5 gate has asserted `getblock`
since. Current repo reality:

| Path | Provider | Evidence |
|---|---|---|
| **Selection (code default)** | `'mempool'` — the latent SPOF | `services/worker/src/config.ts:55`: `bitcoinUtxoProvider: z.enum(['rpc', 'mempool', 'getblock']).default('mempool')`; env read at `config.ts:664` |
| **Selection (prod deploy)** | `'getblock'` | `.github/workflows/deploy-worker.yml:263` `--set-env-vars` includes `BITCOIN_UTXO_PROVIDER=getblock` (also `BITCOIN_NETWORK=mainnet`, `BITCOIN_FEE_STRATEGY=mempool`, `ENABLE_PROD_NETWORK_ANCHORING=true`) |
| **Broadcast** | GetBlock RPC `sendrawtransaction` | `GetBlockHybridProvider.broadcastTx`, `utxo-provider.ts:615-628` |
| **UTXO listing** | GetBlock `listunspent` attempted → **falls back to public mempool.space** (shared GetBlock endpoint returns "Method not allowed" — SCRUM-1262 RPC-matrix forensic; fallback rate is counter-instrumented) | `GetBlockHybridProvider.listUnspent`, `utxo-provider.ts:579-612` |
| **Address history (verification of aged/spent anchors)** | public mempool.space (GetBlock has no address index) | `GetBlockHybridProvider.getAddressTxs`, `utxo-provider.ts:683-685` |
| **Block header / inclusion proof** | GetBlock RPC (`getblockheader`, `gettxoutproof`) | `utxo-provider.ts:646-674` (see §1.2) |
| **Fee estimation** | mempool.space (`MempoolFeeEstimator`, name `'Mempool.space'`) | `fee-estimator.ts:88-89`; mainnet default strategy `'mempool'` at `client.ts:328-331`; deploy sets `BITCOIN_FEE_STRATEGY=mempool` |
| **Frontend balance reads** | public mempool.space | CLAUDE.md §1.1 chain row (unchanged by this pack) |

So "GetBlock-sovereign" is precisely true for **broadcast + header +
inclusion-proof**; UTXO listing, address history, fee estimation, and frontend
balance reads remain on public mempool.space — a known, accepted partial
sovereignty leak (SCRUM-1262).

**Live-runtime caveat:** this session verified the *deploy-config and gate
assertions* (repo files above), not the running Cloud Run env
(`gcloud`/prod access prohibited for this task). The S3-P0 wave should
re-verify `utxoProvider` via the worker's startup log line
(`client.ts:333-341` logs `utxoProvider: 'GetBlock Hybrid (RPC broadcast +
Mempool UTXO)'`) or `/health` before first producer broadcast.

### 1.4 Signing — WIF takes precedence (current)

- `services/worker/src/chain/client.ts:289`:

  ```ts
  // Signing: WIF takes precedence (current), KMS for future upgrade
  ```

  Branch at `client.ts:293`: `if (config.bitcoinTreasuryWif)` → WIF signing
  with mainnet network params (`client.ts:293-300`); the GCP-KMS path
  (`client.ts:301-326`) is selected **only when WIF is unset**.
- The prod deploy mounts `BITCOIN_TREASURY_WIF=bitcoin-treasury-wif:latest`
  from Secret Manager (`.github/workflows/deploy-worker.yml:262`), so the WIF
  path is the active signer even though `KMS_PROVIDER=gcp` and
  `GCP_KMS_KEY_RESOURCE_NAME` are also set (`deploy-worker.yml:263`).

---

## 2. The four decisions

PO decisions D1 (producer + real mainnet this sprint) and D2
(GetBlock-sovereign broadcast + GetBlock confirmation-proof source + keep
`ARKV` marker as-is, NO `0x01` version byte) are locked at PO level. Each item
below awaits Carson's formal countersign.

### (a) Broadcast posture at launch = GetBlock-sovereign

**Decision:** the S3-P0 producer broadcasts via the GetBlock hybrid provider
(`BITCOIN_UTXO_PROVIDER=getblock`). Any provider change is chain-touching
(T3) and lands **with the S3-P0 producer wave — NOT in this PR** (this PR is
docs-only).

**Code reality check:** the deploy workflow and the R-5 gate **already assert
`getblock`** (§1.3, §3). The remaining flip-adjacent work item for the S3-P0
wave is aligning the `config.ts` Zod default `'mempool'` → `'getblock'` so a
dropped env line fails safe instead of silently reverting broadcast to public
mempool.space — the exact drift class that bit prod on 2026-05-30. The
provider-SPOF gate currently surfaces this as the acknowledged
`code-default-divergence` WARN (`scripts/ci/config-drift/providerSpof.ts:76-86`).

**Rationale:** sovereignty of the write path (our node, our token, our rate
limits), plus keeping the confirmation-proof read on the same node that
broadcast (§1.2). The residual mempool.space read-paths are accepted and
instrumented (SCRUM-1262).

**Status: ⬜ AWAITING CARSON CONFIRMATION**

### (b) On-chain marker = `ARKV` as-is; REJECT adding a `0x01` version byte

**Decision:** the OP_RETURN payload stays exactly
`ARKV(4) + fingerprint(32) [+ metadataHash(8|16)]`. Adding a `0x01` version
byte is **rejected** as a gratuitous write-path change.

**Rationale:**
- ~2.97M anchors are already on-chain in the current format; the verifier
  (`extractAnchorFingerprint`, `signet.ts:116-143`) reads the fingerprint at a
  fixed offset immediately after `ARKV`. A version byte would fork the format:
  every verifier (worker, CLI, third-party offline verification against the
  frozen proof-packet contract) would need dual-format logic forever, for zero
  present benefit.
- Versioning is achievable **later without a byte**: a future format change
  can use a different 4-byte prefix (e.g. `ARK2`) — equally self-describing,
  no offset ambiguity, and no change to the existing parser's rejection
  behaviour (prefix mismatch at offset 0 → `null`, `signet.ts:136-138`).
- **Supersession note (why Carson's countersign matters here):** the S1 pack /
  2026-06-19 PO note recorded "OP_RETURN `0x01` + version-aware verifier" as
  the then-current direction (HANDOFF.md 2026-06-19 and 2026-06-23 entries).
  PO decision D2 (S3) reverses that to keep-`ARKV`-as-is. This pack records
  D2; Carson's confirmation resolves the two records in D2's favour. Until
  countersigned, treat the version-byte question as OPEN and blocked-on-Carson
  per §0.

**Status: ⬜ AWAITING CARSON CONFIRMATION**

### (c) Authoritative block-header + inclusion-proof source = GetBlock RPC

**Decision:** the verifier trusts GetBlock RPC (`getblockheader <hash> false`
+ `gettxoutproof [txids] <blockhash>`) as the authoritative source for the
80-byte header and the Merkle inclusion branch. mempool.space remains a
documented header-only fallback; it can never produce the inclusion proof
(§1.2) and a mempool-only deployment reports `pending` rather than fabricating
a branch (§1.5 evidence honesty).

**Rationale:** same-node consistency with broadcast; empirically verified on
the prod token vs mainnet blocks 954869/955029 (S1 curl-matrix); the
`gettxoutproof` blob is independently re-checkable (the branch recomputes to
the header's `merkleroot` — `confirmation-proof.ts` recomputation, and the
blockhash-pinned call fails loudly on reorg, `utxo-provider.ts:663-674`).

**Status: ⬜ AWAITING CARSON CONFIRMATION**

### (d) Fee posture = OP_RETURN-only at launch

**Decision:** at launch, the anchor write path spends treasury funds ONLY on
standard OP_RETURN anchor transactions (inputs + OP_RETURN output + change) —
no inscriptions, no bare-multisig data embedding, no non-anchor on-chain
products. Fee strategy stays live-estimated (`BITCOIN_FEE_STRATEGY=mempool`)
with the existing static/fallback/max-rate guards
(`config.ts:59-67`; PERF-7 `bitcoinMaxFeeRate` queues anchors instead of
overpaying).

**Rationale:** OP_RETURN is the provably-unspendable, UTXO-set-friendly
commitment mechanism (`signet.ts` builders are the only tx-construction path);
batch anchoring (~10k fingerprints per Merkle root per tx at the nightly
drain) keeps per-document cost negligible under the subscription + credit
model. No code change required — this decision pins the status quo.

**Status: ⬜ AWAITING CARSON CONFIRMATION**

---

## 3. R-5 config-drift / parity-gate analysis (Task 2)

### 3.1 How chain expected values are encoded today

The gate is `scripts/ci/check-config-drift.ts` (CI job per CLAUDE.md §1.13),
plus two source-parsing sub-checks under `scripts/ci/config-drift/`:

| Chain value | Encoded in the gate? | Where |
|---|---|---|
| **Broadcast/UTXO provider** | **YES — already asserts `getblock`** | `ConfigState.bitcoinUtxoProvider` (`check-config-drift.ts:40-41`); diffed at `check-config-drift.ts:101-110`; asserted value `"getblock"` in `scripts/ci/config-drift/expected-prod-config.json` (top-level AND `runtimes.worker`); reference snapshot `prod-config-snapshot.json` matches. Additionally `providerSpof.ts` parses the REAL `config.ts` default + `deploy-worker.yml` override: dropped env line → ERROR `deploy-omits-override`; wrong value → ERROR `deploy-mismatch`; today's state (deploy correct, code default `'mempool'` ≠ asserted) → WARN `code-default-divergence` (`providerSpof.ts:51-89`). |
| **Fee strategy** | YES — asserts `mempool` | `expected-prod-config.json` `bitcoinFeeStrategy: "mempool"`; diffed at `check-config-drift.ts:112-124`. |
| **OP_RETURN marker (`ARKV`)** | **NO** | Not a `ConfigState` dimension. Only encoded in `signet.ts:43` + its tests. |
| **Confirmation-proof source** | **NO (implicitly follows provider)** | Not a separate dimension; the proof provider is derived from `bitcoinUtxoProvider` (`confirmation-proof-backfill.ts:56-65`), so the `getblock` assertion transitively covers it. |

### 3.2 Premise correction — nothing needs flipping to `getblock` "later"

The task premise "prod is on mempool today; expected values change to getblock
when the flip lands" is **stale**. Verified: `deploy-worker.yml:263` sets
`getblock` (since `fe2acad9`, 2026-06-05, on `main`) and both gate JSONs
assert `getblock`. **Do not edit any expected value in this PR — and note the
actual hazard is the reverse of the premise:** setting any expected value to
`mempool` would make the fail-closed gate red for everyone.

### 3.3 Ready-to-apply spec — what changes when the S3-P0 producer wave lands

Apply IN the S3-P0 chain PR (chain-touching → that PR is T3), not before, not
in this PR:

1. **`services/worker/src/config.ts:55`** — change
   `.default('mempool')` → `.default('getblock')` for `bitcoinUtxoProvider`.
   Effect: a dropped `BITCOIN_UTXO_PROVIDER` env line fails SAFE (getblock)
   instead of silently reverting broadcast to public mempool.space.
   - Gate effect: `providerSpof` WARN `code-default-divergence` disappears
     (code default == asserted); no JSON edits required; no gate-code edits
     required. `providerSpof.test.ts` fixtures that pin `'mempool'` as the
     parsed code-default will need their expectation flipped.
   - Caveat: `'getblock'` requires `BITCOIN_RPC_URL`
     (`createUtxoProvider`, `utxo-provider.ts:706-707` throws without it), so
     local-dev/test environments that relied on the mempool default must
     either set `BITCOIN_UTXO_PROVIDER=mempool` explicitly or provide an RPC
     URL. Sweep `.env.example` / test setup in the same PR.
2. **No change** to `expected-prod-config.json` / `prod-config-snapshot.json`
   provider or fee-strategy values — they already assert the target posture.
3. **Optional hardening (spec only, decide at S3-P0 review):** add two new
   asserted dimensions so the gate also pins the marker + proof source:
   - `opReturnMarker: "ARKV"` — new `ConfigState` field; a `marker` dimension
     in `diffConfigState`; a source-parse of `signet.ts`
     (`/OP_RETURN_PREFIX = Buffer\.from\('([^']+)'\)/`) in the spirit of
     `providerSpof.ts`, failing closed if the parse misses.
   - `confirmationProofSource: "getblock-rpc"` — asserted-manifest-only field
     documenting that the proof source follows `bitcoinUtxoProvider`; a check
     that `confirmation-proof-backfill.ts` still derives its provider from
     `config.bitcoinUtxoProvider` (guards against a future hardcoded split).
   Both are additive (`SnapshotFileSchema` is `.passthrough()`, so adding JSON
   keys without code is inert today — the code + JSON must land together for
   the assertions to bite).

### 3.4 Why this PR ships no gate code

Deliverable (ii) permitted code changes only if they assert CURRENT reality
with zero doubt. The provider + fee-strategy reality is already asserted
(§3.1); the marker/proof-source assertions require new `ConfigState`
dimensions + schema + differ + parser code, which is meaningful gate surface —
that belongs with the S3-P0 wave under its T3 evidence, not smuggled into a
docs PR. Doc-only was chosen deliberately (fail-safe per the task's own
"if any doubt, doc-only" rule).

---

## 4. Open questions for Carson

1. **Countersign (a)–(d)** — §2. Item (b) reverses the 2026-06-19 `0x01`
   direction; explicit written confirmation requested precisely because the
   two records conflict.
2. **`config.ts` default flip** (§3.3 item 1) — confirm it rides the S3-P0
   producer PR (T3) rather than a standalone change.
3. **Optional gate hardening** (§3.3 item 3) — want the `ARKV` marker +
   proof-source pinned in the R-5 gate at S3-P0, or is the provider assertion
   sufficient?
4. **Live-runtime re-verify** — §1.3 caveat: deploy-config asserts `getblock`
   but this session did not query the running Cloud Run env; the S3-P0 wave
   should capture the worker startup `utxoProvider` log line (or /health) as
   evidence before first producer broadcast.

---

_Prepared 2026-07-06 by Lane 1 (S3-C1 / DISC-03) against `origin/main`
`f927494e`. All file:line citations read from source this session; prod
runtime intentionally not queried (task scope). This file is an internal
engineering record — the auditable decision record lands on Confluence when
Carson countersigns._
