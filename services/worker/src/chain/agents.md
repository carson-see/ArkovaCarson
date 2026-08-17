# agents.md — services/worker/src/chain/

_Last updated: 2026-08-17_

## What This Folder Contains

Bitcoin chain client implementation for anchoring document fingerprints on-chain via OP_RETURN transactions.

## 2026-08-17 FD-CHAIN-1 round 2 — `listUnspent` is a UNION; no single leg is authoritative

Round 1 (below) fixed the EMPTY-result case by turning `>= 0` into `> 0` so an empty RPC
success fell through to mempool.space. Review caught that fall-through fixes only the empty
case, not the **PARTIAL** one: the RPC leg runs `listunspent` at **minconf=1**, so bitcoind
excludes unconfirmed outputs. After a batch broadcasts, the treasury's normal shape is one
confirmed UTXO + that batch's **unconfirmed change** — the RPC answers length 1 (`> 0`),
short-circuits, and the change is silently dropped. The provider under-reports spendable
funds under sustained batching, exactly when it matters. Observed live 2026-08-17T03:10Z
mid-flush: the worker logged `Treasury has no UTXOs` while the treasury held the
just-broadcast batch's unconfirmed change
(`docs/staging/fullsoak-2026-08/trigger-d-flush-2026-08-17.md`). The mempool leg
deliberately includes unconfirmed UTXOs ("prevents the treasury from getting stuck waiting
for confirmations between batches") — a fall-through design only reaches that property when
the RPC leg is empty.

`GetBlockHybridProvider.listUnspent` is now a **union**: both legs are queried concurrently
(`Promise.allSettled` — independent I/O, and the union needs both answers regardless, so
sequencing would only add latency), merged deduped by `(txid, vout)`, **RPC entry preferred
on collision** (sovereign source; may carry `rawTxHex` in future shapes). Degradation:

| RPC leg | mempool leg | Result |
|---|---|---|
| ok (any) | ok (any) | union, deduped, RPC-preferred |
| **fails** | ok | mempool-only + unchanged R0-8 `emitRpcFallback` (SCRUM-1262 / SCRUM-1254 fallback-rate view keeps its meaning) |
| ok, non-empty | **fails** | RPC-only + structured `logger.warn` (`leg: 'mempool.space'`). **NOT `emitRpcFallback`** — its locked shape counts RPC→mempool fallbacks; folding mempool-leg failures in would corrupt the fallback-rate metric |
| ok, **empty** | **fails** | **throw** the mempool error. Round 1's lesson: an empty wallet-RPC success is the ABSENCE of an answer — with the address-indexed leg down there is no reliable answer, and "no source answered" must never be promoted to "treasury empty" |
| **fails** | **fails** | throw the mempool error (same shape as before the union) |

The mempool-leg-fails row is also what defuses the interaction with PR #2216 (body-read
timeouts in this same file): a `BodyReadTimeoutError` from the mempool leg arrives as an
ordinary leg failure and degrades to RPC-only, instead of a pure-fallback design returning
empty/throwing — which would have reintroduced the FD-CHAIN-1 symptom through a different
door.

Round 1's anti-decay test ("a non-empty RPC result must NOT reach the fallback", exactly one
outbound call) was the partial-result bug **wearing a test's clothes** — it forbade the
union. Deliberately replaced: the `FD-CHAIN-1` describe block now pins both-legs-always-
queried, the minconf=1 partial case, dedupe-prefers-RPC (divergent values resolve to the
RPC's), the degrade row, and both throw rows. Rule: **when a "guard" test pins a
short-circuit, ask what the short-circuit is hiding.**

## 2026-08-16 FD-CHAIN-1 — an EMPTY RPC result is not an answer (`>= 0` → `> 0`; superseded by the union above)

`GetBlockHybridProvider.listUnspent` guarded its RPC result with
`rpcUtxos.length >= 0`, which is true for **every** array. `listunspent` is a Bitcoin Core
**wallet** RPC: it returns only UTXOs of a wallet the node has loaded, so a WIF-derived
treasury address absent from that wallet produces a **successful** call returning `[]`. No
throw ⇒ the `catch` never ran ⇒ the mempool.space fallback on the last line was
**unreachable**, and `[]` was returned as though it were the truth about the treasury.

Found on the fullsoak-2026-08 rig (Day 4): anchoring was **completely halted** for hours
while the treasury held **742,637 sat**, and every signal stayed green — `POST
/jobs/batch-anchors` 200, Cloud Scheduler success, SOC2 health check 13/13. The same worker
logged `Treasury cache refreshed balance: 742637` seconds after logging `Treasury has no
UTXOs`. Full writeup:
`docs/staging/fullsoak-2026-08/FD-CHAIN-1-listunspent-silent-empty.md`.

**Why every existing test missed it.** The fallback was designed for the *opposite* failure
— GetBlock's shared endpoint rejecting the wallet RPC (SCRUM-1262 / R1-8, and the HTTP 405
shape pinned by BUG-2026-08-01-F10). Every fallback test in `utxo-provider.test.ts` drives
the path through an **exception**. "RPC returns 200 with an empty array" was not in the
design's vocabulary, so no test expressed it. A fallback that only fires on a throw is not a
fallback from *no data*; it is a fallback from *a broken transport*.

**Prod was safe only by accident, and the accident is scheduled to end.** Prod's GetBlock
RPC errors on `listunspent` every cycle (100% fallback rate, F-10), so the exception path
fires and prod gets real UTXOs. The defect is fully latent there — and activates the moment
prod moves to a self-hosted node, which is the stated sovereignty goal and precisely the
architecture the rig ran.

Rules this leaves behind:

- **Never treat an empty provider result as an authoritative answer** in a multi-source
  provider. Distinguish "the source said none" from "the source said nothing useful" —
  fall through to the next source and let the last one own the empty verdict.
- **A length check on a result you intend to guard is `> 0`.** `>= 0` and `!= null` are
  guards that cannot fail; if a condition cannot be false, it is documentation, not a check.
- **Test the success-shaped failure, not just the throw.** Any provider with a fallback needs
  a case where the primary *succeeds uselessly*. The `FD-CHAIN-1` describe block in
  `utxo-provider.test.ts` pins that. (Round 1 also pinned the inverse — "a non-empty RPC
  result must NOT reach the fallback" — which round 2 above identified as the partial-result
  bug itself and replaced with the union pins.)

Companion, same finding: `signet.ts::hasFunds()` observed "the provider returned no rows"
and reported "the treasury is unfunded" (`'Treasury has no UTXOs — batch processing will be
skipped until funded'`). That is a stronger claim than the observation supports and it sent
a live diagnosis at the wallet instead of the provider. The message now states what is
measured (Constitution §1.5) and logs `provider` so the answering source is named. Pinned by
the `BitcoinChainClient.hasFunds` block in `signet.test.ts`. **Not fixed here:** the
`jobs/batch-anchor.ts` companion log (`'Treasury empty — skipping batch anchor processing
until funded'`) makes the same unsupported claim one layer up — different folder, separate
change.

**Still open (NOT closed by this fix):** FD-CHAIN-2 — the fallback-rate alert described in
the `listUnspent` RPC-leg-failure comment ("alert if it stays at 100%") is absent or unwired; prod
sits at 100% fallback right now and nothing fires. Also unclosed: `batch-anchors` returns a
bare 200 when it skips the whole batch, and the health check passed 13/13 through a total
anchoring outage, so it is not measuring anchoring.

## 2026-08-11 SCRUM-3128 — `estimateFee()` is lossy; gates must use `estimateFeeDetailed()`

`MempoolFeeEstimator.estimateFee()` catches every API failure and returns
`DEFAULT_FALLBACK_RATE = 5` instead of throwing. The number is indistinguishable at the call site
from a real reading of 5 sat/vB, so **every consumer that treats a low rate as permission to spend
gets that permission for free the moment mempool.space is unreachable.** That is not hypothetical:
mempool.space rate-limits Cloud Run (SCRUM-547 — the reason treasury balance is cached).

`FeeEstimator` now requires a second method:

```ts
estimateFeeDetailed(): Promise<{ rate: number; source: 'live' | 'fallback'; reason?: ... }>
```

- `source: 'live'` — the estimator KNOWS the rate. A real API reading, **or** a `StaticFeeEstimator`
  rate: signet's flat 1 sat/vB is the configured truth for that network, not a degraded substitute.
  Reporting static rates as `fallback` would make every fail-closed gate defer signet forever.
- `source: 'fallback'` — the rate is UNKNOWN and a default was substituted. `reason` is one of
  `http_error | invalid_rate | timeout | network_error`.

`estimateFee()` is retained as a thin wrapper over the detailed form and is still correct for
advisory uses (logging, display, pricing hints). **It is wrong for any gate whose degraded mode must
not be "allow."**

**Required, not optional, on purpose.** An optional method is one a call site can silently forget,
and forgetting reinstates the exact fail-open this fixes. Making it required means every current and
future estimator has to answer the question, and the compiler finds the ones that don't — it
immediately caught the stub estimator in `signet.test.ts`.

**Sibling call sites still on the lossy form — same defect class, NOT fixed here (SCRUM-3128
follow-up).** Fixed in this pass: `jobs/anchor.ts` only.

| Site | Degraded behaviour | Assessment |
|---|---|---|
| `signet.ts:~739` (PERF-7 ceiling, `submitFingerprint`) | fallback 5 clears the ceiling → builds + broadcasts | **Same treasury-spend fail-open.** Narrowed but not closed by the `anchor.ts` fix: `anchor.ts` now defers on unknown, but `signet.ts` re-estimates independently, and batch paths reach it without passing through `anchor.ts` at all. |
| `jobs/feeAwareScheduler.ts:~82`, `~180` | fallback 5 → `shouldSubmit: true, reason: 'below_threshold'` | Same mechanism, but the `catch` there is a **documented policy** ("submit anyway, don't block anchoring") with a `FEE_HARD_DEADLINE_MS` escape. Flipping it is a batch-scheduling product decision, not a bug fix — needs its own tier + soak. The reported `reason` is a lie either way: it claims the fee was measured below threshold when it was substituted. |
| `middleware/x402PaymentGate.ts:~78` | fallback 5 underprices the anchor endpoint | Revenue leak, not treasury drain. Lower severity, different remedy. |

## 2026-08-11 BUG-2026-08-11 — `createFeeEstimator` was network-blind (fixed)

`fee-estimator.ts` defined its own `DEFAULT_MEMPOOL_URL = 'https://mempool.space/api'` (mainnet) and
`FeeEstimatorFactoryConfig` accepted **no `network` field at all**. Every non-mainnet deployment
running `strategy: 'mempool'` therefore read **mainnet** fee rates from
`/v1/fees/recommended` — that endpoint is network-scoped (signet reports a flat 1 sat/vB; mainnet
reports real congestion).

Worst affected was the INEFF-5 `FORCE_DYNAMIC_FEE_ESTIMATION` path in `client.ts`, whose stated
purpose is to "use mempool.space fee estimator even on signet/testnet to validate the full fee path
pre-mainnet". Because the default was mainnet, that rehearsal was validating against the wrong
chain — the one thing it existed to avoid.

Fixed by adding `network?: string` to the factory and resolving through the shared
`mempoolApiBaseForNetwork()` (see `../utils/agents.md`). All four call sites now pass
`config.bitcoinNetwork`: `api/treasury.ts`, `index.ts`, and **both** `client.ts` sites — including
the mainnet branch, where the default was already correct but an implicit network is exactly the
shape of the defect.

### The fix had to land on the CLASS, not just the factory (caught in review)

The first pass fixed `createFeeEstimator` only. That was **not enough** — four call sites construct
`MempoolFeeEstimator` directly and never touch the factory:

| Site | Consequence of the mainnet default | Live? |
|---|---|---|
| `jobs/anchor.ts` — ECON-1 fee ceiling | Mainnet congestion > ceiling ⇒ `revertToPending()`, anchors stall on a chain whose real rate is 1 sat/vB | **yes** |
| `middleware/x402PaymentGate.ts` — anchor pricing | Bills callers for mainnet fees the network in use never charges | **yes** (6+ routes) |
| `jobs/feeAwareScheduler.ts` ×2 — submit/defer gate | Withholds every batch until `deadline_exceeded` | latent — module has no non-test caller yet |

So `MempoolFeeEstimatorConfig` now takes `network` too, and the constructor defaults through
`mempoolApiBaseForNetwork()`. There is no module-level default base in this file any more.

**Why the ratchet did not catch it:** the parity ratchet drove `createFeeEstimator` only, so it
stayed green while four constructor sites were still mainnet-pinned — a ratchet giving false
assurance is worse than no ratchet. `mempool-url.test.ts` now ratchets the **class** default too.
Any new consumer of a mempool.space URL needs a ratchet case, not just a code review.

`feeAwareScheduler.ts` takes `network` as an injected parameter rather than importing `config` —
that module deliberately avoids the config import chain (it duplicates the `FeeEstimator` interface
for the same reason). Don't "simplify" that into a config import.

Rules:
- **Never introduce a base-URL literal in this folder.** `MEMPOOL_URLS` here is now an alias of the
  shared `MEMPOOL_API_BASES` (frozen at the source); a private copy is the root cause of this bug class.
- **Fix the class, not just the factory.** A factory-level default cannot protect direct `new`
  construction, and this codebase does plenty of it via lazy `await import()`.
- The alias is deliberately *not* `mempoolApiBaseForNetwork()` at every use in `utxo-provider.ts`:
  that helper defaults to **mainnet** for an unset network, but two of the three sites there default
  to **testnet4**. Shared values, per-site defaults — silently flipping an unset-network deployment
  onto mainnet would re-create the bug in a new place.
- Severity note, honestly: wrong fee rates on a network whose fees are meaningless is a low-impact
  defect. The value of this fix is restoring the pre-mainnet validation path and removing the last
  duplicated copy of the base map.

## 2026-08-03 BUG-2026-07-26-003 / SCRUM-3016 (PR #1965) — MEMPOOL_API_URL `/api` contract, fixed

`config.mempoolApiUrl` (raw `MEMPOOL_API_URL` env var) was read by five call sites split across two
mutually-incompatible conventions, verified directly against current code (not assumed from the bug
report): `utxo-provider.ts` (`createUtxoProvider`'s `getblock`/`mempool` branches, both call sites) and
`fee-estimator.ts` (`createFeeEstimator`'s `mempool` branch) build requests as `${baseUrl}/address/...`,
`${baseUrl}/v1/fees/...` — never appending `/api` themselves, so `baseUrl` must already carry it (their
own defaults/`MEMPOOL_URLS` all end in `/api`). `jobs/chain-maintenance.ts` and
`jobs/check-confirmations.ts` build `${baseUrl}/api/tx/...` — they append `/api` themselves, so `baseUrl`
must NOT carry it (their own defaults are bare hosts). **No single value of `MEMPOOL_API_URL` satisfied
both conventions** — this is exactly what froze 2 isolated soak rigs for ~24h (BUG-2026-07-26-003), and
prod has only ever been safe because the var happens to be unset there, leaving every consumer on its own
mutually-consistent hardcoded default.

Fix: new `utils/mempool-url.ts` — `normalizeMempoolHostUrl` (strips a trailing `/api` and trailing slash
down to a bare host, `undefined` for unset) plus two named resolvers, `resolveMempoolApiBase` (for the
"caller appends nothing" convention: `utxo-provider.ts`, `fee-estimator.ts`, `jobs/treasury-cache.ts`) and
`resolveMempoolHostBase` (for the "caller appends `/api/...` itself" convention:
`jobs/chain-maintenance.ts`, `jobs/check-confirmations.ts`). Every one of the five call sites now routes
through one of the two instead of reading `config.mempoolApiUrl` directly, so an operator-set value in
EITHER shape produces the correct URL for that consumer either way — the class is closed at the API level
(unwritable-wrong), not just tested at each site. `MEMPOOL_URLS`/`DEFAULT_MEMPOOL_URL`/per-network
fallback constants are UNCHANGED; only what happens to an operator-SET value changed. The unset (default)
path is byte-identical to before on all five sites — verified via the full pre-existing regression suites
(fee-estimator.test.ts, utxo-provider.test.ts, chain-maintenance.test.ts, check-confirmations.test.ts,
treasury-cache.test.ts, client.test.ts — 328 tests, all green).

Tests: `utils/mempool-url.test.ts` (19 cases — the pure contract logic, including "produces the SAME
result regardless of which convention the operator used", the actual incident, for both resolvers)
plus two new integration cases in `chain/utxo-provider.test.ts`'s `createUtxoProvider` describe block that
assert the REAL outbound `fetch` URL (not just the helper) is identical whether `MEMPOOL_API_URL` is set
with or without the trailing `/api`. `x402PaymentGate.ts` / `feeAwareScheduler.ts` / `jobs/anchor.ts`
construct `MempoolFeeEstimator` directly WITHOUT ever passing `mempoolApiUrl` at all (always the hardcoded
default) — those never participated in this contract bug and were deliberately left untouched; a
follow-up to make them honor `MEMPOOL_API_URL` too is a separate, unfiled gap.

## 2026-08-01 BUG-2026-08-01-F10 — GetBlock 405 on `listunspent` root-caused: provider-tier config, not a code bug (CLOSED, no code fix required)

CTO observed 100% of prod `GetBlockHybridProvider.listUnspent` calls logging `RPC fallback to mempool.space — reason: "RPC listunspent failed: HTTP 405"` (`gcloud logging read`, service `arkova-worker`, us-central1). Root-caused: `listunspent` is a Bitcoin Core **wallet** RPC method; GetBlock's **shared/pooled** endpoint (the tier `BITCOIN_RPC_URL` — Secret Manager `bitcoin-rpc-url` — points at) serves many customers off one node with no per-customer wallet loaded, so its API gateway rejects the method at the transport layer with a bare HTTP 405 and no JSON-RPC `{error}` envelope — distinct from how Bitcoin Core itself answers a wallet-RPC call with no wallet loaded (a JSON-RPC error, typically HTTP-500-wrapped per the `#1408-Finding-1` handling in `rpcCall`). This is **config/provider-plan, not code**: no wrong URL, verb, or method name — the same `rpcUrl` broadcasts (`sendrawtransaction`, a non-wallet method) successfully. Not a new finding: first root-caused 2026-04-26 (SCRUM-1262 / R1-8, "forensic 1/8") and already mitigated — `GetBlockHybridProvider.listUnspent`'s untyped `catch` already falls back to `mempool.space` (read-only, safe) on ANY RPC failure and reports it via `emitRpcFallback` (R0-8 dashboard). Confirmed this session that the fallback correctly handles the REAL prod failure shape (bare HTTP 405) — the pre-existing regression test only simulated a JSON-RPC-envelope rejection (`rpcErr(...)`, HTTP 200 + `{error}` body), a shape GetBlock has never actually produced for this endpoint. Added `utxo-provider.test.ts` case pinning the true shape (transport-level 405, no envelope) plus the exact JSON-RPC request (`POST`, `{jsonrpc:'2.0', method:'listunspent', params:[1,9999999,[address]]}`) and the exact `reason` string the fallback-rate dashboard keys off — it passes unmodified (no behavior change needed). **What would actually fix sovereignty for this path** (not done — out of scope for a same-session hotfix, needs its own story): (a) upgrade to a GetBlock dedicated-node plan with the treasury address imported as a watch-only wallet so `listunspent` is served, or (b) implement the already-scoped multi-source UTXO provider in `docs/sprint-0/lane1/chain-resilience-predesign.md` (Esplora ranked ahead of `mempool.space`, cross-checked value-sum, `mempool.space` demoted to one-of-N). Full writeup + bug row: `docs/staging/SOAK-FINDINGS-2026-08.md` F-10.

## 2026-08-01 F-4 broadcast-fallback — assessed, NOT implemented this session (see F-10 PR)

Reassessed whether `GetBlockHybridProvider.broadcastTx` should gain a `mempool.space` fallback (see the F-4 entry directly below). Conclusion: the existing prepare/persist-then-broadcast architecture (S3-P0) already defers safely on a non-definitive `broadcastTx` failure (`isBroadcastRejectedError` gate in `batch-anchor.ts` — row stays `BROADCASTING`, `reconcileBroadcastIntents` rebroadcasts the SAME persisted signed hex next tick; RFC6979-deterministic signing keeps the txid fixed regardless of which provider eventually relays it). So the real downside of the status quo is **liveness** (a prolonged GetBlock outage stalls affected anchors until GetBlock recovers or an operator flips `BITCOIN_UTXO_PROVIDER`), not double-spend or false-`SECURED` risk. A designed fallback (skip if GetBlock's error is already a definitive `isBroadcastRejectedError`; otherwise delegate the identical signed hex to the already-tested `MempoolUtxoProvider.broadcastTx`; propagate mempool's classification, not GetBlock's, on a double failure; wire `emitRpcFallback` the same as `listUnspent`) looks sound on paper but is genuinely untested for cross-provider mempool-policy divergence on marginal-fee edge cases, and this is T3 chain/treasury code requiring a 48h multi-trigger soak this session cannot produce (no live-BTC-broadcast, no touching the two live 2026-08 soak rigs). Written up as a follow-up rather than implemented — see the F-10 PR description for the full design.

## 2026-07-28 SOAK FINDING F-4 — GetBlockHybridProvider.broadcastTx has no mempool fallback (open, disclosed exception)

Only `listUnspent` has a mempool fallback on `GetBlockHybridProvider`; `broadcastTx` does not. A GetBlock outage during broadcast produces a computed-but-never-broadcast txid — a silent no-broadcast failure that actually occurred during provisioning of the 2026-08 72h signet soak pair. Separately: no valid signet GetBlock credential exists in Secret Manager, so neither soak rig exercises this path (both broadcast via `MempoolUtxoProvider` instead) — prod's sovereign GetBlock broadcast path is unexercised by these soaks and needs separate verification before launch. Canonical writeup: `docs/staging/SOAK-FINDINGS-2026-08.md`.

## 2026-07-15 — SCRUM-2692 pre-broadcast durable-write barrier

`SubmitFingerprintRequest.preBroadcastHook` is an optional barrier invoked with the immutable `PreparedChainTx` after signing and before `broadcastSignedTx`. Both Bitcoin single-input and fragmented multi-input construction paths share this boundary; a rejected hook makes zero provider broadcast calls. `MockChainClient` mirrors the same prepare → hook → broadcast composition. Signer selection is unchanged: active signet WIF behavior is reused and the production mainnet KMS path is untouched.

## 2026-07-07 — Lane 1 s3.25: frozen fingerprint→on-chain mapping regression pin (SCRUM-2486 AC-3)

`fingerprint-mapping-regression.test.ts` PINS the fingerprint → OP_RETURN payload → verify-extract round-trip with HARD-CODED expected bytes (a frozen fixture computed out-of-band, NOT recomputed from the code under test) so any future refactor that changes the mapping fails loudly. This mapping is a FROZEN WIRE CONTRACT — ~2.97M anchors are already committed under it. The test IMPORTS the real exported pure functions from `signet.ts` (`canonicalMetadataJson`, `hashMetadata`, `truncateMetadataHash`, `extractAnchorFingerprint`) — it does NOT modify the soak-locked `signet.ts`. Pinned: the `ARKV` prefix + byte layout (36B no-meta / 44B with-8B-meta), the compiled OP_RETURN scriptPubKey hex, the canonical-JSON key-sort, the sha256 metadata hash + its 8-byte truncation, and the extract round-trip (including that a trailing metadata hash doesn't disturb fingerprint extraction). A DRIFT-GUARD case confirms a changed prefix would NOT match the pin. Fixture provenance: `fingerprint = sha256("arkova-scrum-2486-frozen-fixture-v1")`. If the wire format is ever INTENTIONALLY versioned, recompute + bump the frozen constants with a migration/re-anchor plan — do NOT edit them to make a red test green. Apply/soak deferred to Sprint-4; pure unit test (T0/T1). Companion ACs AC-2/AC-4 live in `src/jobs/` (see that folder's agents.md).

| File | Purpose |
|------|---------|
| `types.ts` | `ChainClient` interface + `ChainIndexLookup` interface + `IndexEntry` + request/response types |
| `client.ts` | Async factory (`initChainClient()` / `getInitializedChainClient()`) — returns `MockChainClient` or `BitcoinChainClient` based on config. Includes `SupabaseChainIndexLookup` for O(1) fingerprint verification. |
| `mock.ts` | In-memory mock for tests and development |
| `signet.ts` | Real Bitcoin implementation — `BitcoinChainClient` (renamed from `SignetChainClient`, alias kept). Supports signet, testnet, mainnet via `SigningProvider` + `FeeEstimator` + `UtxoProvider` abstractions. |
| `signing-provider.ts` | Signing abstraction — `WifSigningProvider` (ECPair, signet/testnet), `KmsSigningProvider` (AWS KMS, code-level only, NOT in production), `GcpKmsSigningProvider` (**production mainnet**). See `gcp-kms-signing-provider.ts` + SCRUM-902. |
| `fee-estimator.ts` | Fee estimation — `StaticFeeEstimator` (fixed rate) + `MempoolFeeEstimator` (live API) |
| `utxo-provider.ts` | UTXO provider abstraction — `RpcUtxoProvider` (Bitcoin Core RPC) + `MempoolUtxoProvider` (Mempool.space REST) + factory |
| `wallet.ts` | Treasury wallet utilities — keypair generation, address derivation, WIF validation |
| `client.test.ts` | Factory tests (28 tests) — async factory, SupabaseChainIndexLookup, signet/mainnet/mock paths |
| `mock.test.ts` | Mock client tests (18 tests) |
| `signet.test.ts` | Bitcoin client tests (47 tests) — uses dynamically-built funding txs for PSBT validation |
| `utxo-provider.test.ts` | UTXO provider tests (34 tests) |
| `wallet.test.ts` | Wallet utility tests (13 tests) |
| `signet.integration.test.ts` | Integration tests (8 tests) — real TX construction + signing with bitcoinjs-lib, broadcast skipped in CI |

## Recent Changes

- **2026-07-06 S3-P0 #1417-HIGH — no-double-broadcast: typed reject gate + infallible broadcast + tri-state getReceipt (Lane 1 /debug):**
  - **`utxo-provider.ts`**: new typed **`BroadcastRejectedError`** (definitive mempool/relay refusal) + **`isBroadcastRejectedError(err)`** — the SINGLE unwind gate. TRUE only for `BroadcastRejectedError`, `RpcApplicationError` (the #1408 rpcCall fix surfaces `sendrawtransaction` JSON-RPC errors typed), or an explicit reject-text (`isBroadcastRejectText`, a conservative Bitcoin-Core reject-token set — over-broad tokens excluded so a transport/proxy message never over-unwinds). Every `HttpError` (401/402/404/5xx), timeout, and unknown error → FALSE → DEFER. `MempoolUtxoProvider.broadcastTx` now throws the typed reject on explicit relay-verdict text (bare non-OK stays `HttpError` → DEFER). `BroadcastRejectedError` is also non-retryable in `isRetryableError`.
  - **`signet.ts`**: (b) `broadcastSignedTx` is now **infallible after `broadcastTx` succeeds** — the post-broadcast `getBlockchainInfo` height read is wrapped in try/catch → falls back to height 0 (a live broadcast is never misread as failed). (c) `getReceipt` is now **TRI-STATE**: found / definitively-absent (RPC code `-5` or mempool HTTP 404 → `null`, via `isDefinitivelyAbsent`) / lookup-failed (outage/auth/quota → **THROW**). A provider outage no longer masquerades as "tx unknown" → rebroadcast → 4xx → unwind.
  - Consumer: `jobs/batch-anchor.ts` both unwind sites (Phase 3c + reconcile rebroadcast) swapped from `!isRetryableError` to `isBroadcastRejectedError`. NO machine transition changed — `bitcoinAnchor.machine.ts` already models "unwind only on a definitive reject"; the fix makes the implementation faithful. `tla-precheck check`: proofPassed, 11 invariants, 757 states / 196 distinct, no error.
  - Tests: `utxo-provider.test.ts` (+reject-text classifier / unwind-gate / typed Mempool reject), `signet.test.ts` (+infallible broadcast on 402/timeout, +getReceipt tri-state: -5/404 → null, 402/401/5xx/unknown → throw), `jobs/batch-anchor.intent.test.ts` (+402 after broadcast → no unwind, +401 during reconcile rebroadcast → DEFER, +genuine dust reject → unwind fires). Reconciled with a concurrent parallel fix (257352c2) — kept the typed gate + tri-state; dropped its batch-local substring helper.

- **2026-07-06 S3-P0 — prepare/broadcast split for persisted pre-broadcast intents (Lane 1, Sprint 3; stacked on S3-C2):**
  - **`types.ts`**: new `PreparedChainTx` ({txHex, txId, feeSats, opReturnData, metadataHash?}) + OPTIONAL `ChainClient.prepareFingerprintTx()` / `broadcastSignedTx()` (optional so existing ChainClient mocks don't break; clients without them get the legacy single-call path).
  - **`signet.ts`**: `submitFingerprint` refactored into `prepareFingerprintTx` (the EXACT pre-broadcast pipeline it always ran — metadata hash → fee estimate + PERF-7 ceiling → UTXO fetch → single/multi selection → PSBT build + sign — stopping before the network) + `broadcastSignedTx` (broadcast previously-signed bytes; computes the txid from the hex; empty provider txid → computed fallback, i.e. already-known == success). `submitFingerprint` is now EXACTLY prepare→broadcast composed — pinned by a test asserting broadcast bytes == prepared bytes. `PreparedChainTx.opReturnData` carries the verbatim committed payload (`"ARKV"(4)+root(32)[+metadataHash]`, NO version byte) for `anchor_proofs.op_return_payload` persistence. RFC6979 deterministic signing ⇒ same UTXO set → identical bytes/txid (pinned).
  - **`mock.ts`**: `MockChainClient` implements both (deterministic txid per fingerprint, idempotent re-broadcast of the same hex) so USE_MOCKS soak rigs exercise the intent pipeline with real-client semantics.
  - Consumer: `jobs/batch-anchor.ts` persists {txid + signed hex} durably BEFORE broadcasting and reconciles interrupted batches on the next tick (see jobs/agents.md). Lifecycle modeled first in `machines/bitcoinAnchor.machine.ts` (check green).

- **2026-07-06 S3-C2 review #1408-Finding-1 (/debug, same PR):** `rpcCall` in `utxo-provider.ts` now parses the response body FIRST on `!response.ok`. Bitcoin-Core-faithful endpoints wrap every RPC_* application error in HTTP 500; previously that surfaced as a bare retryable `HttpError`, so (a) a definitive reject (e.g. code -5 `Not all transactions found`) burned the full retry budget as if transient, and (b) a duplicate-broadcast verdict (code -27 `transaction already in block chain`) never reached `isDuplicateTxError` — the duplicate==success path silently failed on such endpoints. New exported **`RpcApplicationError`** (carries JSON-RPC `code` + `httpStatus` metadata) is thrown for ANY `{error}` envelope — HTTP-wrapped or in-envelope-on-200 — and `isRetryableError` classifies it definitively non-retryable. Non-JSON / no-envelope / unreadable 5xx bodies keep the fail-safe retryable `HttpError` (unchanged). This typed error is the substrate the S3-P0 producer's `BroadcastRejectedError` classifier stands on. Tests: `utxo-provider.test.ts` `S3-C2 #1408-Finding-1` block (+9: definitive -5 no-retry, classifier, HTTP-wrapped duplicate -27/-26 on both RPC providers, non-JSON/no-envelope/unreadable fail-safes, 4xx-wrapped, in-envelope-200 typed).

- **2026-07-06 S3-C2 — chain-resilience hardening (Lane 1, Sprint 3; lands BEFORE the batch-anchoring producer so it inherits hardened retry/backoff):**
  - **`retryWithBackoff` bounded termination (no-infinite-loop guarantee):** `maxRetries` is now sanitized — floored to an integer and clamped to `[0, HARD_MAX_RETRIES=8]`; `NaN` falls back to the default (3). Previously `maxRetries: Infinity` looped forever and `NaN`/negative values threw `undefined` without ever calling the fn. `baseDelayMs` is sanitized (non-finite / non-positive → default 1000ms) and each per-attempt delay is capped at `MAX_BACKOFF_DELAY_MS=30_000` PRE-jitter (jitter ∈ [50%,100%) only ever shortens it). Both constants are exported. EVERY retry path now provably reaches a terminal state (success or throw) in ≤ 1+8 attempts.
  - **HTTP 429 reclassified as transient** in `isRetryableError` (rate limit → bounded backoff-with-jitter retry). Other 4xx remain non-retryable. The QA-CHAOS-02 pin in `src/tests/chaos-mempool-unavail.test.ts` was updated to the new contract.
  - **Provider-failure semantics on confirmation-proof fetch (`confirmation-proof.ts`):** a TRANSIENT GetBlock read failure (network / 5xx / timeout / 429, i.e. `isRetryableError`-class, after the provider's own bounded retries are exhausted) on the header/inclusion-proof fetch now degrades to **`pending`** (retry next cron tick) instead of `stale` — a network blip is NOT evidence of a reorg, and no proof field is ever fabricated (no header-only or mempool-derived pseudo-proof; mempool.space still deliberately lacks `getTxOutProof`). Definitive RPC application errors (e.g. `gettxoutproof`: "Not all transactions found in specified or retrieved block") remain `stale` — the provider answered and the answer was negative, preserving the pinned-blockhash reorg signal that `jobs/confirmation-proof-populate.ts` documents. `getRawTransaction` failure was already `pending` (unchanged). Downstream consumer unchanged: both `pending` and `stale` leave `block_header IS NULL` so the row re-matches the next scan; the change corrects status/log/count semantics (no false "reorg/missing" warns on provider blips).
  - **Broadcast idempotency regressions:** "already-known == success" (`isDuplicateTxError` → `{ txid: '' }`, caller falls back to the locally-computed txid) was already implemented on all three provider paths; explicit regression tests now cover EACH path (`RpcUtxoProvider` / `MempoolUtxoProvider` / `GetBlockHybridProvider`), including the canonical duplicate-on-RETRY case (first broadcast landed, response lost), every known already-known error variant, HTTP-5xx-carrying-duplicate-text, non-duplicate errors NOT retried, and bounded exhaustion on persistent 5xx.
  - Tests: `utxo-provider.test.ts` +26 (bounded termination / delay caps / 429 / per-provider idempotency / proof-method retry), `confirmation-proof.test.ts` +9 (transient→pending incl. failure-then-recovery round-trip with a verified branch, definitive-error→stale, mempool-shaped-provider honest-pending). NO lifecycle (`machines/bitcoinAnchor.machine.ts`), NO OP_RETURN payload, NO provider-selection changes.

- **2026-06-22 PROOF-03 (SCRUM-2336) — confirmation-proof fetch (Lane 1, stacked on Train D proof-foundation):** new `confirmation-proof.ts` adds `fetchConfirmationProof(provider, { chainTxId, blockHeight?, expectedBlockHash?, minConfirmations? })` → a deterministic, serializable `ConfirmationProof` carrying the layer-2 **bitcoin-tree** evidence: the raw 80-byte `blockHeader`, `blockHash`, `blockMerkleRoot`, and the inclusion `merkleBranch` (tx → block merkleroot) + `txIndex`. Status is `confirmed | pending | stale` — a not-yet-confirmed tx returns `pending` with **NO** fabricated branch (§1.5); a reorg/missing tx returns `stale` and never crashes. SOURCE = GetBlock RPC (DISC-03): `getblockheader <hash> false` + `gettxoutproof [txid] <blockhash>`. `parseTxOutProof()` is a self-contained `CMerkleBlock` parser (header + partial-merkle-tree walk, the standard `TraverseAndExtract`) that recomputes the root and **verifies the matched leaf equals the target txid** (gettxoutproof commits to the tx via flag bits, not by carrying the txid — without this check a proof for a different tx in the same block would be accepted). OP_RETURN format is OUT OF SCOPE (verifier's concern, S2) — this fetch is format-agnostic.
  - **`utxo-provider.ts`**: `UtxoProvider` gains OPTIONAL `getBlockHeaderHex(blockhash)` + `getTxOutProof(txids, blockhash?)` (optional so existing `UtxoProvider` mocks don't break). New `ConfirmationProofProvider` narrow slice (just `getRawTransaction` + the two optional methods). Implemented on `RpcUtxoProvider` + `GetBlockHybridProvider` (route through the GetBlock RPC node — sovereign, same node as broadcast). `MempoolUtxoProvider` implements `getBlockHeaderHex` (via `/block/:hash/header`) but DELIBERATELY does NOT implement `getTxOutProof` (mempool.space has no CMerkleBlock-format endpoint), so a mempool-only deployment reports `pending` rather than fabricating an unverifiable branch.
  - Tests: `confirmation-proof.test.ts` (22) builds real `gettxoutproof` blobs in-process from a faithful `CMerkleBlock` serializer (NO real Bitcoin API, §1.7) and round-trips parse→recompute→merkleroot for 1/5/8-tx blocks at every match index, plus confirmed/pending/reorg/missing/malformed, AND the CVE-2012-2459 degenerate `left==right` reject (PR #1320). `utxo-provider.test.ts` +6 for the new RPC methods.
  - **MED-1 (CVE-2012-2459, PR #1320):** the duplicate-node reject is now ACTUALLY implemented in `walkMerkleTree` + `extractBranchForIndex` (was only claimed in a comment). For a GENUINE right child (per `calcWidthAtHeight`), `left.equals(right)` ⇒ malformed tree (return null / propagate failure), mirroring Bitcoin Core's `fBad`. Odd-row legitimate `right = left` duplicates are unaffected (they take the `else` branch, no compare).
  - **LOW-1 (residual, NOT fixed — document only):** a DEEP reorg that occurs AFTER a `confirmed` proof is populated leaves a STALE `block_header`/`block_hash` on the `anchor_proofs` row with **no re-validation path** — nothing re-fetches a header once `block_header IS NOT NULL` (the populated header is the scan watermark, so the row stops matching). On mainnet the backfill's `minConfirmations=6` makes a reorg past a populated proof unlikely (a 6-block reorg is rare), so this is accepted residual risk for now. Follow-up: on reorg detection (`jobs/chain-maintenance.ts::detectReorgs`), null out `block_header`/`block_hash` for affected anchors so the backfill re-populates under the new block.

- **2026-04-26 SCRUM-1262 R1-8 /simplify carry-over:** `GetBlockHybridProvider.listUnspent()` RPC-fallback Sentry breadcrumb + structured warn log pair extracted to `emitRpcFallback()` in `services/worker/src/utils/sentry.ts`. Future RPC-fallback sites (`getrawtransaction` / `getblockheader` / fee estimation) can now reuse the same locked field shape (`chain_rpc_fallback`, `method`, `provider`, `reason`) so Cloud Logging + Arize + db-health dashboards see one canonical event signature.

- **Session 38 (2026-04-09):** Added `estimateCurrentFee()` to `ChainClient` interface (`types.ts`) and `BitcoinChainClient` (`signet.ts`). Exposes fee estimator for pre-claim fee checks in batch anchor scaling (SCALE-4).

- **Integration tests:** Added `signet.integration.test.ts` — 8 tests constructing and signing real Bitcoin Signet transactions end-to-end (keypair generation → funding tx → OP_RETURN anchor → sign → validate). Covers: valid tx from generated keypair, known test WIF, large UTXO values, dust change handling, invalid fingerprint rejection, different fingerprints → different txIds, scriptSig DER+pubkey validation, broadcast skip documentation. Total: 416 worker tests across 18 files.

- **CRIT-2 Step 5-8:** Added `signing-provider.ts` (WIF + KMS), `fee-estimator.ts` (static + mempool), chain index lookup (`SupabaseChainIndexLookup` in `client.ts`). Refactored `signet.ts` → `BitcoinChainClient` with provider abstractions. Rewrote `client.ts` to async factory pattern (`initChainClient()` / `getInitializedChainClient()`). Supports signet (WIF), testnet (WIF), mainnet (KMS). Migration 0050 creates `anchor_chain_index` table. Config expanded with 5 new env vars.
- Broadcast test coverage: Added 3 broadcast-specific tests to `signet.test.ts` (txid mismatch handling, empty txid fallback, raw hex format verification) and 3 to `utxo-provider.test.ts` (Mempool POST format, whitespace trimming, HTTP status in errors).
- P7-TS-12: Added `utxo-provider.ts` — `UtxoProvider` interface, `RpcUtxoProvider`, `MempoolUtxoProvider`, factory.
- P7-TS-11: Added `wallet.ts` — `generateSignetKeypair()`, `addressFromWif()`, `isValidSignetWif()`.

## Do / Don't Rules

- **DO** use `getInitializedChainClient()` in hot paths (e.g., `processAnchor`) — NOT the old `getChainClient()`
- **DO** call `initChainClient()` once at startup (in `index.ts` listen callback)
- **DO** use `UtxoProvider` interface for all UTXO operations (never raw `fetch` in signet.ts)
- **DO** use `MockChainClient` in all test suites outside this folder
- **DO NOT** log the treasury WIF or KMS key ID (Constitution 1.4)
- **DO NOT** import `generateFingerprint` (Constitution 1.6 — client-side only)
- **DO NOT** call real Bitcoin APIs in tests — mock `UtxoProvider` methods
- **DO NOT** set `anchor.status = 'SECURED'` from client code — worker-only via service_role
- **DO NOT** use string `'mainnet'` for network config — use `bitcoin.networks.bitcoin` from `bitcoinjs-lib`
- Test funding txs: use `buildDummyFundingTx()` pattern — static hex strings fail PSBT validation

## MVP Launch Gap Context
- No MVP launch gap stories directly target this folder. Mainnet treasury funding is complete; GCP Cloud KMS is the production signing provider. The AWS KMS provider remains in the codebase as future optionality only — NOT deployed (SCRUM-902).

## Dependencies

- `bitcoinjs-lib`, `tiny-secp256k1`, `ecpair` — Bitcoin transaction construction + signing
- `@google-cloud/kms` — GCP Cloud KMS signing (production mainnet)
- `@aws-sdk/client-kms` — AWS KMS signing (code-level abstraction only; NOT in production, see SCRUM-902)
- `../config.js` — environment config (WIF, KMS key, RPC URL, fee strategy, feature flags)
- `../utils/logger.js` — structured logging (pino)
- `../utils/db.js` — Supabase service_role client (for `SupabaseChainIndexLookup`)
