# @arkova/verifier-cli — Arkova reference verifier (v0.1)

A **standalone, MIT-licensed** command-line verifier that proves a document's
fingerprint is committed in an on-chain Merkle root **without trusting Arkova's
servers**. It makes **zero Arkova network calls**: the on-chain fact is
confirmed against an **independent node** that you choose.

> Status: **S2 CLI v0.1** (recompute + independent receipt confirmation). The
> public OSS repo is the S3 deliverable; this lives in-repo for now with **zero
> Arkova-server runtime dependency**. See
> `docs/sprint-0/lane1/verifier-oss-sdk-predesign.md`.

## What it proves (and what it does not)

It establishes exactly one fact: **the fingerprint is included in a root that
was recorded on the public network at the stated time.** It asserts **nothing**
about the document's contents, the holder's identity, or any registry listing.

It deliberately **ignores** the proof package's own `verified` field — that
field is verdict-from-status on the server side. This verifier trusts only its
own recomputation.

## Install / build

The CLI consumes [`@arkova/verifier`](../verifier) (PROOF-07 / #1349) as a local
`file:` dependency for the **shared** on-chain confirmation routine, so build it
once first:

```bash
cd ../verifier && npm install && npm run build   # build the shared verifier dep
cd ../verifier-cli
npm install
npm run build      # compiles to dist/, exposes the `arkova-verify` bin
```

## Usage

```bash
arkova-verify <proof.json> [--rpc <url>] [--key <keys.json>] [--offline] [--json]
```

| Flag | Meaning |
|---|---|
| `<proof.json>` | An Arkova proof package — either the plain shape from `GET /api/v1/verify/:publicId/proof`, or a signed bundle (`?format=signed`). |
| `--rpc <url>` | Independent Esplora node for on-chain confirmation. Default `https://blockstream.info/api`. **Must not be an Arkova host** — the CLI refuses one. |
| `--key <keys.json>` | A published-key file (`docs.arkova.ai/keys.json` shape, or a raw PEM) to verify the issuer signature. |
| `--offline` | Skip on-chain confirmation (recompute-only). The report states honestly that the on-chain step was not run. |
| `--json` | Emit the machine-readable report. |

Exit codes: `0` VERIFIED · `1` NOT VERIFIED · `2` usage/input error.

## How offline verification works (the 4 steps)

1. **Recompute the published root** from the fingerprint + inclusion path,
   using the **same canonical routine the server uses** — `merkle-verify.ts`,
   with leaf/internal domain separation and the CVE-2012-2459 duplicate-leaf
   guard driven by `merkle_index` + `leaf_count`. (See "Shared recompute" below.)
2 & 3. **Confirm the root on-chain and the receipt in a real block** by
   delegating to [`@arkova/verifier`](../verifier)'s `confirmInclusion`. That ONE
   shared routine owns the canonical `OP_RETURN` decode (`ARKV(4)‖root(32)`, no
   version byte, read at a **fixed byte offset** — never a substring match), the
   **txid-bound** inclusion proof (a proof for a *different* tx in the same block
   is rejected), the height→hash reorg guard, and the independent 80-byte header
   recomputation. The CLI keeps **no second decoder** of its own.
4. **(Optional) Verify the issuer signature** against the published Arkova key.
   This only proves *Arkova issued the package* — it **never** substitutes for
   the recomputation in steps 1–3, and is reported on a separate line.

You can run the whole thing against **your own node**: point `--rpc` at it.
Nothing in this tool ever contacts Arkova.

## Shared recompute (no divergent re-implementation)

The recompute is **not** re-implemented here. `src/vendor/merkle-verify.ts` (and
its `merkle.ts` / `canonical-json.ts` deps) are **verbatim copies** of
`services/worker/src/utils/`, and `test/sync-recompute.test.ts` fails the build
the moment they drift byte-for-byte — plus a behavioral-parity test that imports
the **actual** worker `verifyMerkleInclusion` and asserts identical verdicts
across every fixture. To re-sync after an upstream change:

```bash
cp ../../services/worker/src/utils/{merkle-verify,merkle,canonical-json}.ts src/vendor/
```

## Tests (clean-room — no network)

```bash
npm test          # 38 tests across 5 files, fully offline
npm run lint
npm run typecheck
```

The conformance suite drives a fixture-backed independent node (an
`@arkova/verifier` `IndependentNodeFetch` served from canned Esplora REST
responses), so it runs with **no network reachable** — see `fixtures/README.md`
for the self-describing vector contract and the **PROOF-08** golden-vector
dependency.
