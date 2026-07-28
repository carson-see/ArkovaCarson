# packages/verifier/agents.md

`@arkova/verifier` — standalone, **zero-Arkova-dependency** Bitcoin anchor verifier (PROOF-07, PI-0 Sprint 2 / Lane 1).

## Purpose
The PROOF-07 verifier CLI imports `confirmInclusion()` from here to confirm an
anchor's on-chain inclusion against an **INDEPENDENT** block-explorer node
(Esplora / Blockstream REST). This is the trust-minimized cross-check: a third
party must reach the same verdict against a node WE do not control.

**NEVER queries Arkova infrastructure and NEVER uses Arkova's GetBlock RPC
token.** Default base URL is Esplora (`https://blockstream.info/api`), injectable
via `--rpc` on the CLI.

## Structure
- **`src/independent-node.ts`** — the verifier. `confirmInclusion(req, { fetch })`
  + `createEsploraFetch(baseUrl, httpFetch?)` transport builder. Pure-buffer
  Bitcoin parsing (Node `crypto` only) — no `bitcoinjs-lib`, no worker imports.
- **`src/independent-node.test.ts`** — 17 tests, all node calls mocked (no real
  network, CLAUDE.md §1.7): valid inclusion (+ metadata suffix), payload
  mismatch, forged-substring OP_RETURN, not-in-block, inclusion-failed,
  same-block-different-tx, height mismatch, reorg (height→hash), txid-binding
  guard, tx-not-found, malformed input, header-derived `observedTime`
  (header-independent + downstream-failure + pre-header-null), transport builder.
- **`src/index.ts`** — barrel export (the CLI's import surface).

## What `confirmInclusion` checks (all must pass)
1. **OP_RETURN payload** — structural decode at fixed offset `[4,36)` of the
   single OP_RETURN push (`ARKV||root[||meta]`), equals the expected Merkle root.
   NOT a substring match (mirrors `services/worker/src/chain/signet.ts`).
2. **Inclusion** — the node's Merkle proof for THIS txid recomputes to the
   independently-fetched header's merkleroot; the fold starts at the target txid
   so a valid proof for a different tx in the same block is rejected.
3. **Height binding** — tx's block height == stated height AND `/block-height/:h`
   maps that height to the SAME block hash (independent reorg guard).
4. **Header integrity** — the 80-byte header double-SHA256s to the claimed block
   hash; its merkleroot is what inclusion is checked against.

Additionally, the result carries `observedTime: string | null` — the Network
Observed Time DERIVED FROM the 80-byte header (LE uint32 UNIX seconds at bytes
`[68,72)` / hex chars `[136,144)`, rendered ISO-8601 UTC). It is INDEPENDENTLY
MEASURED off the header the node served, never trusted from any packet field;
`null` only when the header was not fetched/validated. The PROOF-07 CLI (#1353)
compares it against the packet's claimed `block_timestamp` to flag a forged
timestamp (§1.5 — measured vs asserted).

## Conventions
- Mirrors `@arkova/sdk` toolchain: own `tsconfig.json` + `vitest.config.ts`,
  `tsup` build, NO eslint (root eslint ignores `packages/`). Gates: `tsc
  --noEmit` + `vitest run`.
- Zero runtime dependencies (only `node:crypto`). Keep it that way — the whole
  point is a verifier that runs anywhere with no Arkova coupling.
- Never throws on a failed/uncooperative node — every failure maps to a
  `ConfirmInclusionStatus`. The result reports what was actually found on chain
  (e.g. the real extracted root on a payload mismatch) per §1.5 honesty.

## Esplora endpoints used (read-only)
`GET /tx/:txid` · `GET /tx/:txid/merkle-proof` · `GET /block/:hash/header` ·
`GET /block-height/:height`

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball. See `scripts/security/package-license-files.test.ts`.
