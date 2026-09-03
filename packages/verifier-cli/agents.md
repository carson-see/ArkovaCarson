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
  inclusion/header/reorg confirmation is OWNED by `arkova-verifier`
  (PROOF-07 / #1349), imported as a `file:../verifier` dependency. The CLI calls
  its `confirmInclusion` / `createEsploraFetch`; it keeps **no second decoder**.
  #1349 has the correct canonical decode (`ARKV(4)‖root(32)`, no version byte,
  fixed byte offset — never a substring match) AND the txid-binding inclusion
  proof. (The old `src/lib/{esplora,opreturn}.ts` parallel decoder was DELETED in
  the #1353 rework — Carson flagged `opreturn.ts:75` + `verify.ts:173`.)
- **Never contact Arkova.** `src/lib/independent-endpoint.ts::assertIndependentEndpoint`
  refuses any `arkova.*` host before any on-chain call. The on-chain fact is
  confirmed only against an independent Esplora node. Keep it that way.
- **Signature ≠ recompute — but a requested check that FAILS fails closed
  (S3-B).** The optional Ed25519 check (`src/lib/signature.ts`) proves only
  that Arkova issued the package; a PASSING signature must never substitute
  for the recompute (unchanged). Since S3-B, when the caller EXPLICITLY
  requests the check (bundle + key supplied) and it fails, the verdict is
  NOT VERIFIED (`SIG_INVALID`), and a `signing_key_id` that resolves to no key
  in the supplied published key set fails closed too (`DID_UNRESOLVED` — never
  "try every key"). No key material supplied ⇒ skipped, verdict unaffected.
- **Frozen reason enum (S3-B).** Every NOT-VERIFIED verdict carries exactly one
  machine `reasonCode` from `src/lib/reason-codes.ts`, mirrored byte-for-byte
  in `fixtures/manifest.json` (`reason_codes`) and re-derived independently by
  the Python verifier (`packages/arkova-py/src/arkova/proofs.py`). Append-only:
  never rename/reorder; bump `reason_enum_version`; `test/manifest.test.ts`
  pins the freeze and requires every code to be exercised by a fixture.
- **Adversarial fixtures are authored FROM SPEC, never from the builder.**
  `fixtures/adversarial-vectors.json` is emitted by
  `fixtures/author-adversarial.py` — a clean-room Python implementation of the
  documented formats that shares ZERO code with `generate-fixtures.mjs`.
  Do not "fix" a failing adversarial vector by regenerating it from the TS
  builder; a divergence means one side departed from the spec — find which.
- **Three-way parity is a gate.** `npm run parity`
  (`scripts/parity-compare.mjs`) runs the WHOLE manifest through the TS
  verifier AND the Python verifier and requires TS == Python == manifest.
  Suggested CI job (needs python3 ≥ 3.9; kept out of `npm test` so the
  Node-only CI job stays self-contained). The interpreter is NEVER resolved
  via `$PATH` (Sonar S4036): `$ARKOVA_PYTHON` (absolute) when set, else the
  fixed locations `/usr/bin/python3`, `/usr/local/bin/python3`,
  `/opt/homebrew/bin/python3`.
- **Terminology ban (§1.3)** applies to all user-facing strings (CLI help +
  rendered report): Fingerprint / Network Receipt / Network Observed Time — not
  Hash / Transaction / Block / Broadcast. `test/cli.test.ts` asserts this.
- **Never compare `process.argv[1]` to `import.meta.url` unresolved.** npm
  installs a `bin` as a SYMLINK (`node_modules/.bin/arkova-verify ->
  ../arkova-verifier-cli/dist/cli.js`); `import.meta.url` is always the
  realpath, `argv[1]` is the path as invoked, so an unresolved comparison is
  false for **every** global install and every `npx` run — `main()` never runs
  and the CLI exits 0 having printed nothing. `isDirectInvocation()` in
  `src/cli.ts` resolves with `realpathSync` and builds the URL with
  `pathToFileURL` (`new URL('file://' + p)` mis-parses `#`, `?`, `%` in a path).
  Every other CLI test drives `main()` in-process and cannot catch this, so the
  guard is exported and pinned directly in `test/cli.test.ts`.
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
  whose own txid differs → tripped by the `arkova-verifier` txid-binding GUARD
  at `independent-node.ts:160`, distinct from the weaker `txid-mismatch-fail`
  whose body echoes the requested txid and only trips later inclusion) pin both.

## Layout

- `src/cli.ts` — the `arkova-verify` bin (arg parse, IO, exit codes); builds the
  independent node from a vetted `--rpc` via `assertIndependentEndpoint` +
  `createEsploraFetch`; `--key` loads a published key SET (kid-resolved) or a
  raw PEM.
- `src/verify.ts` — the orchestrator → `VerifyReport` (schema gate → recompute
  → on-chain steps 2 & 3 via `arkova-verifier`'s `confirmInclusion` →
  timestamp honesty → signature). Emits per-step `code` + top-level
  `reasonCode` from the frozen enum.
- `src/lib/reason-codes.ts` — the FROZEN S3-B reason enum + the two mapping
  layers (vendored recompute reasons; ConfirmInclusionStatus).
- `src/lib/independent-endpoint.ts` — the Arkova-host guard (host policy only).
- `src/lib/signature.ts` — published-key Ed25519 verify with `signing_key_id`
  resolution against a key set (fail-closed on unknown ids; a MISSING/blank
  `signing_key_id` also fails closed — `undefined === undefined` must never
  match a kid-less key entry).
- `src/lib/fixtures.ts` — fixture-corpus plumbing SHARED by `test/helpers.ts`
  and `scripts/parity-compare.mjs` (PROOF-08 vector→packet transform, corpus
  ref resolution, offline fixture-node transport) so the test and parity
  runners cannot drift.
- `src/lib/report.ts` — auditor-legible plain-text renderer.
- `src/vendor/` — verbatim worker Merkle recompute (byte-identity guarded).
- `fixtures/` — `manifest.json` (the SINGLE versioned fixture list + expected
  {verdict, reason_code} — three runners obey it), `synthetic-vectors.json`
  (+ `generate-fixtures.mjs`), `adversarial-vectors.json`
  (+ `author-adversarial.py`, spec-derived clean-room authoring). See
  `fixtures/README.md`.
- `scripts/parity-compare.mjs` — `npm run parity` three-way comparator
  (TS == Python == manifest).
- `test/manifest.test.ts` — manifest conformance + enum freeze + coverage +
  corpus drift pins; `test/no-network.test.ts` — transport-layer lockdown
  (globalThis.fetch throws for every host but the mock node), field
  completeness, and the mechanical no-Arkova-client source audit;
  `test/reason-codes.test.ts` — enum mapping + schema gate + signature
  semantics.

## Build/test

Self-contained toolchain (own `package.json` / `tsconfig.json` / `eslint.config.js`
/ `vitest.config.ts`), like `packages/embed` — but it depends on the sibling
`arkova-verifier` (`file:../verifier`), so **build that first**:
`cd ../verifier && npm ci && npm run build`, then `cd ../verifier-cli &&
npm ci && npm test && npm run lint && npm run typecheck` (`lint` covers
`src`, `test` AND `scripts` — the parity comparator is linted with Node ESM
globals, not ignored). The test suite is
**clean-room**: it touches no network (and `test/no-network.test.ts` enforces
that at the transport layer, not just by convention). CI job: `verifier-cli` in
`.github/workflows/ci.yml` (builds `arkova-verifier` before installing the CLI).
`npm run parity` additionally requires `python3` ≥ 3.9 (runs the independent
Python verifier over the same manifest) — suggested as its own CI job; it is
deliberately NOT part of `npm test`.

## Publishing

Full ordered runbook: [`PUBLISHING.md`](./PUBLISHING.md). The parts that are
rules, not steps:

- npm name is the **unscoped `arkova-verifier-cli`**; the bin is `arkova-verify`.
  The `@arkova` scope does not exist and is not being created. Unscoped public
  is npm's default, so **no `--access public` and no `publishConfig`**.
- **`arkova-verifier` publishes FIRST.** This package depends on it, and the
  dependency is committed as `file:../verifier` **on purpose**: that sibling is
  not on the registry, so a `^0.1.0` range would break `npm install` in a fresh
  clone and in CI. The swap to a version range happens *between* the two
  publishes and is **reverted afterwards** — never left in the committed tree,
  or local edits to `packages/verifier` stop reaching this package and the CI
  "build the dependency first" step, the byte-identity guard and the parity gate
  all start testing the published copy instead of the working tree.
- `prepack` runs the build, so `npm publish` cannot ship a stale or absent
  `dist/` behind the `bin` entry.
- **`prepublishOnly` (`scripts/check-publishable.mjs`) hard-fails the publish
  while any `file:` dependency is present.** Do not remove it and do not work
  around it with `--ignore-scripts`: npm will publish a `file:` path without
  complaint, the tarball then installs with exit `0` and a dangling link, and
  the binary fails only at runtime with `ERR_MODULE_NOT_FOUND` — permanently,
  because publishes are irreversible. The guard is the only thing standing
  between a skipped step 2 and a broken `0.1.0`.
- The published tarball deliberately EXCLUDES `dist/**/*.map` (the maps are
  dangling — `src/` does not ship and `sourcesContent` is absent) and the two
  fixture authoring tools (`author-adversarial.py`, `generate-fixtures.mjs` —
  a Python script has no place in a JS consumer install). The fixture CORPUS
  still ships so auditors can re-run it. 33 files / 193.4 kB.
- `scripts/publish-packages.sh` covers `sdk` + `embed` only and must NOT be used
  here — it has no concept of the ordered two-step `file:` dependency swap.
- `fixtures/` ships (auditors can re-run the corpus) but nothing in `src/` reads
  it at runtime, so it is corpus value only, not a runtime dependency.
