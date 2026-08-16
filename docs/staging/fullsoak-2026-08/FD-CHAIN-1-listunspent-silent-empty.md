# FD-CHAIN-1 — `listUnspent` returns empty on a *successful* RPC, silently halting all anchoring

**Severity:** P0-latent in prod · **P0-active on any self-hosted-node deployment**
**Found:** 2026-08-16 (Day 4), fullsoak-2026-08 rig
**Component:** `services/worker/src/chain/utxo-provider.ts` — `GetBlockHybridProvider.listUnspent`

## What happened

Anchor traffic generation began Day 4. Every anchor stayed `PENDING`. Across 40 minutes
and two full `batch-anchors` cycles (14:30, 15:00), **zero** anchors advanced — while the
cron returned **HTTP 200**, Cloud Scheduler reported success, and the 90-minute SOC2
health check passed **13/13**.

The worker logged:

```
Treasury has no UTXOs — batch processing will be skipped until funded
Treasury empty — skipping batch anchor processing until funded
```

**The treasury was not empty.** `tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7` held
**742,637 sat in 1 confirmed UTXO**, verified independently against
`https://mempool.space/signet/api`. The same worker knew this — seconds apart, in the
same service:

| Time | Log | Value |
|---|---|---|
| 15:09:05 | `Treasury cache refreshed` | **`balance: 742637`** |
| 15:00:16 | `Treasury has no UTXOs` | same address, `listUnspent` → `[]` |

Two code paths against the same wallet disagreed. An operator reading that log would go
top up a wallet that already had money.

## Root cause

```js
async listUnspent(address: string): Promise<Utxo[]> {
  try {
    const rpcUtxos = await rpcCall(this.rpcUrl, 'listunspent', [1, 9999999, [address]], this.rpcAuth);
    if (rpcUtxos && rpcUtxos.length >= 0) {   // ← ALWAYS TRUE, including for []
      return rpcUtxos.map(...);               // ← returns [], never falls through
    }
  } catch (err) {
    emitRpcFallback({ ... });
  }
  return this.mempool.listUnspent(address);   // ← unreachable when RPC succeeds with []
}
```

`rpcUtxos.length >= 0` is true for **every** array. bitcoind's `listunspent` returns only
**wallet** UTXOs; the treasury address is WIF-derived and is not in the node's wallet, so
the RPC **succeeds with `[]`** — no exception, therefore no fallback. The guard passes,
`[]` is returned, and the mempool.space fallback that would have found the 742,637 sat
never executes. The guard needed `> 0`.

## Why it was never caught

The fallback was written for the *opposite* failure. Its own comment (SCRUM-1262 / R1-8)
says the GetBlock shared endpoint returns "Method not allowed" on `listunspent`. The
design assumes the RPC **throws**. A self-hosted bitcoind **succeeds and returns empty** —
a case the guard never anticipated. No test covers "RPC returns 200 with an empty array".

## Blast radius — prod is fine, and only by accident

Prod runs `BITCOIN_UTXO_PROVIDER=getblock` on `mainnet` and **is anchoring normally**
(`Treasury pre-flight check passed, utxoCount=2, totalSats=387910` at 15:10:01).

It survives because its RPC **fails on every cycle**:

```
14:40:01  GetBlockHybridProvider.listUnspent: RPC fallback to mempool.space  (listunspent)
14:50:01  … 15:00:01 … 15:00:23 … 15:10:01   — a 100% fallback rate
```

The exception fires, so the fallback runs, so prod gets real UTXOs. **The bug is fully
latent there, masked by a broken RPC.** The moment prod moves to a self-hosted node — the
stated sovereignty goal, and precisely the architecture this rig runs — `listunspent`
starts succeeding with `[]`, the fallback stops firing, and prod anchoring stops **silently**.

This soak found it by being the first environment ever to run that architecture.

## Companion finding — FD-CHAIN-2

The same code comment says the fallback counter exists so we can "alert if it stays at
100% (i.e. the RPC is functionally unused)". **Prod is at 100% fallback right now.** The
sovereign RPC contributes nothing to UTXO listing, and no alert fires. The dashboard/alert
described in the comment is either absent or not wired.

## Failure-of-detection — the part that matters most

Anchoring was **completely halted** and every signal stayed green:

- `POST /jobs/batch-anchors` → **200**
- Cloud Scheduler → success, no error code
- 90-minute SOC2 health check → **13/13 PASS**
- No alert policy fired

Same defect class as FD-C2 (`smoke-test` 503 → dashboards publish a hard 0) and #2233
(ingestion reporting total failure as HTTP 200). A skipped batch is not a successful batch.

Two detection gaps to close, independent of the code fix:

1. `batch-anchors` must not return a bare 200 when it skips the entire batch for lack of funds.
2. The health check must assert **anchor advancement**, not merely worker liveness. It
   passed 13/13 through a total anchoring outage, so it did not measure anchoring.

## Fix

- `rpcUtxos.length >= 0` → `> 0`, so an empty-but-successful RPC falls through to the fallback.
- Regression test: RPC resolves `[]` → provider MUST still return the mempool.space UTXOs.
  Written failing-first; it fails against current `main`.
- Consider distinguishing "treasury genuinely empty" from "no UTXO source returned data" —
  the current message asserts the former while observing the latter, which is what sent the
  diagnosis toward the wallet instead of the provider.

## Rig remediation (does not fix the bug)

Anchoring on the rig is unblocked at the **node** layer so the remaining window exercises
the pipeline. That is a workaround, not a fix: the `>= 0` defect is untouched by it and
the code fix ships separately as a draft PR. The frozen worker revision
`arkova-worker-fullsoak-2026-08-staging-00013-mrw`, its digest, env, git_sha and uptime
are not modified.
