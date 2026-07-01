# packages/verifier-cli — agent notes

Standalone MIT reference verifier for Arkova proof packets. **Zero Arkova
network calls; zero Arkova-server runtime dependency.** (PROOF-07 / SCRUM-2340,
S2 CLI v0.1.) Design: `docs/sprint-0/lane1/verifier-oss-sdk-predesign.md`.

## Hard rules

- **Never re-implement the Merkle recompute.** `src/vendor/{merkle-verify,merkle,canonical-json}.ts`
  are verbatim copies of `services/worker/src/utils/`. `test/sync-recompute.test.ts`
  enforces byte-identity + behavioral parity against the live worker export. If
  the worker routine changes, re-copy the files (see README) — do not hand-edit
  the vendored copies.
- **One on-chain routine — import, never duplicate.** The OP_RETURN decode +
  inclusion/header/reorg confirmation is OWNED by `@arkova/verifier`
  (PROOF-07 / #1349), imported as a `file:../verifier` dependency. The CLI calls
  its `confirmInclusion` / `createEsploraFetch`; it keeps **no second decoder**.
  #1349 has the correct canonical decode (`ARKV(4)‖root(32)`, no version byte,
  fixed byte offset — never a substring match) AND the txid-binding inclusion
  proof. (The old `src/lib/{esplora,opreturn}.ts` parallel decoder was DELETED in
  the #1353 rework — Carson flagged `opreturn.ts:75` + `verify.ts:173`.)
- **Never contact Arkova.** `src/lib/independent-endpoint.ts::assertIndependentEndpoint`
  refuses any `arkova.*` host before any on-chain call. The on-chain fact is
  confirmed only against an independent Esplora node. Keep it that way.
- **Signature ≠ recompute.** The optional Ed25519 check (`src/lib/signature.ts`)
  proves only that Arkova issued the package; it must never gate the verdict.
- **Terminology ban (§1.3)** applies to all user-facing strings (CLI help +
  rendered report): Fingerprint / Network Receipt / Network Observed Time — not
  Hash / Transaction / Block / Broadcast. `test/cli.test.ts` asserts this.
- **No `verified`-from-packet.** The verifier ignores the packet's `verified`
  field for its verdict and only surfaces it for comparison.
- **Network Observed Time is MEASURED, never claimed (§1.5; Carson #1353 2nd-pass).**
  The reported "Network Observed Time" is the instant read off the 80-byte block
  header the independent node served (`ConfirmInclusionResult.observedTime`),
  NOT the packet's self-claimed `block_timestamp`. `verify.ts` compares the two
  in a `timestamp_honesty` step: a divergence FAILS the verdict and the report
  shows the measured time + flags the packet's claim as "DISAGREES … NOT
  corroborated". In recompute-only mode no header is measured, so the time is
  surfaced as the record's own *claim*, never promoted to "observed". Fixtures
  `forged-timestamp-fail` (mismatch → fail) and `txid-body-mismatch-fail` (body
  whose own txid differs → tripped by the `@arkova/verifier` txid-binding GUARD
  at `independent-node.ts:160`, distinct from the weaker `txid-mismatch-fail`
  whose body echoes the requested txid and only trips later inclusion) pin both.

## Layout

- `src/cli.ts` — the `arkova-verify` bin (arg parse, IO, exit codes); builds the
  independent node from a vetted `--rpc` via `assertIndependentEndpoint` +
  `createEsploraFetch`.
- `src/verify.ts` — the 4-step orchestrator → `VerifyReport`. Steps 2 & 3
  delegate to `@arkova/verifier`'s `confirmInclusion`.
- `src/lib/independent-endpoint.ts` — the Arkova-host guard (host policy only).
- `src/lib/signature.ts` — optional published-key Ed25519 verify.
- `src/lib/report.ts` — auditor-legible plain-text renderer.
- `src/vendor/` — verbatim worker Merkle recompute (byte-identity guarded).
- `fixtures/` — self-describing vectors + `generate-fixtures.mjs` (PROOF-08
  golden vectors pending; local synthetic vectors ship meanwhile). See
  `fixtures/README.md`.

## Build/test

Self-contained toolchain (own `package.json` / `tsconfig.json` / `eslint.config.js`
/ `vitest.config.ts`), like `packages/embed` — but it depends on the sibling
`@arkova/verifier` (`file:../verifier`), so **build that first**:
`cd ../verifier && npm ci && npm run build`, then `cd ../verifier-cli &&
npm ci && npm test && npm run lint && npm run typecheck`. The test suite is
**clean-room**: it touches no network. CI job: `verifier-cli` in
`.github/workflows/ci.yml` (builds `@arkova/verifier` before installing the CLI).
