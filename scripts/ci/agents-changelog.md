# scripts/ci — historical change log

Dated per-gate narrative moved out of `agents.md` on 2026-08-01. Entries are the
originals, verbatim; ordering is as-found (roughly newest-first, with some
out-of-order entries preserved rather than re-dated).

The durable gate inventory, conventions, and open work live in
[`./agents.md`](./agents.md).

---

## Recent Changes
- 2026-07-28 SCRUM-3026 (Wave G gate fix, RTE lane): fixed the Staging Soak
  Evidence Gate's stale-checkout bug. `github.sha` and
  `github.event.pull_request.*` are frozen at the triggering webhook
  delivery; a bare rerun (GitHub UI "Re-run jobs", `gh run rerun`, a
  branch-protection re-request, or a Mergify re-check without a new
  delivery) replayed that frozen snapshot, which voided RC-manifest base
  coverage during the 2026-07-27 10-PR wave and hid post-event body edits.
  `.github/workflows/staging-evidence.yml` now runs a `Resolve live PR state`
  step (`id: live_pr`, `gh api repos/.../pulls/<N>`) on every execution;
  checkout pins to the live-resolved merge-preview SHA
  (`steps.live_pr.outputs.checkout_sha`, falling back to the branch head SHA
  if GitHub hasn't computed `merge_commit_sha` yet) instead of the frozen
  `github.sha`, and the evidence-check step's `PR_BODY` / `HEAD_REF_SHA` /
  `BASE_REF_SHA` bind to that step's outputs instead of raw
  `github.event.pull_request.*` values. Mirrors the labels-live-read pattern
  already in `scripts/ci/lib/ciContext.ts` (`fetchLiveLabels` /
  `resolvePrLabels`). `staging-evidence-workflow-contract.test.ts` rewritten
  to pin the new shape and reject every regression back to a frozen-payload
  binding. Added `mint-fresh-event.sh` (+ `.test.sh`, stubbed git/gh, 37
  assertions) — the sanctioned way to force a genuinely fresh PR event
  (tree-identical empty commit + push, optional `PR head SHA:` body bump via
  `gh pr edit`) when a real new event is needed rather than a live re-read of
  the existing one. Runbook: `docs/runbooks/ci/mint-fresh-event.md`. Does not
  weaken any evidence requirement — only makes the inputs to those
  requirements current. NOT merged — T0, PR under review.
- 2026-07-28 Wave 0 item G3 (SCRUM-3032/3033/3034, CTO ruling R14): added
  `check-orphaned-exports.ts` + `.test.ts` (43 tests) — see the file entry
  above. Wired into `ci.yml` as the new `orphaned-export-lint` job. Closes the
  gap that let folders (#1657) and CTDL (#1603) ship a hook/data-layer with
  zero non-test UI importers through every existing gate — green CI and a
  green soak never meant "a user can reach this code".
- 2026-07-28 (same day, PR #1723 adversarial-review follow-up): fixed a HIGH
  defect in `check-orphaned-exports.ts` — diff-scoping ("is this orphan
  NEW?") was decided by whether the export's declaration LINE fell in the
  PR's added-line set, not by export identity. A purely cosmetic reformat of
  an existing orphan's declaration line (line moves, no behavior/importer
  change) flipped it from pre-existing WARN to a hard CI failure; a file
  rename/move would have hit the same bug via `git diff`'s "100% added
  content, no rename detection" artifact. Replaced with identity-based
  classification (`exportIdentityKey`, `buildMergeBaseExportIndex`,
  `findOrphanCandidates`, rename-aware `classifyOrphans` via `parseRenameMap`
  / `git diff --find-renames`) — resolves the export against the merge-base
  version of the same file (or its pre-rename path), regardless of line
  drift. Added 5 regression tests (48 total): cosmetic-reformat-stays-pre-
  existing, genuinely-new-still-fails-closed, control, renamed-file-stays-
  pre-existing, full-pipeline reformat scenario. Also added a `console.warn`
  on `buildRepoGraph`'s per-file parse-error skip (previously silent) and
  documented the `isComponentLikeInitializer` false-positive surface and a
  known INVERSE GAP (deleting a hook's last importer without touching the
  hook's own file is not detected as newly-orphaned) as an explicit follow-up
  rather than attempting a full merge-base reachability rebuild under this
  PR's time-critical Wave G window.
- 2026-07-15 Deploy Worker full-history preflight parity: added
  `deploy-worker-history-contract.test.ts` to require `fetch-depth: 0` before
  the deploy workflow runs history-bound worker tests. The narrow
  `deploy-worker.yml` classifier exemption now also accepts only an additive
  full-history checkout; deletion, `fetch-depth: 1`, mixed runtime edits, and
  unavailable diffs remain T2. Live GitHub Actions consumers that do not inject
  a diff provider (notably Merge Authority) resolve the existing
  `BASE_REF_SHA` and reuse the same per-file diff, preventing a staging-T0 /
  merge-authority-T2 split; tests and non-Actions callers remain fail-closed.
- 2026-07-15 S3.3 Wave-3 deterministic evaluator (SCRUM-2681/2686/2687):
  `check-staging-evidence.ts` classifies only the exact inert
  `services/worker/src/ai/eval/s33-wave3-deterministic-eval-gates.ts` path as
  T0. The exception is conditional on a readable runtime graph with zero
  production importers. Its adjacent test remains test-class T0; sibling names
  remain T2, and any production-runtime reachability immediately restores T2.
- 2026-07-15 S3.3 Wave-3 detached release signing (SCRUM-2777):
  `s33-wave3-detached-signing-v2.ts` exposes `emit-request`,
  `regenerate-request`, `assemble`, and `verify`. `regenerate-request` accepts a
  reviewed versioned public trust-policy set only to replace a retired-key
  unsigned request with the sole active post-cutover key; it does not accept a
  signature or private material. Input is strict JSON, output uses the existing owner-only
  `O_EXCL|O_NOFOLLOW` evidence writer, and no private-key or environment-root
  flag exists. `assemble`/`verify` fail closed while the committed production
  trust policy is `UNCONFIGURED`. The staging classifier grants T0 only to the
  exact CLI/shared-module pair while the production runtime import graph is
  readable and cannot reach them; sibling names and runtime reachability remain
  T2.
- 2026-07-15 S3.3 Wave-2 corpus acceptance (SCRUM-2777/2781/2782):
  `s33-wave2-batch-acceptance.ts` exposes offline `preflight`, authenticated
  `accept`, and exact-tree `consume-merged` commands. It uses trusted-main
  evaluator code, reads candidate content as inert Git objects, and creates one
  owner-only evidence file with `O_EXCL|O_NOFOLLOW`.
  `s33-wave2-github-transport.ts` strictly extracts one marked envelope and
  reconciles its issue-comment/formal-review ids, node ids, URL, timestamp, and
  actor tuple against live GitHub; review state and distinct login are ignored.
  `check-staging-evidence.ts` grants T0 only to the exact new
  registry/acceptor/envelope/transport files and the strict
  `golden-dataset-s33-wave2-<slug>-heldout.ts` producer shape while the worker
  runtime import graph remains readable and cannot reach them; sibling files
  and runtime imports remain T2.
- 2026-07-15 S3.3 trusted-main Worker TSX cwd regression: `s33-wave1-github-evidence.test.ts` now enumerates the exact four Worker CLI targets in `s33-wave1-prerequisites.yml` and the one target in `s33-wave1-acceptance.yml`, requires repository-root-valid `services/worker/src/...` paths, and reads every target from disk. This closes the run-29416344643 class where filename/count assertions passed but `npm --prefix` did not change the shell cwd and `tsx src/...` resolved outside `services/worker`.
- 2026-07-14 S3.3 offline-acceptance T0 classifier (CTO 102498305):
  `check-staging-evidence.ts` grants T0 only to the exact three Wave-1 corpus
  sources plus `golden-dataset-s33-types.ts`, `s33-acceptance-ledger.ts`, and
  `s33-batch-acceptance.ts`. Sibling AI/eval files remain T2. The carveout
  scans production TypeScript/JavaScript imports of those module stems and
  fails closed to T2 if any runtime importer exists or the source tree cannot
  be read. Tests pin the exact #1544 and #1545 sets, sibling rejection, runtime
  import detection, and test/offline-import exclusions.
- 2026-07-08 unsoakable-surface fix (#1411 unblock): added the architecturally-unsoakable evidence mode (above) to `check-staging-evidence.ts` — `isOfflinePackageOnlyChange()` + `T2_UNSOAKABLE_FIELDS` + `hasUnsoakableSurfaceNote()` + `unsoakableT2Errors()`/`unsoakableT2Result()`, wired into `check()` right after the frontend-T2 path (both are the narrow declared-T2 ∧ required-T2 alternate-evidence paths; mutually exclusive predicates). Root cause: the SDK `PATH_RULE` classified offline client packages (`packages/arkova-py`, `sdks/`, `embed`, `mcp-server`, `typescript`, `langchain`) T2, then the gate demanded worker-soak artifacts those offline packages can never produce. `validateResidualRiskNote()` gained an optional `headerRe` param so the note validator is reused for the `### Unsoakable-surface note` (same real-`Approved by:` guard). 21 red-first tests (`isOfflinePackageOnlyChange` predicate matrix + Scenarios 1/1b/2/2b/3a–3i + under-declaration + frontend-exclusion); 202/202 green in the file, 609/609 across `scripts/ci/`. Does NOT touch tier classification (`requiredTierFor` unchanged) and does NOT weaken any worker/migration/served-contract surface.
- 2026-06-24 WEBEXT-04 (SCRUM-2506): added `check-csp-runtime-deps.ts` (+ `.test.ts`, 12 tests) — the CSP↔runtime-deps drift gate the 2026-06-16 §1.6 fail-open regression lacked. Split out of the §1.6 fail-closed OCR PR (#1262) into its own CI-tooling PR so that PR can ride the lighter frontend-T2 evidence path. Parses the DEPLOYED CSP from `vercel.json` and fails closed if (a) `script-src` lacks `'self'`/`'wasm-unsafe-eval'`, (b) `worker-src`/`connect-src` lack `'self'`, or (c) any listed runtime-dep source (`ocrWorker`/`nerPiiDetector`/`enhancedPiiStripper`/`mlRuntime`) references a forbidden CDN host (jsdelivr/unpkg/huggingface.co/tessdata/…) instead of `/vendor`. Comment-stripped so historical notes don't trip it. Override label `csp-runtime-deps-intentional`. Wired into `ci.yml`. Orthogonal to `check-config-drift.ts` (R-5 checks the connect-src allowlist vs RUNNING prod; this checks runtime CODE↔CSP consistency). NOTE: the implicit-default class (e.g. transformers.js' built-in HuggingFace host, no source literal) is Lane 1's NER self-host surface (#1253), not caught by source-scan.
- 2026-06-19 PR #1151 (review fixes): `check-image-scan-gate.ts` gained two assertions over `deploy-worker.yml`'s Trivy step — (6) an explicit OS package-type scope key must be present and correct (`pkg-types: os`, current; `vuln-type: os` deprecated-but-accepted; Grype `only-package-types: os`), so a future action-version rename can't silently disable OS scanning; (7) an auditable operator break-glass must be wired (a `workflow_dispatch` boolean `bypass_image_scan` input + an `if:`-guarded scan step that skips ONLY the scan) AND logged (an audit echo naming `github.actor`). The break-glass is a runtime escape for a Trivy/GHCR vuln-DB outage, NOT a gate-weakening label — severity/fixable/pinning/`pkg-types` stay non-overridable. 6 new tests (15/15 green). Does not trip `check-deploy-lint-parity.ts` (no `working-directory: services/worker`, no "lint" in the step name).
- 2026-06-09 release queue fix: base movement no longer automatically invalidates T2/T3 soak evidence. `check-staging-evidence.ts` now classifies the diff between the evidence `Base SHA:` and current base. T0 docs/tests/CI/tooling-only drift can preserve evidence only with an approved `Base drift impact:` line; runtime/schema/migration/staging/deploy drift fails closed. Exact PR head SHA integrity remains unchanged.
- 2026-06-08 release queue rescue: added RC manifest coverage to `check-staging-evidence.ts` while preserving the `Staging Soak Evidence Gate` required check name. Valid manifests live under `docs/staging/rc-manifests/rc-*.json` and must prove exact head/base or train coverage, release approval, clean preflight, deploy provenance, unexpired soak evidence, and migration rollback/reapply proof.
- 2026-06-01 PR #1051: documented the frontend-T2 evidence mode (above) and closed a MEDIUM gap in `frontendT2Errors()` — `CI/E2E green:` was value-checked only by `validatePassingEvidenceField`, which short-circuits to PASS on an empty value, so a bare `- CI/E2E green:` line passed (weaker than the T1 path). Added `validateNonEmptyEvidenceField(body, 'CI/E2E green:')` before the passing-pattern test, mirroring T1. Regression test `Scenario 3i` (empty value → FAILS). 113/113 green; existing passing cases unchanged.
- 2026-06-03 queue hygiene: corrected T1 from zero-soak to 2h minimum with required `Soak start:` / `Soak end:` fields, and explicitly classified load-test tooling (`services/worker/scripts/load-test/`, `tests/k6/`, `tests/load/`) as T0.
- 2026-05-30 SCRUM-2149/2148: hardened `scripts/check-copy-terms.ts` (coverage → src/lib + src/hooks + packages/embed/src; §1.3 term parity testnet/mainnet/utxo/broadcast; structural false-positive filter; raw DB-enum render heuristic) and added `snapshots/copy-terms-baseline.json` (14 grandfathered pre-existing violations). 33 new unit tests; `lint:copy` green via at-source fixes + baseline.
- 2026-05-30 PR #867: refreshed `snapshots/prod-tables.json` after prod 0326 added `org_credit_deductions`.
- 2026-05-30 PR #980: closed two defense-in-depth gaps in `check-staging-evidence.ts` — T2/T3 deploy-evidence fields are now value-checked (not just label-present), and the residual-risk `Approved by:` must name a real approver. T1 logic unchanged; no existing check loosened. 14 new tests (90/90 green).
- 2026-05-26 PR #884: added `services/edge/package.json` to staging-tooling allowlist (edge-only, not worker).

- 2026-06-17 S0-E4 (epic SCRUM-2313; story S0-4.2 reuses SCRUM-2500): added `check-ledger-numeric-integrity.ts` (full-ledger numeric-integrity audit — local-file grammar pass runs network-free in ci.yml; prod-ledger pass runs in `migration-drift.yml` over the already-fetched payload; injected-timestamp row fails) + `check-agents-md-migration-collision.ts` (S0-4.3; enforces unique `## Recent migrations (…)` headers per CLAUDE.md §6) + `compute-merge-authority.ts` (S0-4.3; reuses `requiredTierFor`, emits council/needs-carson, fails closed). All three registered in `STAGING_TOOLING_ALLOW` so they classify T0. 23 new tests. NOT merged — T2/T3 actions (prod exemption removal, branch-protection/Mergify apply) gated to Carson; see Google Doc "ARKOVA PI-1 S0-E4 — Refinement, Planning, Pre-Mortem, Code Review & Retro" (Drive ARKOVA PI-1-S0): https://docs.google.com/document/d/1nFgOufZNenCHLBG3JKRX__iKhQ3nZTs8YiyFye4k-30/edit

- 2026-06-22 S1.5 (PI-0 Lane 1 / CHAIN-RESIL): added `config-drift/providerSpof.ts` + `providerSpof.test.ts` (11 tests) and wired it into `check-config-drift.ts` main() — the config-drift README item-#6 provider-SPOF. Parses the real `config.ts` default (`mempool`) vs `deploy-worker.yml` override (`getblock`): a dropped/wrong `BITCOIN_UTXO_PROVIDER` fails CI, a latent code-default divergence warns (non-blocking). Mitigates R-4 / PM-L-DRIFT / the 2026-05-30 mempool↔GetBlock audit finding. Detection-only (no chain/config behavior change). NOT merged — T1, PR/merge gated.
- 2026-06-23 S1-10 (PI-0 Sprint 1 Lane 2 / config-drift parity, Lane-2 half): added `config-drift/flagSpof.ts` + `flagSpof.test.ts` (13 tests) and wired it into `check-config-drift.ts` main() — the config-drift README item-#5 env↔DB flag fail-open SPOF. Parses the real `deploy-worker.yml --set-env-vars` flags + the real `flagRegistry.ts` `DB_FLAGS` list: a flag asserted effective=`false` but env=`true` AND DB-backed (`flagRegistry` falls back to the env var when the `switchboard_flags` row is absent → fails OPEN — the 2026-05-30 class) is a `fail-open-flag`; asserted-OFF/env-ON with no DB guard is `env-flag-on-no-db-guard`; a launch-required flag (`launchRequiredFlags`, e.g. `ENABLE_AI_EXTRACTION`) set false/omitted is `launch-flag-off`. Two-tier (mirrors providerSpof): a flag in the manifest's `acknowledgedFailOpenFlags` warns (non-blocking — known, DB-guarded-today, deploy fix is T3/Carson); a NEW unacknowledged fail-open, or any launch-flag-off / no-db-guard, fails CI. Manifest gained `launchRequiredFlags` + `acknowledgedFailOpenFlags` (the live `ENABLE_SEMANTIC_SEARCH`/`ENABLE_AI_FRAUD` env=true vs asserted-OFF are acknowledged → gate green at rest, hazard auditable, regression guard live). CSP-vs-runtime-deps is WEBEXT-04's `check-csp-runtime-deps.ts` (#1262) — not duplicated; this gate keeps the bidirectional CSP connect-src dimension. Read-only against config; detection-only. NOT merged — T1, draft PR/merge gated.
- 2026-07-07 path-aware base-drift gate (`ci/path-aware-drift-gate`): replaced the SHA-exact / T0-only base-drift wall in `check-staging-evidence.ts` with a **surface-intersection** test. `baseDriftImpactErrors` now computes the intervening main-drift files and intersects them with THIS PR's soak surface (its own changed files ∪ the new exported `SHARED_PROD_RUNTIME_RULES` = the T2+ subset of `PATH_RULES`). Disjoint drift preserves evidence with no `Base drift impact:` attestation (removes the false-positive re-soaks the old wall caused for orthogonal main movement); same-surface drift fails closed (re-soak), with the T0-only intersecting case kept as a strictly-narrower attestation fallback so no currently-passing PR regresses; unresolvable drift-file list fails closed. Surgical: same call-graph (`stagingIntegrityErrors → baseShaEvidenceErrors → baseDriftImpactErrors`); `opts.files` threaded down through `standardEvidenceErrors`/`stagingIntegrityErrors`; no workflow YAML change (`staging-evidence.yml` already exports BASE_REF_SHA/HEAD_REF_SHA + fetch-depth:0). +12 new tests (orthogonal→pass, same-file→fail, migration/chain/queue/cron shared-runtime→fail, T0/docs→pass, T0-own-file attestation fallback, fail-closed). T0 (tooling-only). NOT merged — draft PR.
- 2026-07-10 L2-S0 (Sprint 3.3): added `check-429-limiter-map.test.ts` — drift lint for `docs/staging/429-limiter-map-s33.md` (the five-bucket 429 attribution map, CTO memo R2 exit criterion 3a). Parses the map's machine-readable `Claims ledger` table (33 `file:line → must-contain` rows covering every 429 emitter: anon/keyed/ai/batch/credits limiters, usageTracking monthly quota, rules-crud + account-export bespoke 429s, perOrgRateLimit + x402 dead code, gemini.ts upstream-429 blocks, fallback-chain misclassification lines, rateLimit.ts identical-body/header/log-key lines) and fails when the tree drifts. Also asserts the two structural claims stay true (perOrgRateLimit still UNMOUNTED; x402 payer limiter still an orphan — zero non-test consumers), so mounting either forces a map + attribution-spec revision. Pure vitest (no standalone script), runs via the root `scripts/**/*.test.ts` include. Red-first: seen failing before the map existed. NOT merged — T0 draft PR.

- 2026-07-10 L2-S1 (Sprint 3.3): added `check-s33-sequencing-gate.ts` + `.test.ts` (15 red-first tests, mocked `gh` output) — the rig-day sequencing refusal. Enumerates open PRs via `gh pr list --json number,title,isDraft,files` and BLOCKS the S3.3 isolated-rig window while (1) any open PR is DB-mutating — classification derives from `check-staging-evidence.ts` `PATH_RULES` (the supabase rules) plus the schema artifacts that ride a migration (`supabase/seed.sql`, both `database.types.ts`, `scripts/staging/migrations/`) so it can never drift from the tier detector; an unmerged migration makes a freshly-replayed rig schema stale on arrival — or (2) prod cannot be shown green: the prod probe is an explicit-assertion STUB (`S33_PROD_GREEN=true|false`; anything else = `unknown`) and the gate FAILS CLOSED on unknown. Read-only (no rig/Supabase/Cloud Run contact); malformed `gh` output throws rather than passing. Follow-up: wire the real prod-green probe + call this from `provision-isolated-rig.sh --apply` as a preflight refusal. NOT merged — T0 draft PR.

- 2026-07-21 SCRUM-2897 (PI-0.5 RTE slice): added `check-evidence-identity.ts` + `.test.ts` (20 red-first tests) — the evidence-identity gate. Two identity invariants on a **Ready, soak-tier** PR: (A) `head-sha-identity` — the `PR head SHA:` declared in the Staging Soak Evidence block must equal the ACTUAL PR head SHA (short-SHA prefix match allowed); a commit pushed after the evidence was written silently invalidates the exact-head soak (feedback_pr_head_sha_in_evidence_block). (B) `clean-preflight-identity` — `Preflight result:` must declare `environment_type=clean_mirror` for T2/T3, and any head SHA embedded in the preflight must match the declared head (evidence may not be copied across heads, CLAUDE.md §1.11A). Drafts and T0 / no-evidence PRs are skipped. Self-contained (re-implements the checkbox-tolerant `extractField`/`extractShaFromField`/`isCleanMirror` helpers rather than importing `check-staging-evidence.ts`, to avoid coupling). Reads PR context from `PR_BODY`/`PR_HEAD_SHA`/`PR_IS_DRAFT` env. **Wired into `ci.yml` as `evidence-identity-report`, REPORT-ONLY** per the W3-freeze CTO carve-out (`--report-only` → always exit 0, `::warning::` not `::error::`, plus `continue-on-error`; runs only on `pull_request` events). Fail-closed activation deferred until ≥1 real green soak calibrates it (#1617 precedent). NOT merged — T0 draft PR, `do-not-merge`, freeze-held.

- 2026-07-28 union-drop backstop: added `check-agents-md-append-only.ts` + `.test.ts` (7 red-first tests), wired into `ci.yml` (`dependency-scan` job — it already checks out `fetch-depth: 0`, which `merge-base` needs). Root cause it backstops: a local `merge.union.driver = true` in `.git/config` shadowed git's BUILT-IN union algorithm that `.gitattributes` requests for ~200 `agents.md` files; `true` writes no merged content and exits 0, so git recorded clean merges while silently discarding all of "theirs". Local config is invisible to CI, so this gate is deliberately **cause-agnostic**: `agents.md` is append-only, therefore a line present in `merge-base(base, head)` but absent at head is content the branch DELETES from main on merge. In-place edits are matched back to their base line, each surviving line accounting for at most ONE vanished line (without that 1:1 cap a single unrelated addition could absorb every deletion in the file). A KEYED entry matches on its key alone and never falls back to prose scoring: agents.md documents things as "key, then prose about it" in two shapes — a table row keyed by its first cell, and a bullet keyed by a leading bold/code name (`- **requireOrgId.ts** — …`) — and both get their prose rewritten wholesale while the entry plainly still exists. Everything else matches on a long shared PREFIX (≥40 chars and ≥50% of the base line) or else CONTAINMENT: the share of the base line's words still present in the candidate, ≥0.75, with a ≥5-word floor. Containment is deliberately asymmetric — Jaccard divides by the union, so enlarging a line pushes its score DOWN and a heavily-extended line reads as a deletion, which is backwards for an append-only invariant where the only question is whether the original content survives. That mis-scoring produced live false positives on PRs #1736 (extended `FileUpload.tsx` bullet), #1749 (`requireOrgId.ts` prose rewrite) and #1755 (`GPL/AGPL/SSPL` → `GPL/AGPL/LGPL/SSPL`). There is deliberately NO length-growth cap — appending a long explanation to an existing line is a normal edit (#1755 grew one ~7x); the word floor, not a growth cap, is what stops a short line from matching any long line containing its words. Comparison is only ever against head lines that are NEW relative to base; comparing against unchanged lines would let a neighbouring row mask a real deletion. Validated against all 36 open PRs: 34 pass and only #1618/#1652 fail, both on genuine drops. File selection is `git diff --name-only base head` (not a full `ls-tree`), so it reads only the agents.md files a PR actually touched — ~0.2s per run instead of ~400 `git show` subprocesses. Override label `agents-md-deletion-approved` for deliberate consolidation; skips cleanly when there is no PR base. Companion session-start guard: `scripts/agent/check-git-merge-config.sh`. T0 (CI tooling only).
- 2026-07-28 ci.yml commit-message heredoc injection (follow-up to PR #1724): the `Aggregate commit messages` step (`id: commits`) framed `git log --format=%B` output — fully PR-author-controlled — inside a heredoc with the fixed literal delimiter `EOF`. A commit message containing `EOF` on its own line terminated the heredoc early; the remainder was parsed as literal `key=value` lines appended to `$GITHUB_OUTPUT`, letting an author forge a duplicate `msgs=` that wins by last-occurrence resolution. `msgs` feeds `PR_COMMITS_MSGS` into `check-handoff-claims.ts` and `check-confluence-coverage.ts` in the same job, so the forgery steered what both governance gates believed the PR's commit history said. Fixed with a per-run random delimiter (`MSGS_DELIM="ghadelim_$(openssl rand -hex 16)"`), GitHub's documented remedy and the same fix PR #1724 applied to `staging-evidence.yml`'s PR-body heredoc. Verified empirically against a model of the Actions output parser: with the fixed delimiter a crafted message replaced `msgs` wholesale; with the random delimiter the identical payload remains inert text inside the real message. Pinned by the new `ci-workflow-contract.test.ts` (8 red-first tests). T0 (ci.yml is in `STAGING_TOOLING_ALLOW`; only workflow + test + agents.md touched).
