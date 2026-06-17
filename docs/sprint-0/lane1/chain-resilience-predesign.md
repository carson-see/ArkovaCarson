# Lane 1 — Chain Resilience Pre-Design (kill the mempool.space SPOF)

> **Sprint-0 Lane-1 deliverable (pre-design so Sprint 1 codes, not scopes).** Feeds roadmap **Q1.7 CHAIN-RESIL** (propose epic, L1, **T3**) and the S1→S2→S3 critical path. Status: DRAFT.
> Grounded in the code as of origin/main `45167170`: `services/worker/src/chain/utxo-provider.ts`, `fee-estimator.ts`.

## 1. The SPOF, precisely (code-verified — not inferred)

Broadcast is sovereign (GetBlock RPC `sendrawtransaction`), but the **read paths that gate treasury liveness still hard-depend on mempool.space**:

| Read path | Current prod behavior (`BITCOIN_UTXO_PROVIDER=getblock`) | Code |
|---|---|---|
| **UTXO listing** | `GetBlockHybridProvider.listUnspent` tries RPC `listunspent` → GetBlock's shared endpoint returns "Method not allowed" (SCRUM-1262, forensic 1/8) → **always falls back to mempool.space**. `emitRpcFallback` counts it (R0-8 / SCRUM-1254). | `utxo-provider.ts:460-493` |
| **Fee estimation** | `BITCOIN_FEE_STRATEGY=mempool` → rates from mempool.space `/v1/fees/recommended`. | `fee-estimator.ts:67,161` |
| **Frontend balance reads** | Direct mempool.space (per `project_bitcoin_signing_paths`). | (frontend) |

**Impact:** if mempool.space is down / rate-limits / returns wrong data, the treasury cannot select UTXOs or price a transaction — anchoring stalls **even though broadcast is fine**. Single hidden dependency = the R-3/R-5 class of silent failure.

## 2. Goal (Q1.7)

No single public read API is a hard dependency for treasury liveness. Reads become **multi-provider, health-checked, cross-validated**; broadcast stays sovereign + fail-CLOSED.

## 3. Design — `ResilientReadProvider`

Wrap an **ordered provider list** behind the existing `UtxoProvider` interface (5 methods: `listUnspent`, `broadcastTx`, `getBlockchainInfo`, `getRawTransaction`, `getBlockHeader`) plus the fee source. Reuse the existing `retryWithBackoff` / `isRetryableError` / `emitRpcFallback` primitives — don't reinvent them.

- **Providers (config-ordered):** ① GetBlock RPC (broadcast + headers, sovereign) · ② a UTXO-indexed source that actually supports address listing — Blockstream **Esplora** (`/address/:a/utxo`) and/or a second commercial RPC with `scantxoutset`/electrs · ③ mempool.space **demoted to one-of-N**, not the only · ④ optional self-hosted Bitcoin Core + electrs (full sovereignty).
- **Per-method strategy:**
  - `listUnspent`: primary indexed source → Esplora → mempool; **cross-check** the value-sum across ≥2 sources before spending; treat a lone-source result as `degraded`.
  - **fee**: take the **median of N sources** bounded by a **static floor + ceiling** (reject absurd lowball/highball — a bad fee = stuck or overpaid anchor). Never anchor on a single unsanitized rate.
  - `getRawTransaction` / `getBlockHeader`: RPC → Esplora (needed for the inclusion proofs the OSS verifier consumes).
  - **balance**: frontend reads go through a **worker proxy** (multi-source), not direct mempool.space.
- **Broadcast**: unchanged — GetBlock RPC, fail-CLOSED, `isDuplicateTxError` idempotency.

## 4. Health, telemetry & the drift/parity tie-in

- Promote the `emitRpcFallback` counter into a **per-provider gauge** (success / latency / fallback-rate) feeding the **VIS-01 dashboard** and `db-health-monitor` (SCRUM-1254).
- **Alarm** if any read path is **100% on a single public source** (today's silent state) — that's the signal the **S0-5.2 drift/parity gate** asserts (provider drift). Bidirectional handoff with the visibility signal inventory.

## 5. Failure semantics

- Reads: **graceful degrade** with an explicit `degraded` health state surfaced to ops — never a silent single-source dependency.
- Broadcast + fee: **fail-CLOSED** — refuse to build/sign/broadcast on an unsanitized fee or an un-cross-checked UTXO set rather than risk a stuck or overpaying anchor (money-safety, R-9).

## 6. Config / security

- Provider list + order via env (`BITCOIN_READ_PROVIDERS=esplora,getblock,mempool`), per-provider creds in **Secret Manager** (Lane-1 IAM hardening surface), plus a per-provider kill-switch flag (registered in `flagRegistry` so the drift gate sees it).

## 7. Anchor-lifecycle / TLA+

CHAIN-RESIL touches anchor selection + fee → **re-verify `machines/bitcoinAnchor.machine.ts`** (edit machine first, run `check`). Sequences into S3 **reorg → proof-invalidation + TLA+ invariant** (a reorg must invalidate a not-yet-deeply-confirmed proof; OP_RETURN version-byte monitor in S5).

## 8. Test plan (T3 — chain, isolated rig)

Provider-mock matrix (each provider up/down/slow/wrong) · failover unit tests · fee-sanity bounds tests · UTXO cross-check mismatch test · a **fault-injection soak** (kill each provider in turn, confirm liveness + correct degraded-state + no double-spend). Mock all real chain APIs (§1.7).

## 9. Sprint boundary (so S1 codes, not scopes)

- **S1:** this design ratified + multi-provider **scaffolding** (interfaces, provider registry, health gauge) + the MIT-verifier scaffold (separate doc).
- **S2:** multi-provider impl + isolated **T3 soak**; MIT verifier CLI v0.1.
- **S3:** reorg → proof-invalidation + TLA+ invariant; TS SDK proof-helper GA.
