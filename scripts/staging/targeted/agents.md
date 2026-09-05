# scripts/staging/targeted/

**Targeted** soak drivers — the RIGHT soak foundation. Unlike `../load-harness.ts --mode mixed` (generic synthetic load that only proves the worker is UP → health-only, fails §1.12 + the Staging Soak Evidence Gate), each driver here hits the EXACT changed surface of a specific PR, drives every documented branch, and captures the response body that proves the branch was reached.

Root cause this replaces: the failed soak fleet ran `load-harness --mode mixed` which never touched any PR's changed path. A soak that doesn't exercise the change is not merge-grade evidence.

## What lives here

| File | Purpose |
|---|---|
| `driver-core.ts` | Shared plumbing: labeled-outcome recording, per-branch status classification against an allowed-status set (a 404 is EXPECTED evidence for the RECORD_NOT_FOUND branch, not a failure), structured evidence summary (status mix, per-branch counts, captured bodies), body helpers (`bodySnippet`, `captureProofErrorCode`), the `fireLabeled` HTTP fire, and `parseDriverArgs`. Pure — fully unit-tested. |
| `fixtures.ts` | Pure row builders + injectable `FixtureExecutor` for the minimal, clearly-synthetic fixtures each branch needs: `buildSecuredUnbatchedAnchor` (SECURED + on-chain receipt but no `anchor_proofs` row → NO_BATCH_PROOF), `buildDlqFixtureRow` (unresolved `webhook_dead_letter_queue` row), `buildOrgAndAdminProfile`. Every fixture is `TSOAK-`-tagged, uses `@staging.invalid.test` emails + `http://localhost` URLs, and carries only metadata (§1.11A / §1.6-safe). `makeDbExecutor` wires them to a service-role client at run time. |
| `runtime.ts` | Live-rig plumbing (NOT unit-tested beyond the two pure helpers): Cloud Run IAM token (30-min refresh, `STAGING_GCP_IDENTITY` override), service-role Supabase seeder, `writeEvidenceFile`, and the `runDriver` seed-once-then-fire-on-a-30s-cadence loop. |
| `verify-proof-driver.ts` (**#1439**) | GET `/api/v1/verify/:public_id/proof` — drives BOTH 404 branches (`record-not-found` unknown id → RECORD_NOT_FOUND; `no-batch-proof` seeded SECURED-but-unbatched id → NO_BATCH_PROOF) + a `invalid-public-id` 400. Captures each body's `proof_error_code`. |
| `ops-slo-driver.ts` (**#1441**) | GET `/api/admin/ops-slo-stats` — `admin-ok` (platform-admin JWT → 200, captures per-surface `available` map incl `available:false`), `non-admin-forbidden` (403), `unauthenticated` (401). |
| `webhooks-self-service-driver.ts` (**#1443**) | ORG_ADMIN JWT-gated `/api/v1/webhooks/self-service/*` — `test` (`/:id/test`), `replay` (`/deliveries/:id/replay`), `dlq-list` (`/dlq`), `dlq-resolve` (`/dlq/:id/resolve`) against a seeded DLQ fixture, + `unauthenticated` 401. Paces one pass every 65s so the long run proves the changed behavior without accidentally turning the whole soak into a batch-limiter 429 test. |
| `cpe-cle-exports-driver.ts` (**#1415**) | POST the three `/api/v1/exports/{cpe,cle,org/cpe}-log` endpoints in BOTH pdf+json, plus an explicit cross-user 403 isolation case, three Zod edges (bad format enum, malformed date, inverted period → 400), and a 401. |
| `public-projection-driver.ts` (**#2314 / #2440**) | The two ANONYMOUS public-projection surfaces — `public.get_public_anchor` over PostgREST and `GET /api/v1/verify/:publicId` — asserted semantically, not just by status: FERPA §99.37 directory suppression (0415) and canonical `sub_type` projection (0421), plus cross-org issuer isolation and a not-found control. `--projection-head=0415\|0421` selects which assertions apply, because the two migrations clobber each other's `CREATE OR REPLACE` body. |
| `classify-backcatalog-driver.ts` (**#1410**) | POST `/jobs/classify-proof-backcatalog` (back-catalogue proof-completeness classifier census) — `census-dry-run` (default; per-class plan, zero proof writes), `census-bounded` (batch_size+max_batches → resumable cursor/checkpoint path), `census-restart` (restart=true → fresh census from cursor zero), + the two 400 param guards (`batch_size` below the 50 floor; malformed `org_id` uuid). Every request is dry-run (execute never set); auth = cronAuth `X-Cron-Secret` + Cloud Run IAM. Census runs over the rig's existing anchors/anchor_proofs — no bespoke fixture (the baseline fixture supplies rows). |
| `mcp-sdk-surface-driver.ts` (**#2589 / SCRUM-3903**) | The MCP + SDK client-surface soak. Per cycle: (A) HOSTED MCP over streamable HTTP — `initialize`, `tools/list` (asserts every name is `arkova_`/`nessie_`-prefixed, none contains "credential", `arkova_verify_anchor`/`arkova_search_anchors` carry the API_ONLY_NOTE), `tools/call` on every read tool with rig fixtures, negatives (no auth 401, bogus key 401, unknown tool, the removed `search_credentials` and unprefixed `search_anchors` → unknown tool), `oauth-protected-resource` asserts NO `authorization_servers` (D3, UNCONDITIONALLY — see below), a Bearer-JWT path via GoTrue password grant capturing the token `alg` (ES256 on current projects — BUG-2026-09-02-002), and the SOC 2 control: `audit_events` `MCP_TOOL_CALL` count must increase across the cycle (SCRUM-3797). (B) LOCAL stdio package — `npm pack` of `sdks/mcp-server`, installed into a temp dir, spawned as a real child, JSON-RPC handshake, exactly 6 `arkova_` tools, tool calls, and a stdout-is-only-JSON-RPC assertion. (C) `--with-sdks`: `arkova` tarball + arkova-py contract calls. Evidence adds `mcp: { hostedToolNames, stdioToolNames, credentialNamedTools, apiOnlyNotePresent, oauthAdvertised, bearerAlg, bearerSkipped, auditRowsBefore/After, stdioNonJsonLines, droppedCaptures }` and top-level `checkpoint` / `complete` flags. |

## Design contract

- **Pure `plan*()` + thin runtime.** Each driver's branch logic is a pure `plan*()` returning a labeled request list — unit-tested with no network. The `main()` (auto-runs only when the module is the process entry point) resolves the tag URL, seeds fixtures, runs the plan, and writes evidence. **Write that guard as a path comparison, not a string compare.** The idiomatic `import.meta.url === \`file://${process.argv[1]}\`` holds only when argv[1] is absolute; a supervisor that launches the driver as `npm exec tsx scripts/staging/targeted/<driver>.ts` passes it RELATIVE, the compare silently fails, and `main()` never runs — a soak that looks launched and drives no load. `public-projection-driver.isDirectRun()` is the safe form: `realpathSync(resolve(...))` on both sides, which also collapses the macOS `/tmp` → `/private/tmp` symlink.
- **Tag-URL-only.** All drivers resolve `STAGING_API_BASE` through `../load-harness-env.resolveStagingApiBase`, which refuses shared/main staging hosts — no parallel-soak contamination.
- **Expected ≠ failure.** A 401/403/404/400 that IS the branch under test counts as expected soak evidence; `evidence.allExpected` is false only when a real status surprise occurred.
- **Evidence out.** `--evidence-out docs/staging/<file>.json` writes the structured summary (per-label status mix + captured bodies) to drop into a PR's `## Staging Soak Evidence` block.

## Running (against an ISOLATED rig only)

```bash
STAGING_API_BASE=https://pr-1439---arkova-worker-staging-…run.app \
STAGING_SUPABASE_URL=… STAGING_SUPABASE_SERVICE_ROLE_KEY=… \
STAGING_FIXTURE_ORG_ID=… STAGING_FIXTURE_USER_ID=… \
npx tsx scripts/staging/targeted/verify-proof-driver.ts --duration 720 --evidence-out docs/staging/soak-pr-1439.json
```

Each driver runs directly via `tsx scripts/staging/targeted/<driver>.ts` (deliberately NOT wired into `package.json` scripts, so this PR stays a pure `scripts/**` T0 add — a root-`package.json` manifest change would earn a tier under `check-staging-evidence.ts`). `--dry-run` prints the plan without seeding or firing (used by the arg-parse test). This directory is **T0 tooling** (`scripts/**`) — no staging evidence block required for a PR that only adds these files; CI green suffices. Provisioning rigs, deploying, and running the actual soaks is a **separate** phase (real spend) — nothing here starts a soak on import.

## Tests

`driver-core.test.ts`, `fixtures.test.ts`, `runtime.test.ts`, and one `*-driver.test.ts` per driver — all red-first TDD, all pure (no live rig). Run: `npx vitest run scripts/staging/targeted/`.

## classify-backcatalog driver (PR #1493, L2-S8, 2026-07-10)

Rescued the untracked `classify-backcatalog-driver.ts` (targeted driver for #1410's `POST /jobs/classify-proof-backcatalog`) onto a fresh branch off main and closed its folder-contract gap: it shipped without the mandatory `*-driver.test.ts`. The new red-first test covers plan purity (deterministic POST plan, capture on, `execute` never in any query), the two 400 guards as expected-evidence statuses (batch floor 50; org_id uuid), `classifyPath` query building, and the census interpreter (per-class counts extracted, unknown keys dropped, null on guard/non-object bodies). API-verified against main's `driver-core.ts` / `runtime.ts` / `load-harness-env.ts` exports — no shared-module changes needed.

## PR #2589 — SDK qualification runtime (SCRUM-4466)

`mcp-sdk-surface-driver.ts` requires fresh successful builds and every requested SDK leg. Tool executables resolve from explicit absolute paths (`STAGING_NPM_CLI`, `STAGING_PYTHON_BIN`); npm runs under the current Node executable. Pack skips redundant prepack hooks after the successful explicit build so JSON output stays parseable. Python builds in its own venv, selects exactly one filesystem sdist without a shell, and verifies through an asynchronous child so the in-process IAM proxy can serve requests. The API key travels in the child environment, not command arguments. The proxy preserves app Authorization, adds a separate Cloud Run IAM header, and removes compression/framing headers after fetch decodes the response. Unexpected outcomes return a failing exit code. `mcp-sdk-surface-runtime.test.ts` exercises real failed/noisy package builds, artifact ambiguity, path rejection, and child-to-proxy HTTP flow.

## PR #2589 review remediation (2026-09-05)

Five defects found reviewing the driver on `5bd5f754b`, all in
`mcp-sdk-surface-driver.ts` unless noted.

- **`--expect-oauth-advertised` failed a CORRECT build by default.** The flag
  defaulted to `true`, and `assertOauthAdvertisement(body, true)` FAILS when
  `authorization_servers` is ABSENT — which is precisely the post-D3 state this
  PR ships. A default run therefore red-flagged D3 on a healthy rig, and the
  flag's own doc comment described the opposite behaviour. The flag is gone;
  `assertOauthNotAdvertised(body)` asserts the key is absent unconditionally,
  because the absent-key shape is the only one this PR ships and a switch to
  "expect it present" could only ever make a correct build fail. **Key PRESENCE
  is the test** — an empty `authorization_servers: []` still advertises an
  authorization-server list and still fails.
- **Credential material reached logs and evidence.** The SDK-smoke catch blocks
  recorded `String(err.message)` verbatim, and a child-process error routinely
  echoes the env or argv it was handed. `redactSecrets(text, secrets)` uses
  split/join, **not** `new RegExp(secret, 'g')`: a secret is arbitrary bytes and
  `.` `+` `$` `?` are all legal base64url / JWT / API-key material, so the
  RegExp form would over-redact some strings and silently fail to redact the
  literal secret. Longest-first ordering stops an overlapping prefix
  half-exposing the longer value. A `registerSecret` registry is populated where
  each credential is read (API key, service-role key, GoTrue password, every
  granted access token incl. the tampered copy); `captureField` scrubs and
  bounds every value entering `capturedBody`; and `redactEvidenceDocument` makes
  one final pass over the **serialized** document — both the raw and the
  JSON-escaped form of each secret — before `writeEvidenceFile`, so a body that
  skipped `captureField` still cannot land on disk.
- **A GoTrue password grant per cycle, and a silent failure.** At the 30s
  cadence that is ~5,760 grants over a 48h T3 soak for a session valid for an
  hour, and a failed grant only logged and returned — leaving `allExpected`
  true while the whole §D Bearer surface went unexercised. `decodeJwtExpMs`
  (payload segment 1, sibling of the existing header-`alg` read) feeds a
  driver-scope cache; `tokenNeedsRegrant` re-grants only within
  `GOTRUE_REGRANT_MARGIN_MS` (120s) of `exp`, **or when `exp` is undecodable**,
  so the fallback is never worse than the behaviour it replaces.
  `fireBearerProbes` returns the initialize status, so a 401 on a token believed
  live invalidates the cache and forces exactly one re-grant — bailing before
  the remaining probes rather than recording three doomed outcomes. A failed
  grant now records an **unexpected** `hosted:bearer:gotrue-grant` outcome while
  still setting `bearerSkipped`; the two together are what let an evidence
  reader tell "did not run" from "failed".
- **Evidence was written once, at the end, outside try/finally.** A 48h soak
  that died in hour 47 wrote nothing. The driver now checkpoints after every
  cycle and again in `finally`, and `runtime.writeEvidenceFile` is **atomic**
  (temp file + `rename()`, POSIX-atomic within a directory) so an interrupted
  write cannot leave a truncated JSON file where the last good checkpoint was.
  The document carries `checkpoint: true` until the final write sets
  `complete: true` — a file left at `checkpoint: true` means the driver died
  mid-soak, which is itself evidence rather than a missing artifact. A failed
  checkpoint logs and continues; it must never abort the soak. **Captured
  bodies are capped at `MAX_CAPTURES_PER_LABEL` (50), budgeted PER LABEL** so a
  noisy branch cannot starve a quiet one, and every body is truncated to
  `CAPTURE_MAX_SNIPPET`. Shedding a body never sheds the OUTCOME — counts,
  statuses and percentiles stay exact, and `mcp.droppedCaptures` reports how
  much body text was elided.
- **Duplication and double work.** `HOSTED_REQUIRED_TOOLS` /
  `HOSTED_NOTE_TOOLS` / `STDIO_REQUIRED_TOOLS` / `STDIO_NOTE_TOOLS` held
  identical contents → one `RENAMED_TOOLS`. `assertToolsList` took four
  positional lists whose optional tails were indistinguishable at the call site
  → a `ToolsListExpectation` options object. `runHostedCycle` evaluated
  `assertToolsList` twice on the same body; the assert callback now carries the
  assertion out, and the null case (unexpected HTTP status, so `assert` never
  ran) is handled explicitly instead of silently re-deriving an empty tool list.
  `callHosted` re-derived driver-core's status rule inline → it calls the
  exported `classifyStatus`. `STDIO_EXPECTED_TOOL_COUNT` was an exported
  derivation nothing read.

**`writeEvidenceFile`'s new third argument is optional and driver-core's
defaults are untouched**, so the other six targeted drivers are unaffected —
verify with `npx vitest run scripts/staging/targeted` (all drivers), not just
the one test file.
