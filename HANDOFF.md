# HANDOFF.md — Arkova Living State Snapshot

> **Purpose:** Current state of the project. Updated at the end of every session. Kept ≤150 lines — anything older goes to git log or the archive.
>
> **Source-of-truth layering (2026-04-21):**
> - **Jira** = story status, scope, acceptance criteria → https://arkova.atlassian.net/jira/software/projects/SCRUM
> - **Confluence** (space "A") = topic docs + per-epic audit pages → https://arkova.atlassian.net/wiki/spaces/A
> - **Bug tracker** = Confluence [Master Log](https://arkova.atlassian.net/wiki/spaces/A/pages/28115270) (canonical since 2026-04-26; the Google Sheet is historical archive only)
> - **HANDOFF.md** (this file) = rolling snapshot of *now*, not history
> - **CLAUDE.md** = directive / rules
> - **git log** = what changed, by whom, when

---

## Now

### 2026-06-29 (Lane 2 S2) — queue-first loop consumer + FE-PROOF-GATE built; 4 draft PRs open for review

Lane-2 PI-0 Sprint-2 driven to **build-complete** (this session's PRs only; #1260 + other carryover are prior-session, out of scope). Ceremonies (refinement/planning/pre-mortem) + the full gate run executed. **Nothing merged by Claude; no prod/schema/soak state changed.** Plans + close-out in Drive `ARKOVA PI-0-S2`.

**4 draft PRs (all TDD-green, NO migration, flags default-OFF, off the proof/chain runtime per the soak-window guard):**
- **#1364 FE-PROOF-GATE** (SCRUM-2501, T2, launch-blocker gate #2): fixes the live bug where `hasPublicVerificationProof` gated the proof DOWNLOAD as SECURED||REVOKED||EXPIRED||SUPERSEDED. New `isProofDownloadable`=SECURED-only gates `VerifierProofDownload`; badge from `getStatusDisplay`; FIX-1 flag `ENABLE_PROOF_PDF_DOWNLOAD` (OFF) gates the PDF download until the staging round-trip E2E (waits on Lane-1 #1354). 18/18.
- **#1366 QUEUE-06 + QUEUE-05** (SCRUM-2352 T3 / 2351 T2): `connector_artifact` drain consumer (Cloud Scheduler → `/jobs/drain-connector-artifacts`), exactly-once via a compare-and-set claim, charge-at-securing ONLY via `debit_and_enqueue_anchor` (0341), flag `ENABLE_CONNECTOR_ARTIFACT_DRAIN` (OFF). Owner-inclusive manual-run guard (canonical `isCallerOrgAdminResult`, fail-closed). **F-1 stuck-row reaper added** (lease/visibility-timeout re-queues stranded processing|materialized rows + status-guarded transitions) — confirmed an uncovered gap (anchor monitors don't see pre-materialize rows; no backlog story). Drain 15/15 + QUEUE-05 suite green.
- **#1365 QUEUE-07** (SCRUM-2353, T2): daily queue digest on `queue-reminders.ts` — counts/aged/failed-connector/action links, audit-backed prefs/suppression/retry, org/sub-org scope, typed `assertNoRawContent` guard (§1.6). 35/35.

**Gates:** /code-review (4 findings) → /debug (F-2 owner-actor lookup verified prod-safe + consistent with `rule-action-dispatcher` precedent → no change) → /tla-precheck PASS (no `.machine.ts` touched; anchor PENDING→BROADCASTING only via the verified `debit_and_enqueue_anchor` RPC) → RTE check-in → final pre-mortem.

**OPEN DEPENDENCY (RTE-owned, launch-blocker for the connector loop):** **mig 0343 (`connector_artifact`, #1259) is NOT in prod** — prod ledger jumps 0342→0345 (0345-0348 applied out-of-band; the #1346 prod-ahead-guard class). Safe today ONLY because the connector flags (QUEUE-06 drain + DS-03 producer) are OFF; 0343 must be prod-applied **before** any connector flag flips, with a §0-rule-10 ledger reconcile (prod already at 0348). 0344 correctly absent (renumbered to 0349 under open #1260).

_Verified via: `gh pr create` #1364/#1365/#1366 (open draft); local `vitest run` (FE 18/18; drain 15/15; QUEUE-07 35/35) + `tsc --noEmit` 0 + `lint:copy`/`lint --max-warnings 0` clean; prod ledger head 0348 + 0343 absent via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye`. No prod/schema/soak state changed; nothing merged by Claude._

### 2026-06-29 (PI-0 Sprint 2 kickoff — ART/cross-lane) — S1→S2 production wave (28 PRs merged 06-27→06-29); S2 planned; prod on 0348 / worker 70b50223

**Prod truth (read-only, 2026-06-29):** worker `git_sha 70b50223`, `/health` healthy (mainnet; db/anchoring/kms ok), deployed by deploy-worker run 28400817406 (2026-06-29T20:32:56Z). Migration ledger head **0348** (`0348_webhook_event_claims`); 0345/0346/0347/0348 present, **0343 NOT in prod** (see Lane-2 entry — launch-blocker dependency). Flags AI_EXTRACTION / VERIFICATION_API / PROD_NETWORK_ANCHORING = true; no connector-drain/enqueue flag in prod env.

**28 PRs merged to main 06-27→06-29** (origin/main `d9773a64`):
- **Owner-resolution-drift fix (06-29):** #1325 (compliance Audit-My-Org owner gate) + #1326 (12 org gates routed through the canonical owner-inclusive resolver) — the 06-27 mapped CLASS, now MERGED (supersedes the 2026-06-27 entry's "#1325 DRAFT").
- **Lane-1 proof (gate #2):** #1320 PROOF-03 confirmation-proof LIVE via backfill cron (06-28); #1349 independent-node confirm; #1352 PROOF-04 (PDF embeds proof JSON); #1353 reference verifier CLI v0.1 (`@arkova/verifier` / `-cli`); #1357 PROOF-08 fixtures. **Soaking T2:** #1354 PROOF-05 `proof_bundle` API + #1350 PROOF-06 signed-DID (FE-PROOF-GATE contract frozen on main `docs/lane1/fe-proof-gate-contract-s2.md`). Carryover: #1307 reorg/legal-hold (merged, mig 0347); #1293 verifyFingerprint decode (DRAFT; re-soak → merges 06-30 23:12Z, C-suite residual-risk); #1281 backfill (gated dry-run).
- **Chain/credit/CI hardening:** #1300 UTXO fee; #1298 batch-extraction credit accounting; #1291 Gemini-parse §1.6; #1269 Stripe-Identity entitlement (PAY-01); #1317 Stripe-503 (mig 0348); #1257 CPE/CLE indexes (mig 0342); #1286 embed perf (mig 0345); #1342 deploy-gate typecheck unblock; #1346 prod-ahead ledger guard; #1338 prod-tables snapshot.

**S2 planned (06-29):** ART Founders' Report + Lane-1/Lane-2 plans filed in Drive `ARKOVA PI-0-S2` (Lane-3 plan embedded; standalone doc expected day-1). RTE cross-lane brief = Program Board comment 91783169 (soak-window guard; contract on main; head 0348 / 0349=#1260 / next-free 0350; own-rig isolation; Lane-2 single scheduler owner). Critical path: Lane-3 producers (DS-04/Drive) → `connector_artifact` (0343) → Lane-2 QUEUE-06 consumer → SECURED → Lane-1 proof bundle → verifier.

_Verified via: `gh pr list --search "merged:>=2026-06-27"` + `git log origin/main` (28 merges; HEAD `d9773a64`); prod `/health` `70b50223` + `gcloud run services describe arkova-worker` + deploy run 28400817406; Supabase MCP `list_migrations`/`execute_sql` on `vzwyaatejekddvltxyye` (head 0348; 0343 absent; flags); Drive `ARKOVA PI-0-S2` + Confluence 85622786 comment 91783169._

### 2026-06-27 (RTE/RM) — Compliance "Audit My Organization" owner-org gate fixed (PR #1325, DRAFT, T2) + owner-resolution-drift CLASS mapped (11 more worker gates)

**Reported P1 (prod UAT 2026-06-24):** org OWNERS got `403 "Must belong to an organization"` clicking **Audit My Organization**. Root cause: `services/worker/src/compliance/auth-helpers.ts` `getCallerOrgId` resolved org via `org_members` ONLY; owners are linked via `profiles.org_id` (the "Managing X" header source) and aren't guaranteed an `org_members` 'owner' row. **Fix → PR #1325 (DRAFT, T2):** resolve `profiles.org_id` first (delegated to canonical `api/_org-auth.ts`), `org_members` fallback via `limit(1).maybeSingle()` (also closes a latent `.single()` crash-to-403 for 2+ org users). Single chokepoint → fixes all 7 compliance routes. 8 unit tests; full worker suite green (478/6491). **NOT merged, soak PENDING** (T2 12h on clean `arkova-staging`; plan in PR body). Was a **prior-session orphan** (identical local commit, never pushed/PR'd — the literal "fell through" failure); now durably #1325.

**Owner-resolution-drift CLASS (6-specialist sweep):** the compliance gate is **1 of ~12**. ~11 MORE worker gates re-resolve org from `org_members` → 403 owners: `signatures.ts` (152 create / 597 list), `signatureCompliance.ts` (74/129/170/215 — SOC2/eIDAS exports), `grc.ts:120`, `complianceTrends.ts:39`, `auditBatchVerify.ts:67`, `key-inventory.ts:100`, `integrations/docusign-member-oauth.ts:226`; + admin-check family (`docusign-oauth`/`drive-oauth`/`issuer-partnerships`) + frontend `OrgProfilePage.tsx:140`. (`agents.ts:44` SAFE — uses profiles.org_id.) **Prod blast radius = 0 today** (read-only prod COUNTs): every current owner has a matching `org_members` row (onboarding RPC writes both in one txn) → LATENT class bug, not an active outage; no backfill (recommend a drift-detection cron).

**NEXT — PR2 (class fix, NOT started):** route the 11 gates through `_org-auth` (`getCallerOrgId` + `isCallerOrgAdmin`, which already has the owner/ORG_ADMIN/platform-admin fallback) + a reusable "owner-no-org_members-row" fixture + a parametrized contract test (owner→2xx, member→2xx, multi-org→2xx, orphan→403, unauth→401) + an ESLint guard forbidding `org_members`-as-primary org resolution. T2.

**BLOCKED — Atlassian MCP connector invalidated:** could NOT file the Jira epic/stories or Confluence Bug-tracker rows this session. Needs Carson to reconnect; then RTE files epic "Org-owner eligibility resolution drift" + children (compliance [#1325] / 11-gate sweep / admin-check / frontend / eslint+cron) + Master-Log rows.

_Verified via: PR #1325 open/draft (`gh pr view 1325`); code analysis on branch `fix/scrum-compliance-audit-owner-org-gate` @ `85279d2b` (file:line cited); full worker `vitest run` 478 files/6491 tests green + `eslint --max-warnings 0` + `tsc` clean; prod blast-radius from read-only `execute_sql` COUNT aggregates on `vzwyaatejekddvltxyye` (0 users with profiles.org_id set lacking the matching org_members row). No prod/staging state changed; no migration; nothing merged._

### 2026-06-26 (Lane 3 SM/RTE) — PI-0 S1 CLOSED: all 5 Lane-3 stories merged; producer-before-consumer guard caught a launch-blocker

- **DS-01 (SCRUM-2361) + DS-02 (SCRUM-2362):** merged #1284, **live + verified in prod** (worker git_sha `b96c6836`, `/health` healthy db/anchoring/kms ok). Verified-only + suspended-org DocuSign connect gate; HMAC/nonce webhook contract; §1.6A no-PII-leak. → Jira Done.
- **CE-02 (SCRUM-2373) + CE-05 (SCRUM-2376):** merged #1285, live in prod (CE flag off → the fabricated-CTID fail-closed guard is additive/dormant; SM runtime smoke is ops tooling). → Jira Done.
- **DS-03 (SCRUM-2363):** producer merged **DORMANT** via #1321 (rebased clean from auto-closed #1283 — GitHub won't reopen a deleted-base PR). `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` **unset in prod → inert** (verified via `gcloud run services describe arkova-worker`). **NOT done** → Jira Blocked: go-live waits on the connector_artifact CONSUMER (QUEUE-06/SCRUM-2352 daily drain + QUEUE-08/SCRUM-2354 instant) + a both-sides sustained soak (sprint-2/3) before the flag flips. Board blocks-links live.
- **Launch-blocker caught + closed:** the drain that takes connector_artifact `pending → anchored` does not exist yet (DS-03 is the producer half; 0343 ships the table + enqueue RPC only). Unguarded into the live DocuSign webhook it would pile up `pending` rows nothing secures. The enqueue guard (default off) + the blocks-links prevent it. New standard codified in `memory/feedback_soak_evidence_standard.md`: a producer/consumer soak must drive BOTH sides under sustained load with bounded queue depth — a one-shot burst + idle-worker uptime is not a soak (it's what surfaced this).
- **Process scars:** isolated-rig soaks MUST deploy via canonical `scripts/staging/deploy.sh` (the Staging Soak Evidence Gate needs the auditable `staging_deploy_log` id); direct-`gcloud` deploys yield gate-invalid evidence (cost a same-day re-home). Soak rigs torn down — ds0102/ce/ds03 Cloud Run deleted; Supabase rigs `bouiinieoaxjssbznmzq` / `ancgydqkmlgwzwzpyplf` / `yctvbsdejbkeivfeexoc` flagged for dashboard delete.

### 2026-06-24 (Lane 2 RTE) — 0341 credit-integrity reconciliation: prod-proven, landing on `main` via PR #1290 (§1.12 exception)

**0341 reconciliation — prod-proven (applied to prod, running healthy all sprint), landed on `main` via this PR under a Carson-approved §1.12 prod-proven residual-risk exception (2026-06-24); sequenced after #1255 (0340), before #1257/#1259/#1260 (0342/0343/0344).** `main` head was `0339`; prod (`vzwyaatejekddvltxyye`) ledger head is `0341` (rows 0340 + 0341 present), so `main` was missing 0340 (lands via Train-D #1255) + 0341 (this PR). This PR carries the **FIXED** version (HEAD `cc440bd2` "fix(0341): drop old amount>0 CHECK before sign-flip UPDATE (ERROR 23514)") — making `main` reflect already-applied prod state. **Confirmation, not discovery; no new prod change** (all prod queries read-only).

**Prod-proven facts (read-only MCP on `vzwyaatejekddvltxyye`, 2026-06-24):**
- `list_migrations` + `schema_migrations` → ledger rows `0340` + `0341` present (both numeric `version`).
- `org_credit_deductions_amount_signed_check` present with signed semantics: `CHECK ((amount <> 0) AND (entry_type<>'DEBIT' OR amount<0) AND (entry_type<>'REFUND' OR amount>0) AND (entry_type<>'GRANT' OR amount>0) AND (entry_type<>'REVOKE' OR amount<0))`; the old `org_credit_deductions_amount_check (amount>0)` is **gone** (`pg_constraint` count = 0).
- `debit_and_enqueue_anchor(uuid,uuid,integer,text,anchor_status,anchor_status)` RPC present (`pg_proc` count = 1); append-only trigger `trg_org_credit_deductions_append_only` (BEFORE DELETE OR UPDATE → `reject_org_credit_deduction_mutation()`) present.

**Clean-apply prod-mirror validation (§1.12 exception evidence):** throwaway Supabase project `arkova-val-0341` (ref `expjtjcpqfrcspljptpv`, us-east-2, org `byhkazrpmivhcsuqjtva`) — branch migrations applied schema-only (no worker), then the credit objects diffed vs prod read-only. See the PR Staging Soak Evidence block for the diff-empty proof + throwaway teardown. (No worker/Cloud Run; schema-only.)

_Verified via: Supabase MCP `list_migrations` + `execute_sql` (read-only) on prod `vzwyaatejekddvltxyye` (ledger rows 0340/0341; signed CHECK def; old amount>0 CHECK count=0; `debit_and_enqueue_anchor` count=1; append-only trigger def); throwaway-rig apply + credit-object diff on `expjtjcpqfrcspljptpv`. Source bytes: `git show <fixed-branch>:supabase/migrations/0341_*.sql` (HEAD cc440bd2), md5 `861c323315249a3dc2c6900371bc516b`, 25007 B._

### 2026-06-24 (Lane 1 SM/RTE) — WEBEXT producer fixed (4.2.0 skew) + staging-gate gap closed (#1289); SCRUM-2471 confirmed already in #1255; backfill→S3

**WEBEXT-CSP #1253 (producer):** fixed the transformers.js vendored-bundle skew (4.1.0→**4.2.0**, now == npm dep == lockfile; + a version-assert test + a runtime version-skew guard) and scoped the §1.6 claims to producer-only (the fail-CLOSED consumer is Lane-2 **#1262**). Verified the Vercel preview serves the 4.2.0 lib bundle (431,652 B) + the integrity-locked 108 MB model **same-origin** under CSP. Base-refreshed onto main (head `e2b6a3c9`) → DIRTY + Policy-Lints cleared.

**Staging-gate gap + fix (#1289 / WEBEXT-05):** #1253 (frontend §1.6 surface + build-wiring `scripts/`+`package.json`) fit neither the frontend-T2 fast-path (frontend-only files) nor the worker-evidence path (no worker) → unsatisfiable as-shaped. Fix = a **narrow, purely-additive** extension to `isFrontendOnlyChange` (root `package.json`/`package-lock.json`/`.gitignore` + top-level `fetch-*`/`vendor-*`/`*-weights.lock` build scripts; governance subtrees `scripts/{ci,staging,agent,…}` explicitly denied). **156 gate tests, 0 regressions / 3,323 files**, T0. PR [#1289](https://github.com/carson-see/ArkovaCarson/pull/1289) OPEN (CI settling → Mergify auto-merges T0). Diff verified safe (root-anchored regexes — `services/worker/package.json` can't match; denylist wins).

**Merge ordering (enforced):** #1289 (gate) → #1253 (producer) → **#1262 (consumer)** — never #1262 before #1253 (a #1262-first merge = NER can't load under prod CSP → fail-closed → upload outage). After #1289 lands, #1253 base-refreshes onto it → frontend-T2 evidence → co-merge #1253-first with #1262.

**SCRUM-2471 (persist customer-doc Merkle branch):** NOT missing / NOT a future-sprint gap — **already implemented in #1255** (`persistBatchAnchorProofs()`, all anchor paths). Jira ticket stale (unscheduled); the back-catalogue of ~2.97M existing anchors is **S3 PROOF-BACKCATALOG** (oldest anchors' leaf-order unrecoverable → re-anchor / cohort-trigger design call). #1281 backfill held → S3 (overlaps #1255's `proof-branch-backfill.ts`).

**On the clock:** #1255 foundation soak → ~06-24 22:00Z; #1254 PROOF-03 → ~06-25 ~11:46Z. #1280 (S1.2b flag-bit consumption check) draft, folds into #1254 at its merge-prep.

_Verified via: gh pr/api on #1289 (open, head `7618804`, Staging gate=success/T0, 156-test gate suite green) + #1253 (head `e2b6a3c9`, DIRTY+Policy-Lints cleared); `git diff 3c23fb96..e2b6a3c9` (WEBEXT files byte-identical); authenticated Vercel-preview curl (`/vendor/transformers.web.min.js` 200, 431,652 B, self-version 4.2.0; `/models/Xenova/bert-base-NER/onnx/model_quantized.onnx` 200, 108,952,255 B); `git show origin/feat/train-d-proof-foundation:services/worker/src/jobs/batch-anchor.ts` (persistBatchAnchorProofs / SCRUM-2471)._

### 2026-06-24 (Lane 3) — PI-0 S1 connector materialization + CE honesty: code-complete, 3 PRs open, in-review (NOT merged, no prod change)

Lane 3 (Credential Network & Intelligence) PI-0 Sprint 1 driven to **code-complete + in-PR** (refinement·planning·pre-mortem → parallel specialist build → /code-review·/debug·/deploy-checklist·/tla-precheck·release pre-mortem). **No prod/staging/schema/soak state changed; nothing merged by Claude.**

**3 draft PRs (cut off `ef61d735`):** **#1283 DS-03** (T3, **stacked on #1259**/mig 0343) — server-side SHA-256 over fetched DocuSign bytes (fetch→hash→discard §1.6A) → durable idempotent `connector_artifact` via the 0343 `enqueue_connector_artifact` RPC, fail-closed, `source_timestamp` plumbed end-to-end; **#1284 DS-01/02** (T2) — verified+**not-suspended** connect gate + mutation-verified no-PII-leak; **#1285 CE-02/05** (T2/T1) — fail-closed fabricated-CTID guard + Secret-Manager smoke.

**Green:** worker **6464** + frontend **3063** tests pass (only the pre-existing env-gated `zk-proof.test.ts` fails — needs `build:circuit`); `tsc --noEmit` 0, `eslint --max-warnings 0`, `lint:copy` clean. `/code-review` (adversarial) found 1 must-fix — worker/UI verified-org gate parity, a suspended-but-VERIFIED org could connect via direct `/oauth/start`; **fixed `6e686cf7`** + flagged the sub-org parent-approval *direction* for Carson. `/debug` confirmed DS-03 is exactly-once under concurrent duplicate delivery (0343 unique idx + ON CONFLICT + fail-closed). **0 machine files touched** → no TLA change (tla-precheck CLI has a pre-existing TS-6.0 incompat → tooling ticket).

**Jira/docs:** 9 work-breakdown subtasks (SCRUM-2560..2568) under SCRUM-2361/2362/2363/2373/2376; ceremony page Confluence **88211458** (child of Lane-3 PI 85491717); Drive plan + Lane-3 S1 report in `ARKOVA PI-0-S1`; refinement/review/decision comments on the stories + epics 2329/2331.

**PENDING (gated, not faked):** the **DS-03 T3 48h soak** (clean isolated rig + PR-image deploy = RTE/operator step — not started); **Carson T2/T3 merges** via Mergify on green + soak evidence. Connector→SECURED→Lane-1-proof E2E is **S3/S4** (OPS-02). Local `stripe` refreshed 22.1.1→**22.2.1** (lockfile pin) so local `tsc` is clean; CI unaffected (`npm ci`).

_Last refreshed: 2026-06-24 by Claude (Lane-3 SM) — claims verified against: `gh pr` (#1283/#1284/#1285 open draft; #1259 = the 0343 base, open draft); local `vitest run` (worker 6464 / frontend 3063 pass) + `tsc --noEmit` (0) + `eslint`/`lint:copy`; Jira subtask creates SCRUM-2560..2568 + parent read-back; Confluence 88211458 + Drive create responses. No prod/staging/schema/soak state changed; no PR merged by Claude._

### 2026-06-23 (Lane 1 SM) — PI-0 S1 stakeholder demo held; back-catalogue proof backfill APPROVED; demo prod-status reconciled

**Stakeholder demo / sprint review (C-suite + business)** of all Lane-1 S1 work, run by the SM + 4 specialists with live evidence (live test runs, code diffs, 3× soak `/health`, live GetBlock RPC matrix). Record: Confluence [87719938](https://arkova.atlassian.net/wiki/spaces/A/pages/87719938) (child of S1 report 87293954) + Drive deck in `ARKOVA PI-0-S1` (the `[CORRECTED]` copy is canonical). Shown: #1251 provider-SPOF (merged), #1255 verify-by-math foundation (soaking), #1254 PROOF-03 (soaking), #1253 WEBEXT-CSP fail-closed (preview-gated), 0341 credit fix; DISC-03 retired via live curl-matrix.

**Carson APPROVED the back-catalogue proof backfill** (~2.97M SECURED anchors) — the gate between "0340 machinery shipped" and "trigger enforced." Logged on epic SCRUM-2325. Scheduled, NOT run: remaining gates = #1255 code on main + backfill-job staging rehearsal, then flip the GUC trigger ON. The "0340 prod-applied" dependency is **already met**.

**Demo prod-status reconciled (caught against main):** the demo was delivered on stale Lane-1 context framing 0340/0341 as "not in prod." Live prod query confirms BOTH already applied (per Lane-2 entry below): ledger head 0340/0341, `anchor_proofs` +5 cols, trigger present + GUC inert, `org_credit_deductions` append-only + 0 rows. The 0341 "row-count" caveat is RESOLVED (empty table → zero data risk). Confluence record + Drive deck corrected.

_Verified via: live prod Supabase MCP `list_migrations` (head 0340,0341) + `execute_sql` on `vzwyaatejekddvltxyye` (anchor_proofs 5 new cols; trigger `trg_anchors_proof_complete_on_secured` present; GUC null/inert; `org_credit_deductions` 0 rows + 3 signed CHECKs + append-only trigger); 3× Cloud Run `/health` (3e3aa1d7 / a6635c32 / cc440bd2); live GetBlock getblockheader+gettxoutproof on mainnet block 955029; Confluence v2 page 87719938 + Drive [CORRECTED] doc; Jira SCRUM-2325 comment 16686._

### 2026-06-23 (RTE ops) — #1250 deploy-gate fix → worker on latest; soak-rig teardown; prod Disk-IO budget fix (dashboard cron `*/2`→`*/15`)

**Deploy gate unblocked + worker on latest.** #1250 (Trivy deploy-gate input fix `pkg-types`→`vuln-type` / `github-token`→`github-pat`, + behavior-identical SonarCloud maintainability refactor of `check-image-scan-gate.ts`, 15/15) **admin-merged by Carson** → deploy-worker run **28031108914** green, **Trivy scan PASS** (the step that blocked every worker deploy since 06-22). Prod worker now **rev `arkova-worker-00950-xev` @ 100% traffic**, `/health` git_sha `2a9d0526` (= #1250 merge commit), db/anchoring/kms ok. All worker deploys unblocked.

**Soak-rig hygiene (§7).** Cross-referenced full Supabase + Cloud Run inventory vs PR states. Carson deleted 6 orphaned Supabase rigs (pr1146 / pr1147-resoak / pr1151 / pr1175 / csi04-resoak / s0e4-lane-b — all merged/closed PRs); I deleted the 4 orphaned Cloud Run soak workers still billing (pr1146 / pr1175 / pr1200 / s0e4-lane-b). **3 more orphaned rigs flagged:** `arkova-rig-pr1194/1200/1201` (#1194 closed, #1200/#1201 merged). KEEP = `arkova-staging` (standing) + `train-d-proof` (#1255) + `train-d-queue` (#1259 L2) + `s0e4-lane-a` (#1254) + `pr1260-0344` (#1260 L2) + prod. `cacti-technologies` = unidentified in-org project (Carson to ID).

**Prod Disk-IO budget fix.** Prod `vzwyaatejekddvltxyye` (SMALL) was depleting its burst Disk-IO budget. Dominant consumer by far: `refresh_pipeline_dashboard_cache()` — **~26.7 TB cumulative disk reads** (≈59% of top-15 IO), 6 full-table aggregates over the 22GB `anchors` table per run. Cron job **35** fired it every 2 min (`*/2`), but each run takes **170–227s** and ran **back-to-back continuously** (~85% duty cycle, 24/7). **Carson-approved, DBA-careful change: `cron.alter_job(35, schedule => '*/15 * * * *')`** (schedule-only — command, function, and job 2 `vacuum-anchors` all untouched). New duty cycle ~20% with 12 quiet min/15 for the burst budget to refill (~80% read cut, ~543→~72 GB/day). **Rollback:** `cron.alter_job(35, schedule => '*/2 * * * *')`.

**Follow-up (T3, AFTER the current soak window — not filed mid-soak):** the 6 dashboard sub-aggregates seq-scan `anchors`; runs brush/exceed the 110–120s `statement_timeout`, and the function's per-block `EXCEPTION WHEN OTHERS` **swallows sub-aggregate timeouts → reports "succeeded" while the cache may be partially stale**. Covering/partial indexes or an incremental rollup (same hotspot family as #1257) fixes both the per-run cost and the silent-timeout risk. File once #1255/#1254/#1259/#1260 soaks close.

_Verified via: deploy run 28031108914 success (`gh run view`) + prod `/health` git_sha `2a9d05264f45…` + Cloud Run `arkova-worker-00950-xev` 100% traffic (`gcloud run services describe`); `gcloud run services delete` ×4 + Supabase MCP `list_projects` (6 rigs gone, 3 `rig-pr*` remain); Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` — `cron.job` 35 schedule `*/2`→`*/15` (command/active unchanged), job 2 untouched, `pg_stat_statements` top-IO, `cron.job_run_details` durations 170–227s. No code/schema/migration changed; the cron edit is operational config (Carson-approved)._

### 2026-06-23 (Lane 2) — Train-D foundations 0340 + 0341 APPLIED to prod + ledger reconciled numeric

Lane 2 (Product & Growth) Sprint-1 ceremonies run (refinement · planning · pre-mortem) → Confluence page 87392262. **Carson-approved prod-apply** of the held Train-D foundation migrations to prod `vzwyaatejekddvltxyye` via Supabase MCP `apply_migration`, in strict prefix order **0340 → 0341**:
- **0340** (proof completeness, SCRUM-2335): `anchor_proofs` +5 cols (block_header/block_hash/op_return_payload/merkle_index/proof_schema_version); GUC-gated `enforce_secured_anchor_proof_complete` trigger present, `arkova.proof_enforce_secured_complete` **default OFF → inert** (2.97M SECURED anchors untouched).
- **0341** (credit integrity, SCRUM-2349/2350): `org_credit_deductions` now **append-only** — `entry_type` + signed-amount/entry_type/balance_after≥0 CHECKs (old `amount>0`/`balance_after` CHECKs dropped), BEFORE UPDATE/DELETE reject trigger, `DELETE` revoked from service_role; `debit_and_enqueue_anchor` + `org_credit_ledger_divergence` RPCs + idempotency index. Prod table **EMPTY (0 rows)** → sign-flip a no-op, zero data risk.

Ledger reconciled to **numeric** per §0 rule 10; contiguous head **0339, 0340, 0341**. This clears the `Check supabase/migrations vs prod` gate on **#1255** (0340) + the credit PR (0341); both merge via **Mergify** on green + soak evidence (T2/T3 included — `needs-carson-merge` is a Mergify no-op). `0343` reserved for QUEUE-02 (SCRUM-2348, Lane 2) in `supabase/migrations/agents.md`; interface-lock to Lane 3 by 2026-06-26.

_Verified via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye`: 0340 → 5 new cols + trigger present, ledger version=0340; 0341 → `entry_type` + 3 signed CHECKs (old 2 dropped) + append-only trigger + `debit_and_enqueue_anchor` + `org_credit_ledger_divergence` + idempotency index present, service_role DELETE revoked, 0 rows intact, ledger version=0341; ledger tail "0339, 0340, 0341"._

### 2026-06-23 — PI-0 Sprint 1 (Lane 1) executed: 3 parallel T3 soaks running; config-drift merged; 0341 launch-blocker caught + fixed

Sprint 1 (PI-0, 06-22→07-03) for Lane 1 (Trust & Chain) driven to **code-complete + in-soak**: refinement → planning → pre-mortems → builds → /code-review + /debug → parallel isolated soaks (S0-E4). **No prod schema/worker state changed; no PR merged by Claude.**

**Merged:** config-drift provider-SPOF (CHAIN-RESIL, README item #6) — **PR #1251 MERGED** (in origin/main). Detects a dropped/wrong `BITCOIN_UTXO_PROVIDER` (config.ts default `mempool` vs deploy `getblock`).

**3 parallel T3 soaks RUNNING on separate isolated rigs** (S0-E4 model): (1) **proof foundation #1255** — mig 0340 + Merkle-recompute verdict (`verify-proof` now recomputes, never `anchors.status`); base-drift resolved by merge-forward `3e3aa1d7`; rig `ykbkueelkxngyrwkutxt`, start 2026-06-22T21:52Z. (2) **PROOF-03 #1254** — GetBlock confirmation-proof (block header + Merkle inclusion); rig `sveujcebzkqxbhimotbb` (s0e4-lane-a), start 2026-06-23T11:46Z. (3) **Lane-2 credit-0341** (`cc440bd2`) — rig `bkstqckfldajpaehveaa`, start 2026-06-23T11:59Z. All three `/health` healthy (db/anchoring ok); 0340 applied + GUC `arkova.proof_enforce_secured_complete` OFF-verified on the proof + lane-a rigs.

**DISC-03 chain posture DECIDED + empirically verified:** live GetBlock curl-matrix vs mainnet block 954869 confirms `getblockheader` + `gettxoutproof` on the prod token → PROOF-03 source confirmed, pre-mortem RP-5 retired. Launch = GetBlock-sovereign broadcast + OP_RETURN **v0** (version-aware verifier) + OP_RETURN-only fee. **No mainnet broadcast until Carson final-confirm.** Pack: Confluence 86966274.

**WEBEXT-CSP #1253** (NER self-host under `'self'`): /code-review caught + FIXED a **critical concurrency fail-open** (racing NER-load callers bypassed the typed error → silent regex fallback, §1.6 risk); 27/27 green; Vercel-preview pending.

**LAUNCH-BLOCKER caught in soak + FIXED:** mig **0341** negated `org_credit_deductions` before dropping the old `amount>0` CHECK → ERROR 23514 on non-empty data. Reordered (`cc440bd2`), re-applied successfully on the non-empty 12-row rig, ordering regression test added. **Bug Tracker BUG-2026-06-23-001.** Prod-apply gate: confirm prod `org_credit_deductions` row counts before the S2 0341 apply (the fixed migration is safe on any data regardless).

**Release path** (soak in parallel, merge in order): #1255 → delete branch (auto-retarget #1254 + Lane 2) → 0340 prod-apply (S2, before 0341) → #1254 → credit → #1253. Mergify auto-merges on green (the `needs-carson-merge` label is a no-op).

**Artifacts:** Sprint 1 report = Confluence **87293954** + Google Drive "ARKOVA PI-0 — Sprint 1 Report [FINAL]"; DISC-03 pack 86966274; proof_bundle contract 86999041. PRs #1251 (merged) / #1255 / #1254 / #1253.

_Last refreshed: 2026-06-23 by Claude (carson@arkova.io) — claims verified against: PR #1251 merge present in origin/main (`gh`/`git log`); rig `/health` git_shas (`3e3aa1d7` / `a6635c32` / `cc440bd2`, db ok) via curl+OIDC; 0340 applied + GUC OFF via Supabase MCP `execute_sql` on `ykbkueelkxngyrwkutxt` + `sveujcebzkqxbhimotbb`; GetBlock curl-matrix vs mainnet 954869; Confluence/Drive create responses. No prod schema/worker state changed; no Claude merge._

### 2026-06-21 — CSI-04C/04D recovery PR #1242 (stranded #1040+#1041 → main; no prod/soak touched)

The CSI stacked merge tangled: **#1039** (Credly) is on main, but **#1041** (CSI-04D Issuer Partners admin UI + worker API) merged into **#1040's branch** `feat/scrum-1613-csi-04c-accredible-adapter` (merge commit `771e398d`) **not main**, and **#1040** (CSI-04C Accredible adapter) is **closed-never-merged**. So the Accredible adapter + Issuer Partners UI/API were **stranded** on `feat/scrum-1613` and missing from main.

**Recovery: [PR #1242](https://github.com/carson-see/ArkovaCarson/pull/1242)** (`recover/csi-04cd-to-main`, head `0dc08d1c`, base main) — branched from the **exact soaked CSI head `d8402369`** and rebased onto current main (`7fdde07d`). The rebase had **zero conflicts** (the CSI commits and main's advance #1147/#1153 have an empty changed-file intersection). **Zero runtime loss verified:** `git diff d8402369 HEAD -- <csi runtime>` is EMPTY (all 21 CSI runtime blobs byte-identical to the soaked head); both soak-caught prod bugs present (`req.userId` 401 fix; the test-never-ran stub fix). Net delta vs main = the 22 CSI files (#1040+#1041) + the RC manifest. Local checks green (FE `tsc`/`lint:copy`/3019 tests; worker `tsc`/6460 tests — only the pre-existing env-gated zk-proof suite fails, non-CSI). **T2 staging evidence** cites the real CSI soak (clean_mirror rig `inysmaaampaqlzsljjjh`, soaked head `d8402369`, `2026-06-20T17:44:22Z`→19.8h) + RC manifest `docs/staging/rc-manifests/rc-csi04-20260620.json`; **residual-risk = no re-soak** (rebase touched only docs/config, CSI runtime byte-identical → soak carries forward, the #1152 precedent). **Draft, awaiting Carson's review/merge** — Claude does not merge. Supersedes closed #1040 + mis-merged #1041.

### 2026-06-19 — PI-0 launch-readiness PLANNED + FILED (C-suite gate → kicked back → planned; no prod/soak touched)

**C-suite launch-readiness gate (2026-06-19) did NOT approve launch** — strategic direction approved, kicked back to the ART for a real plan. Outcome: **PI-0** (the pre-launch increment; renamed from the Sprint-0 doc's "Train D / PI-1" framing — post-launch = PI-1+) is now planned, gated, and filed. Builds on Sprint-0 (S0-E4 #1211 landed; lanes onboarded).

**Artifacts:** ART PI-0 plan = Google Doc `1kS6eFsOgT7lFytDgtc2xvt6SZgNJi_kgtaoAEWLA4Mk` (PI Plan + Pre-Mortem + Retro) + Confluence index **85524482**. Per-lane SM team plans (Drive "Sprints" folder): Lane 1 `1feSaWt5...`, Lane 2 `1bvCozrbTm...`, Lane 3 `1oyqaGCSlG...`. Lane Confluence pages **85557250** (L1) / **85590017** (L2) / **85491717** (L3). Cross-lane sync = **Program Board** page **85622786**.

**Jira (reconciled, NOT duplicated):** the existing `prd-2026-06-12` backlog (8 MVP-D epics SCRUM-2325/2328/2329/2330/2331/2332/2333/2334 + ~78 stories, already full AC/DoD/tier/subtasks) was reorganized into PI-0 via labels — every epic+story now carries `pi-0` + `lane-1|2|3` (+ `sprint-1..4` on stories). DoD = the 13 launch gates (PRD §11); **OPS-02 / SCRUM-2400 = the 48h integration-soak launch gate**; 4 sprints, assumed start **2026-06-22**, re-gate ~08-14.

**Decisions (PO-confirmed 06-19):** FE-PROOF-GATE **SCRUM-2501 → lane-2** (was lane-1); chain posture **OP_RETURN 0x01 + GetBlock as header/inclusion-proof source** confirmed (unblocks L1 chain-drift pack); instant-secure stays HIDDEN until QUEUE-08+ledger pass T3; **end-S3 code-freeze gates OPS-02**; 0340 prod-apply before 0341. Cross-lane **Blocks** links wired: 2348→2363, 2335→2349, 2338/2340→2501, 2363/2340/2505→2400.

**INCIDENT (logged to memory):** the Atlassian MCP key-resolver **misroutes ~30% of lookups under CONCURRENT sessions** (parallel agents writing Jira), and `editJiraIssue` replaces fields → clobber risk. **No data was corrupted** — defensive read-backs held, parallel agents were stopped, and the sole-session guarded re-run completed all 59 remaining labels clean (0 misroutes). Rule: never fan out parallel agents writing the Atlassian MCP; single-session + read/write key-verify, or address by numeric issue ID.

_Last refreshed: 2026-06-19 by Claude (carson@arkova.io) — PLANNING ARTIFACTS ONLY, no prod/worker/schema/soak state changed and no PR merged. Verified via Confluence create responses (pages 85524482/85557250/85590017/85491717/85622786), Jira label query (`labels in (pi-0,lane-1,lane-2,lane-3)`) + per-issue `getJiraIssue` read-back (8 epics + 78 stories labeled; 2501=lane-2; 7 Blocks links confirmed on 2400/2501/2363/2349), and Drive doc creates. Train C #1154 + Train D foundation branches untouched._

### 2026-06-19 — Lane 3 Sprint-0 slice filed; CE secret hardened in place

Lane 3 (Credential Network & Intelligence) — the **last open Sprint-0 lane** (L1+L2 done) — delivered its slice (T0 design/audit) + executed the in-scope CE custody hardening. No other PR/branch/soak touched (Train C #1154, Train D rigs hands-off). PR **#1224** (`lane3/s0-ce-custody-bq-design`, base `f3f72767`) **MERGED to main 2026-06-19 16:55Z as `80a3fe7a`** (CI green + independent RM review = GO); Jira **SCRUM-2542 + subtasks 2543/2544/2545/2546 → Done** under SCRUM-2513; Confluence **85393410**; Drive report in *ARKOVA PI-1-S0*.

- **CE custody (S0-7.2 ↔ SCRUM-1867):** the CE key was **already** in Secret Manager (`Credential_Engine`, project `arkova1`). Hardened in place — per-secret `roles/secretmanager.secretAccessor` for the worker runtime SA (`270018525501-compute@…`, us-central1) + inventory labels; **verified via `gcloud secrets get-iam-policy Credential_Engine`** (SA → secretAccessor present) + `describe` (labels set). Value never read; additive (project grant unaffected); no move/rename. Dead rotation reminder (`secret-rotation-reminder.ts`, SCRUM-2536) wiring = Sprint-1. **No early CE continuation email** (premature); near-term action = consuming smoke (SCRUM-1921); continuation via the existing Jeanne/Jeff channel near the ~2026-09-09 trial cliff (R-1). SEC-HARDEN (SCRUM-1041) handed the project-wide-vs-per-secret IAM estate decision.
- **BigQuery (↔ SCRUM-1062):** NOT greenfield — the 5-table `arkova_analytics` mirror is shipped (migration 0297). Designed a PII-safe extension (credit-ledger / connector / AI-usage mirrors + marts); prod-deployment of the existing pipeline unverified (Sprint-1 task-0).
- **Partnership audit (S0-E2):** corrected the brief's stale IDs — HakiChain launch = SCRUM-1703 (1010 is CIBA); CPE/CLE epics = 1845/1865 (1962/1963 are eval-gate stories). Gate rows (CE/CASA/Kenya) supplied to S0-7.1 (SCRUM-2523).

_Last refreshed: 2026-06-19 by Claude (carson@arkova.io) — claims verified against gcloud (`secrets get-iam-policy`/`describe` on `Credential_Engine`: worker SA has secretAccessor; labels owner/category/service/risk/rotation-cadence) + Atlassian/GitHub MCP (PR #1224 merged 80a3fe7a; SCRUM-2542 + subtasks Done; Confluence 85393410)._

### 2026-06-18 — S0-E4 activated to the line of Carson-gated steps; PR #1211, Jira/Confluence/Drive updated

Continued S0-E4 from the 2026-06-17 build. **Prod ledger verified clean** via read-only Supabase MCP (`vzwyaatejekddvltxyye`: 48 rows, 47 numeric, head **0339**, 0 non-numeric numeric-named rows, 0 dups) → **S0-4.2d done**: drained `ledger-numeric-exemptions.json` to `[]` + removed `--report-only`, so the full-ledger audit now **blocks** (clean ledger passes; a 0322-style timestamp row exits 1). **S0-4.3d done in-repo**: applied the tiered-merge gate to `.mergify.yml` (`needs-carson-merge` on default+urgent+both PR rules) + new `.github/workflows/merge-authority.yml`; added a **merge-control-plane carve-out** to `compute-merge-authority.ts` (`.mergify.yml`/`CLAUDE.md`/the workflow/the script/CODEOWNERS → needs-carson regardless of path tier — closes the self-grading blind spot the RM flagged, and the CLAUDE.md-as-council gap).

QA + Release-Manager personas reviewed **PR #1211** (draft); findings worked through: added CLI/subprocess tests (BLOCK vs `--report-only` WARN vs fail-closed parse; merge-authority empty-changeset fail-closed). `vitest run scripts/` **542/542**; `tsc --noEmit` 0 errors. Nothing merged; only read-only prod access.

Jira: created **SCRUM-2528** (S0-4.1) + **SCRUM-2529** (S0-4.3) under SCRUM-2313 → Needs Human; **SCRUM-2500** → In Progress (1 of 5 mechanisms done) + comment; epics SCRUM-2313/2513 commented. Confluence: sprint report **page 84705281** (child of Sprint-0 AUDIT 83689473) + S0-E4 rows added to the AUDIT page. Drive: sprint report Doc in the PI-1 sprint-reports folder + the 3 ceremony/playbook/runbook Docs in `ARKOVA PI-1-S0`.

**Carson-gated remainder:** merge #1211 (carve-out marks it needs-carson); add the `Merge Authority` check to main's required checks (GitHub setting); run the live 2-concurrent-soak rehearsal S0-4.1c (needs a gcloud + Supabase-admin env — absent in the agent sandbox); SCRUM-2500's other 4 mechanisms.

_Last refreshed: 2026-06-18 by Claude (carson@arkova.io) — ledger clean verified via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (0 non-numeric/dup, head 0339); tests via `vitest run scripts/` (542/542) + `tsc --noEmit` (0); Jira via `createJiraIssue`/`transitionJiraIssue`/`addCommentToJiraIssue`; Confluence via `createConfluencePage`/`updateConfluencePage`; Drive via `create_file`. No prod/staging/ledger state mutated; nothing merged._

### 2026-06-17 — Sprint 0 S0-E4 (parallel-safe pipeline) built; NOT merged (Carson-gated)

Executed Sprint-0 epic **S0-E4** (Release-Management Process Fixes / parallel-safe pipeline; reuses SCRUM-2313, story S0-4.2 reuses SCRUM-2500) — the non-negotiable Sprint-1 entry gate that retires roadmap **R-3**. Ran refinement + planning + pre-mortem first (+ code review, post-build pre-mortem, retro — recorded in the Google Doc "ARKOVA PI-1 S0-E4 — Refinement, Planning, Pre-Mortem, Code Review & Retro" in Drive ARKOVA PI-1-S0: https://docs.google.com/document/d/1nFgOufZNenCHLBG3JKRX__iKhQ3nZTs8YiyFye4k-30/edit), then built across 3 parallel personas. **Nothing merged; no PR opened; no infra provisioned; no prod/staging/ledger mutation.** Branch `claude/s0-e4-refinement-planning-myy61i`.

**Built + green (T0 CI/docs/tooling):**
- **S0-4.2 (SCRUM-2500):** `scripts/ci/check-ledger-numeric-integrity.ts` — full-ledger numeric-integrity audit. Local-file grammar pass runs network-free in `ci.yml`; the prod-ledger pass runs in `migration-drift.yml` over the payload the drift step already fetches (read-only, same token, fail-closed). Closes the gap that let the 2026-06-15 timestamp-version re-regression pass unseen (drift gate only checked PR-diff). Injected-timestamp row fails (CLI-proven); 0 false-positives on the real 48-file set.
- **S0-4.3:** `compute-merge-authority.ts` (reuses `requiredTierFor`; emits council/needs-carson; fails closed) + `check-agents-md-migration-collision.ts` (unique `## Recent migrations (…)` headers, CLAUDE.md §6) + the Mergify/Stacked-PR + Tiered-Merge Playbook (Google Doc, Drive ARKOVA PI-1-S0: https://docs.google.com/document/d/1iontJPUkhLQkQyZG4PETGuPj3kf23Kgn-1kDxqukfr8/edit). All wired into `ci.yml`; 3 new checks registered in `STAGING_TOOLING_ALLOW` (classify T0).
- **S0-4.1:** `scripts/staging/{provision,teardown}-isolated-rig.sh` (dry-run DEFAULT; prod `vzwyaatejekddvltxyye` + shared staging `ujtlwnoqfhtitcmsnrpq` + shared Cloud Run hard-denied, exit 1) + the Isolated Soak-Rig Automation Runbook (Google Doc, Drive ARKOVA PI-1-S0: https://docs.google.com/document/d/1c0F_9NSy9ldfeR28xlY7s7zFFwKpS8cmTzvhI9dI__E/edit).

**Verification:** `vitest run scripts/` 530/530 green (+23 new); `tsc --noEmit` 0 errors; staging scripts `bash -n` + dry-run/deny paths exercised.

**Carson-gated (NOT done — by design):** retire stale `0299–0310` `exempt_regex` entries in `migration-drift.yml` once the new audit runs green vs prod (S0-4.2d, fail-closed); apply the drafted `.mergify.yml`/branch-protection tiered-merge change (S0-4.3d); the live "2 concurrent T3 soaks" rehearsal that fully closes S0-4.1's AC (T3 infra); S0-E4 Jira transitions + Confluence per-story pages.

_Last refreshed: 2026-06-17 by Claude (carson@arkova.io) — no prod/staging/ledger state asserted or mutated; all claims are about repo artifacts on branch `claude/s0-e4-refinement-planning-myy61i` verified via `vitest run scripts/` (530/530), `tsc --noEmit` (0 errors), and `bash -n` + dry-run/deny execution of the staging scripts. Bootstrap acked (`scripts/agent/ack-claude-bootstrap.sh`)._
### 2026-06-17 — PI-1 Sprint 0 (Lane 1 + train roles): foundation docs + drift/parity spike + gates — all DRAFT, nothing merged

PI-1 Sprint 0 kickoff. Scope = **Lane 1 (Trust & Chain) + the train roles**, executed in the outlined order under Carson's merge gate. **No prod/staging/Supabase/soak mutation; nothing merged; Train C #1154 + the two Train D rigs untouched.** Created GitHub milestone `Sprint 0 — Foundation & Hardening` (#24).

**Draft PRs (Sprint-0 milestone — Carson merges):**
- **S0-E1+E2+E6+E7 + Lane-1 pre-design** (T0 docs, `s0/train-foundation`): lane manifest + RACI (machine+human) + session operating model + dry-run; read-only source-of-truth reconciliation (every correction is a *proposal*); infra/SSD/Vertex inventory; external-gate tracker; chain-resilience + MIT-verifier pre-design; Lane-1 visibility signal inventory.
- **S0-E3** CLAUDE.md v-next draft (T0, Carson-review — rule change).
- **S0-E5.2** config↔reality drift + cross-runtime parity gate spike (T1, Lane-1 code).

**Flagged for Carson (read-only findings; all action GATED):** PO Roadmap 27591934 superseded by 82444290 (banner + re-point CLAUDE.md §5/memory); possible-false-Done SCRUM-1044/1049 (changelog + child-rollup); SDK-PY overlaps Done SCRUM-1112; VC-W3C front-runs open spike SCRUM-2296; orphan paid Supabase project `xrefmwydaatppieoxfxn` (PR #1055 merged 06-10) → dashboard delete; CAIQ v1 sheets flagged-not-moved. Jira filing (S0-2.2), Confluence creates, infra deletes, CE-key→Secret-Manager, and external outreach are all gated — not done.

_Last refreshed: 2026-06-17 by Claude (carson@arkova.io) — claims verified against gcloud/MCP/CI output: Cloud Run via `gcloud run services list --project=arkova1` (4 services, all prod/active-soak); Vertex via `gcloud ai endpoints list --region=us-central1` (1 golden endpoint); Supabase via MCP `list_projects` (8 projects; orphan `xrefmwydaatppieoxfxn` confirmed via `gh pr view 1055` = MERGED); milestone via `gh api repos/.../milestones` (#24). No prod state asserted or changed this session._

### 2026-06-16 (cont.) — Top-risk + hygiene round; API 529 overload deferred the agent streams

Post-replan execution round (top risks + Jira/PR hygiene + endpoints + roadmap). A **sustained Anthropic 529 overload throttled the parallel-agent fan-out — 9 subagent launches died with 0 work** (R1×3, R4×2, R5, Jira-hygiene, PR-hygiene×2). Main loop unaffected → agent-driven streams DEFERRED (nothing lost; failed agents did nothing). Did the rest in-loop.

**Done (in-loop):**
- **Vertex (§7):** the 5 duplicate `arkova-gemini-fraud-v1` cold-spares (06-05 sweep) are **already gone**; only the golden endpoint remains and it's **EMPTY** (`deployedModels:null`, $0, gated track). At the §7 target. Empty golden shell = keep ($0, named) or delete — Carson's call.
- **Gemini Golden:** should **NOT** be active — gated by design (`config.ts:281 enableVisualFraudDetection` default false, fails closed pending SCRUM-1955; GEMB2-blocks training). Empty endpoint is correct, not a gap.
- **R1 de-risked:** prod `org_credit_deductions` is **empty (0 rows)** + `enableOrgCreditEnforcement` default false → 0341's in-place sign-flip is a prod **no-op**. The scariest part of R1 is moot.
- **Jira hygiene:** `launch-blocker` removed from **2496/2497** (deprioritized abuse-floor, Carson 06-15), **kept on 2495** (does-not-assert disclaimer — pulled into launch per QA+PM); each documented with a comment.

**Deferred — agent-throttled, ALL non-blocking, resume next session / when the throttle clears:**
- R1 reconciler-wiring (defense-for-live-era; prod ledger empty so non-urgent); R4 token-unify + per-log fast-path (#1203, cosmetic); R5 precise disclosure size (prod `count(*)` timed out — use `pg_class.reltuples` next; backfill self-validation already confirmed sound in the replan).
- **PR value-check+close** (#1146/#1148/#1153/#1087/#1106 + worker-dep dedup #1158/#1194→#1175) — **not rushed in-loop** per Carson's "check before closing"; teed up for the next agent run.
- Jira: In-Progress transitions (2490/2491/2349/2350/2492), per-story Confluence pages (§4/§5.1 gap), `[Close-out]` subtasks, the `database.types` resync ticket.
- **Roadmap (point-5 decision):** refresh PO Roadmap **27591934 in place** + keep it as the §5 source (do NOT anoint a separate page); deferred — a full-body-replace of the large canonical page is risky in-loop, do it carefully via agent.

**State:** main `6731c6d1`; **#1154 soaking, UNTOUCHED** (ends ~06-17 06:32 UTC); held Train D set unchanged (#1203 `dd6ee736`; foundations proof `d11deed3` + credit `78870207`); shared checkout on a concurrent session's branch — worktrees used throughout. Nothing merged; no soak/rig/ledger touched.

**Retro (top-risk round):** Went well — the in-loop fallback delivered the achievable high-value items (Vertex / Gemini-Golden / labels / R1-de-risk) despite the overload; the soak + shared tree stayed clean; failed agents did 0 work (clean failures, nothing to undo). Didn't — a sustained API 529 made the 5-way agent fan-out unviable (9 failures, ~30 min to retries). **Lesson:** under an API overload, don't thrash parallel agents — pivot to the (unthrottled) main loop for read/MCP/gh work and defer the code-agent streams. **Action:** resume the deferred streams via the team when the throttle clears (all non-blocking).

_Last refreshed: 2026-06-16 by Claude (carson@arkova.io) — Vertex via `gcloud ai endpoints list/describe` (us-central1 = 1 empty golden; us-east1/4, us-west1, eu-west4 clean); prod ledger empty via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (`org_credit_deductions` total=0); Gemini Golden gating via `services/worker/src/config.ts:281`; Jira labels via `editJiraIssue` (2496/2497 `launch-blocker` removed) + comments; 9 agent 529s observed (0 tool_uses each). No prod/soak/rig/ledger state changed._

### 2026-06-16 — Train C soak = #1154 (correction); Train D foundations stacked; no-restart plan

**LIVE Train C soak is PR #1154** (`codex/rc-train-c-code-20260612`, head `cfaee18e`) — **NOT** #1146/#1148. Verified heartbeating 2026-06-16 (OPS 5401/5409, CTDL 722/722; isolated project `bwkskvbmcjodwxklpzyl`, preflight `clean_mirror`); rides the **shared** Cloud Run `arkova-worker-staging` via tag `train-c-1154-cfaee18e`; **expected end 2026-06-17 06:32 UTC**. **Do NOT `gcloud run services update`/deploy `arkova-worker-staging` or touch `bwkskvbmcjodwxklpzyl` until #1154 lands** — a shared-service env rewrite is exactly what killed the CE soak (06-13). CORRECTION to the 06-15 entries below: the #1146/#1148 CE soaks were **aborted 06-13** (non-merge-grade, `release-evidence/train-c/ce/ABORTED-*.md`) and superseded by #1154. CSI #1039/40/41 = **no live soak clock** (un-started, stale evidence, downstream of merged #1038) — hands-off, but nothing is actively soaking there.

**Train D foundations stacked (conflict pre-resolved):** `feat/train-d-credit-foundation` rebased onto `feat/train-d-proof-foundation` → **`78870207`** (migrations 0340+0341 both present; the `batch-anchor.ts` import conflict auto-resolved; targeted worker tests green; the authoritative clean typecheck/test runs at PR-open CI, which gates **before** any soak).

**No-restart plan (release-mgr + tech-lead premortem):** SERIALIZE trains. Train D preps now (stack ✓; CI-only preflight dup-name normalization in progress so the rigs read `clean_mirror`; reserve 0340/0341 in `supabase/migrations/agents.md`; fold the `database.types.ts` 0323 resync; consolidate to ONE rig) but its **48h T3 soak clock starts only after #1154 merges + Train D rebases onto the new main**, so it soaks against its true merge base. Window rule while any T3 soak runs: no T3-surface PR (migrations / `batch-anchor.ts` / chain / billing / anchor-lifecycle) merges to main; T0 docs/tests/CI/frontend-only continue (absorbed by the base-drift waiver). Full plan → Confluence once Carson signs off (serialize + rig consolidation).

_Last refreshed: 2026-06-16 by Claude (carson@arkova.io) — #1154 verified via `gh pr view 1154` (OPEN/draft, head `cfaee18e`, base main) + `release-evidence/train-c/code/.../soak-train-c-1154-cfaee18e-*.summary.json` mtimes 06-16 08:4x local; main tip `de76e952` via `git log origin/main`; stacked credit branch `78870207` via `git ls-remote origin`. No rig/soak/ledger touched this session._

### 2026-06-15 — Prod migration ledger reconciled to numeric (corrects the 2026-06-05 claim)

The 2026-06-05 entry asserted 0322–0331 were reconciled to numeric versions; a later MCP `apply_migration` silently re-regressed **7** rows back to timestamp versions. Reconciled via the single §0-rule-10 operator-approved write (Carson, 2026-06-15) on prod `vzwyaatejekddvltxyye`: `UPDATE supabase_migrations.schema_migrations SET version=left(name,4) WHERE version !~ '^[0-9]{4}$' AND name ~ '^[0-9]{4}_'` (RETURNING: 0322,0323,0324,0325,0326,0330,0331 → numeric). **Verified post-write:** 0 remaining non-numeric `NNNN_` rows; numeric head **0339**; contiguous 0300–0331, 0333–0339 (**0332 is an empty gap** — never used; leave documented-dead; Train D starts at **0340**). Follow-ups (normal PR, not done here): SCRUM-2500 adds a full-ledger numeric-integrity CI audit (the migration-drift gate only checks PR-diff migrations today — which is why this re-regressed unseen); drop the stale `0322/0323` `exempt_regex` once confirmed.

Also this session (planning): §1.6A connector server-side-fingerprint carve-out committed to `main` (`f8b70d55`, DS-SEC-conditional / SCRUM-2492). MVP Train D **PRD v2** + **Sprint-1 recut** + **launch pre-mortem** in Confluence space A (pages 77758466 / 81100802 / 81199106); 21 new+amended Jira stories under label `prd-2026-06-12` (incl. launch-blockers SCRUM-2490/2491/2492/2500/2501; self-serve abuse floor 2495–2499/2478 deprioritized to fast-follow per Carson). **Train C (CE) #1146/#1148 soaks + CSI #1039/40/41 — FROZEN, untouched.**

_Last refreshed: 2026-06-15 by Claude (carson@arkova.io) — ledger reconcile verified via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (UPDATE … RETURNING 7 rows numeric; post-write SELECT remaining_nonnumeric=0, numeric_head=0339); §1.6A via `git push origin main` (`e795f8c8..f8b70d55`)._

### 2026-06-15 (cont.) — Train D rigs up + two launch-blocker foundation branches ready for soak

Autonomous build cycle (Carson away). **Nothing merged; no PR opened; Train C/CSI soaks untouched.** Retro: Confluence **81199128** (child of Sprint-1 plan 81100802).

**2 isolated Train D rigs (paid ~$10/mo each — tear down at launch, §7):** proof `ykbkueelkxngyrwkutxt`, queue/credit `bkstqckfldajpaehveaa` — both us-east-2, PG 17.6, **ACTIVE_HEALTHY**, schema head **0339**, synthetic fixtures only (no prod clone/PII). Cloud Run `arkova-worker-train-d-{proof,queue}-staging` on the prod-pinned image, `USE_MOCKS=true`, anchoring off. **Preflight reads `soak_artifact` (not `clean_mirror`)** — sole cause is the pre-existing duplicate migration name `0302/0303_validate_api_key_rpc_hardening` (SCRUM-2192), faithfully recorded by `db push`; NOT contamination, deliberately not masked. SCRUM-2500 (full-ledger audit) must whitelist this until 2192 fixes the dup.

**2 foundation branches pushed — ready for review + 48h T3 soak + merge (all human-gated):**
- `feat/train-d-proof-foundation` @ `d11deed3` — FIX-1 + PROOF-02 + PROOF-VERIFY (SCRUM-2490/2491): verdict now from Merkle recomputation, never `anchors.status`; migration **0340** adds proof-completeness columns + a "SECURED⇒complete" constraint trigger **GUC-gated OFF** (`arkova.proof_enforce_secured_complete`, default off) so it can't reject the empty-branch back-catalogue; resumable manual-trigger backfill, not run on prod.
- `feat/train-d-credit-foundation` @ `5c914cbd` — QUEUE-03 + QUEUE-04 (SCRUM-2349/2350): migration **0341** makes `org_credit_deductions` append-only (drops amount>0/balance_after CHECKs, adds signed-amount CHECK + BEFORE-UPDATE/DELETE trigger + **REVOKE DELETE FROM service_role**, refund=positive row) + atomic `debit_and_enqueue_anchor` RPC. **Rewrites live ledger semantics — review hard before prod.**
- **Merge in prefix order (0340 before 0341); both branches edit `services/worker/src/jobs/batch-anchor.ts` → second-to-merge needs a conflict resolve.** Pre-existing `src/types/database.types.ts` 0323 drift (missing `external_document_versions`) spun off as a separate resync task, not folded in.

Open decisions still on Carson: DISC-02 legal signoff, DISC-03 fee (rec OP_RETURN-only at launch), confirm OP_RETURN version byte `0x01` + GetBlock as header/inclusion-proof source before any mainnet broadcast.

_Last refreshed: 2026-06-15 by Claude (carson@arkova.io) — rigs verified via Supabase MCP `list_projects` (both refs ACTIVE_HEALTHY, us-east-2, PG 17.6, created 18:15–18:16Z); branches via `git branch -a` (both on origin) + `git show --stat` (`d11deed3`, `5c914cbd`, migrations 0340/0341 in-diff); rig schema-head 0339 + `soak_artifact` preflight as reported by the OPS-01 build, not re-run this turn. No prod schema/worker state changed._

### 2026-06-11 — Container-image CVE scan gate added to worker deploy (TVM/IVS) — PR open, T2, soak pending

**Branch `chore/container-image-cve-scan` (off `origin/main` 3f906c99); PR open as Draft — not merged, not deployed.** Closes the CSA STAR / CAIQ TVM/IVS gap: dependency CVEs were scanned (`sonatype-scan.yml`, `npm audit`) but the worker container's OS/base-image layer was not. `deploy-worker.yml` now runs a pinned Trivy scan (`aquasecurity/trivy-action@ed142fd0` v0.36.0, `vuln-type: os`, fixable HIGH/CRITICAL → `exit-code 1`) between `docker build` and `docker push` — a vulnerable image never reaches Artifact Registry / Cloud Run. Library CVEs stay in sonatype's lane (no double-gating). Anti-regression guard `scripts/ci/check-image-scan-gate.ts` (+ unit tests) is wired into the `dependency-scan` CI job; no override label. `services/worker/Dockerfile` adds `apk upgrade --no-cache` so the shipped image picks up Alpine security patches. Control doc: `docs/compliance/container-image-scanning.md`; CAIQ rows IVS-04 + new TVM section.

**Local check (not prod):** built the worker image and ran Trivy at the exact gate config — before the Dockerfile patch, 2 fixable HIGH OS CVEs (OpenSSL CVE-2026-45447 in libssl3/libcrypto3 3.5.6-r0→3.5.7-r0) blocked the gate (exit 1); after the patch, the OS layer is clean (exit 0).

**Gates remaining:** (1) T2 staging soak — deploy-worker.yml edits classify T2; the modified pipeline must run against staging to fill the worker-artifact evidence (Carson runs the staging deploy). (2) Jira story + Confluence page for the control. (3) Separate worker dependency-bump PR for the library-layer CVEs the scan surfaced (glob/minimatch/tar).

### 2026-06-10 — Release queue unblocker #1141 merged; dev may resume under isolated-lane rules

**PR #1141 merged via Mergify** at 2026-06-10T15:56:23Z, merge commit `3f678e7cb7b6f0bcb954141c75094730b49ef45e`; `origin/main` now points at that SHA. The merged release-process change preserves exact PR-head evidence integrity while allowing release-owner-approved T0 docs/tests/CI/tooling-only base drift through a non-placeholder `Base drift impact:` note. Runtime, schema, migration, staging, deploy, soak-behavior, or worker-image drift still fails closed and requires re-scope/retest.

**Safe development posture:** normal dev work may resume in isolated branches/worktrees. Do not mutate shared staging, Supabase data, deployments, Mergify, branch protection, required checks, or existing release PR evidence outside an approved lane. Product/runtime/migration PRs still need their own isolated lane evidence; #1141 does not make any product PR merge-ready by itself.

**#1055 T3 soak remains active, not merge-ready:** as of 2026-06-10T15:59Z the read-only lane dashboard showed `cron ok=2495 fail=0 err=0.0% statuses[200=2495]`, final JSON missing as expected before the 48h gate completes at 2026-06-10T22:24:54Z. Main movement from #1139 was classified as T0 CI-only drift, not automatic soak invalidation; final approval still needs the evidence JSON, exact PR head verification, CI, base-drift impact approval, isolated environment verification, final preflight, and stuck-anchor smoke evidence.

**SCRUM-2312 adoption track opened:** parent Epic [SCRUM-2313](https://arkova.atlassian.net/browse/SCRUM-2313), task [SCRUM-2312](https://arkova.atlassian.net/browse/SCRUM-2312), subtasks SCRUM-2314..SCRUM-2318 plus existing SCRUM-2319 host-validation tracker and SCRUM-2324 evidence-layer taxonomy. Non-secret `staging:soak-lanes` sample captured at `/Volumes/Extreme/Arkova/release-evidence/pr-1141/scrum-2312-soak-lanes-20260610T155859Z.txt`.

### 2026-06-05 — Session close: #1022/#1031 merged, prod migrations + ledger reconciled, soak rig torn down

**12 session PRs merged to `main`** (origin/main tip `303b5fe42fdc` = PR #1031 merge): #1022 (SCRUM-2203 unembedded-records query perf), #1031 (SCRUM-1847/1869 public-anchor CPE/CLE metadata), #1023, #1025, #1029, #1034, #1043, #1045, #1050, #1051, #1061, #1066 (all confirmed merged via `gh pr list --state merged`). All 16 merged session feature branches deleted from the remote; dependabot/codex merged branches were already auto-pruned.

**Prod migrations applied + ledger reconciled to numeric versions** (verified via Supabase MCP `execute_sql` on prod `vzwyaatejekddvltxyye` `supabase_migrations.schema_migrations`): `0330_scrum2203_unembedded_records_query_perf` and `0331_scrum1847_1869_public_anchor_cpe_cle_metadata` are both in prod under their **numeric** versions (0330, 0331); the earlier `0322_bump_cloud_logging_retry_counts_rpc` + `0323_external_document_versions` catch-up are also present under numeric versions 0322/0323. Ledger reads clean numeric for 0320-0326, 0330, 0331 — no timestamp/duplicate rows in that range. (Consequence: the migration-drift gate `exempt_regex` 0322/0323 entries are now stale — see CLAUDE.md proposals below.)

**Ephemeral T3 migration-soak rig torn down** (both #1022/#1031 merged → rig no longer needed): Cloud Run `arkova-worker-migration-soak` deleted (`gcloud run services delete`, confirmed gone in `gcloud run services list`); all 4 scheduler jobs deleted (`soak-migration-health`, `soak-migration-1022-embed`, `soak-migration-1031-cpe`, `soak-migration-1031-cle`). The rig's isolated Supabase project `kihdcwoturustgpzyflj` (`arkova-migration-soak`, region us-east-2, separate from prod) could **not** be auto-paused — MCP `pause_project` requires a free-tier downgrade first (project is paid, ~$10/mo) → **flagged for Carson** to pause/delete via the Supabase dashboard. Cloud Run traffic to it is already zero.

**Endpoint hygiene (§7) — action needed:** post-teardown `gcloud run services list --project=arkova1` shows prod `arkova-worker` + 5 OTHER isolated-soak/staging services from prior sessions — `arkova-worker-staging` (PR #1045 label), `arkova-worker-pr-1052/1055/1056-staging` (open/active PRs), `arkova-worker-pr-967-staging` (PR #967). **Not deleted — flagged for Carson** (out of this session's scope; some back open PRs). `gcloud ai endpoints list --region=us-central1 --project=arkova1` shows **6 deployed Vertex endpoints — over the §7 steady-state target of 1-2**: 1× `arkova-golden-v5-reasoning-pro-20260415` + **5× duplicate `arkova-gemini-fraud-v1`** (endpoint IDs 3265.., 7543.., 7044.., 1842.., 563..). The 5 fraud-v1 duplicates are cold-spare drift; **flagged for Carson** to prune (NOT touched here — fraud detection is gated per GEMB2/Gemini-Golden state; deletes need owner sign-off).

_Last refreshed: 2026-06-05 by Claude (carson@arkova.io) — claims verified against gcloud/MCP/CI output: PRs via `gh pr list --state merged` (origin/main `303b5fe42fdc`); branch deletions via `gh api -X DELETE git/refs/heads`; prod ledger via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (0330/0331/0322/0323 present under numeric versions); soak rig via `gcloud run services delete` + `gcloud scheduler jobs delete` (service+4 jobs gone, confirmed by `gcloud run services list`); Vertex via `gcloud ai endpoints list --region=us-central1 --project=arkova1` (6 deployed: 1 golden + 5 duplicate fraud-v1, flagged not touched). No new prod schema/worker state asserted beyond the migrations already merged + verified above._

### 2026-06-03 — PR queue truth + local-doc hygiene

**GitHub queue:** [PR #1078](https://github.com/carson-see/ArkovaCarson/pull/1078) (`docs: clarify copy-term baseline key`) merged via Mergify at 2026-06-03T13:36Z, merge commit `63c404cb`. [PR #1073](https://github.com/carson-see/ArkovaCarson/pull/1073) merged via Mergify at 2026-06-03T14:26Z, merge commit `0c9b891e`, after E2E and the failed-only `SonarCloud Quality Gate Config` rerun passed. Remaining open PRs are protected/evidence/draft lanes unless explicitly reclassified.

**Protected/no-touch PRs:** #1022, #1031, #1047, #1052, #1055, #1056, #967, #966, #971, #1038, #1039, #1040, #1041, #968, #958, plus #1071/#1072 evidence-gated worker dependency PRs. Treat #958 as draft/big-change prep despite docs-only label. Do not restart or invalidate any soaking/evidence PR from queue hygiene work.

**Stale PR closures (audited, not blanket stale-trust):** #1049 closed because the useful DID:web DB-error behavior is already on `main` via #1043 and the branch would regress missing/suspended-org 404s; #1016 closed after salvaging its one still-relevant doc correction into merged #1078; #1014/#1044 closed because the SearchPage bot chain did not compile and `main` already has the valid busy-state/no-results fixes; #1030 closed because it targeted a closed bot base and would move current SemanticSearch/status-display code backward. Cherry-pick nothing else from those PRs.

**Local-doc hygiene:** `docs/WORK_ITEMS.md` is demoted to a historical archive pointer; Jira remains the only live story/work-status source and Confluence remains the only live documentation source. Use `HANDOFF.md` only for current operational snapshot, not long-lived status tables.

### 2026-06-02 — Hygiene/reconciliation run: git sync, local-disk cleanup, HANDOFF trim

Cross-system hygiene pass via three parallel read-only audits (git/GitHub, Jira/Confluence, Mac-mini disk). **No prod state changed; no PRs merged; no Jira transitions.**

**Git / SSD synced:** the working checkout was sitting in detached HEAD at `a385eba7` (a stale leftover = old tip of `fix/platform-admin-org-roster-view`, already on the remote, nothing lost). Fast-forwarded local `main` `78f6c8d2` → `origin/main` **`ce407c3f`** (PR #1043 SCRUM-1922 did:web, merged 2026-06-02). `git fetch --prune` done. Removed 3 stale merged worktrees (`wt-1854`, `wt-docs`, + orphaned `superpowers` checkouts) and 2 merged branches; 3 dirty worktrees (`wt-1980/2189/2200`, uncommitted edits) left intact. 67 worktrees remain — all open-PR heads / unmerged / locked, **hands-off**.

**Open PRs: 27** — all draft / mid-iteration / soaking, treated hands-off. Migrations **0327-0331** are reserved across PRs #1047(SCRUM-2225)/#971(2045)/#1038(1611)/#1022(2203)/#1031(1847·1869) per `supabase/migrations/agents.md` — merge in prefix order. PR #1052 (the platform-admin org-roster work = the old detached HEAD) is draft, soak-gate red, **no Jira story yet** → Carson to triage/track.

**Doc drift to reconcile (not auto-fixed — needs DoD verify):** **SCRUM-1958** (semantic search, merged #964) still In Progress with **no Confluence page**; **SCRUM-1922** (did:web, merged today #1043) still In Progress and Confluence page [64258050](https://arkova.atlassian.net/wiki/spaces/A/pages/64258050) still reads "To Do — Blocked by SCRUM-1875". Both are Done-candidates (1922 also needs the >30-min-post-merge validator). Board: 56 In Progress / 28 Blocked; space-A docs otherwise fresh (≤3 days).

**Local disk (Mac-mini internal):** reclaimed **~7 GB** of regenerable junk autonomously — npm/uv/pip/node-gyp/brew/SiriTTS/Claude-ShipIt/gcloud-logs caches (~3 GB) + orphaned `~/.config/superpowers/worktrees` duplicate checkouts of merged work (~3.9 GB). Internal free **38 → 43 GiB**. Big remaining levers (Docker.raw ~25 GB, Claude Desktop `vm_bundles` 10 GB, LM Studio model 6 GB, Codex history ~4 GB) **deferred to Carson** — their apps are live or they are user data.

**Prod posture (CORRECTED 2026-06-02, self-verified):** the worker is **current**, NOT behind. Live `/health` `git_sha=ce407c3f`, `network=mainnet`, `{database,anchoring,kms}=ok`; Cloud Run rev `arkova-worker-00835-rap`, image tag `ce407c3f`, deployed 2026-06-02 14:19 UTC by [deploy-worker run 26825377305](https://github.com/carson-see/ArkovaCarson/actions/runs/26825377305) on PR #1043. The earlier "17 commits ahead → prod trails main" note was **stale/wrong**: `deploy-worker.yml` is path-filtered to `services/worker/**` and auto-deploys on every worker-touching merge (8 successful deploys 05-31→06-02); the commits after `ce407c3f` (#1023 frontend NASBA badge, this docs commit) don't touch the worker, so no deploy was owed. **did:web edge gap found + fixed:** SCRUM-1922 (#1043) shipped the worker did:web routes but missed the Vercel edge rewrites → `app.arkova.ai/.well-known/did.json` + `/orgs/:id/did.json` served the SPA, leaving `did:web:app.arkova.ai` + the SCRUM-900 published proof key `arkova-proof-2026-q2` unresolvable for external parties. Fixed via **PR #1061** (`vercel.json` rewrites, merged 2026-06-02 18:02 UTC) — **live in prod**: `app.arkova.ai/.well-known/did.json` + org did.json now return `application/did+json` with key `arkova-proof-2026-q2`. (A parallel session shipped #1061 while I built a byte-identical fix in #1064; #1064 closed as duplicate.) Also filed **SCRUM-2226** (v2/MCP `get_record`/`get_anchor` return null receipt + `Unknown` issuer for SECURED anchors; v1 correct) + **SCRUM-2227** (compliance_controls = informational CML-02 tags, mislabel risk); bug-tracker `BUG-2026-06-02-001/002`.

_Last refreshed: 2026-06-02 by Claude (hygiene run) — git claims verified against `git fetch`/`git log`/`git worktree list` (origin/main `ce407c3f`; local main fast-forwarded clean; 67 worktrees); PR set via `gh pr list` (27 open); Jira/Confluence drift via Atlassian MCP (SCRUM-1958 no page; SCRUM-1922 page 64258050 stale; 56 In Progress / 28 Blocked); disk reclaim via `df /` (38→43 GiB free). No new prod state asserted — the 2026-05-30 prod snapshot is carried forward, not re-verified._

### 2026-06-01 — audit-export org-lookup error classification (#1056, T2 draft — soak PENDING)

`services/worker/src/api/v1/audit-export.ts` misclassified a Supabase/operational failure on the `profiles.org_id` lookup as `403 Organization membership required`, hiding a 500-class fault. Both handlers (`POST /audit-export`, `POST /audit-export/batch`) used `.single()` without inspecting the returned `error`. Fix (mirrors `cpe-log-export.ts` / #1029): `.maybeSingle()` + an explicit `if (profileError) → 500` (coarse `message`/`code` log only, §1.4), reserving 403 for a successful query with a null `org_id`. TDD: two new regression cases (DB error → 500, not 403), one per handler, red→green; local check sweep clean (vitest, tsc, eslint, lint:copy). Parent feature: CML-03 / [SCRUM-267](https://arkova.atlassian.net/browse/SCRUM-267) (audit-ready GRC export, COMPLETE).

**Status:** **[#1056](https://github.com/carson-see/ArkovaCarson/pull/1056)** draft, **T2 — 12h staging soak PENDING**. No soak started: shared staging `ujtlwnoqfhtitcmsnrpq` has in-flight soaks (§1.11A). Stays draft until a clean staging window; Carson merges. No migration/RLS/schema/cron/queue surface → a clean shared-staging window suffices. Jira bug ticket + Confluence page + Bug Tracker row still outstanding.

_Last refreshed: 2026-06-01 by Claude — no prod or live-state asserted; in-flight draft PR only. Local checks (vitest / tsc --noEmit / eslint / lint:copy) clean; CI re-runs on #1056._

### 2026-05-30 (PO reconciliation pass) — last full prod-verified snapshot

A six-specialist reconciliation re-synced state against ACTUAL prod. **This is the most recent real prod verification** (carried forward above; not re-run on 2026-06-02).

**Prod truth (self-verified 2026-05-30):** last-deployed worker `git_sha 7af0ad9a` (PR #867 merge, SCRUM-1649; Cloud Run revision recorded that day), `/health` = healthy, `network=mainnet`, checks `{database:ok, anchoring:ok, kms:ok}`; last `deploy-worker.yml` run [26691941246](https://github.com/carson-see/ArkovaCarson/actions/runs/26691941246) = success. Prod DB (`vzwyaatejekddvltxyye`): RLS enabled+forced on all checked tables, **0 advisor ERRORs**, SECURITY DEFINER `search_path` 100% clean (148 funcs), migration head `0326`. `switchboard_flags`: AI_EXTRACTION/VERIFICATION_API/PROD_NETWORK_ANCHORING=`true`, SEMANTIC_SEARCH=`false`.

**Findings flagged for Carson (still open as of 2026-06-02):**
- **Bitcoin broadcast drift:** prod env `BITCOIN_UTXO_PROVIDER=mempool` → broadcast via **mempool.space**, NOT GetBlock (CLAUDE.md §1.1 asserts GetBlock-sovereign). `GetBlockHybridProvider` is built; selecting it needs `BITCOIN_UTXO_PROVIDER=getblock`. Flip = chain-touching T3. Confirm intended posture.
- **Flag env/DB divergence (fail-open hazard):** `ENABLE_SEMANTIC_SEARCH` + `ENABLE_AI_FRAUD` are OFF in DB but ON in Cloud Run env; a transient Supabase read failure trips the env fallback and silently re-enables both. Re-sync env→DB.
- **SCRUM-2203 (active prod incident):** `embed-public-records` Scheduler 500s every ~2 min (statement timeout on `get_unembedded_public_records`) since ~05-21. Fix in flight (PR #1022 / migration 0330).
- **SCRUM-1791:** `subscriptions.current_period_*` never rolls forward → entitlement gates fire on stale rows.
- **SCRUM-2193:** 2 `anchors` CHECK constraints (`cpe/cle_metadata_is_object`) are NOT VALID in prod while repo migration 0314/0315 declare them VALID — needs `VALIDATE CONSTRAINT` (`statement_timeout=0`) in a Carson psql window.
- **SCRUM-2192:** migration-ledger hygiene (54 timestamp/dup rows + 0302/0303 dup) — non-blocking; no `migration repair` without sign-off (§1.11A).

_Last refreshed: 2026-05-30 by Claude (PO reconciliation) — prod `/health` git_sha=7af0ad9a network=mainnet db/anchoring/kms=ok (self-curled); deploy-worker run [26691941246](https://github.com/carson-see/ArkovaCarson/actions/runs/26691941246) success on 7af0ad9a; prod DB via Supabase MCP on `vzwyaatejekddvltxyye` (relforcerowsecurity, get_advisors 0 ERROR, list_migrations head 0326, switchboard_flags); Cloud Run rev/env via `gcloud run services describe arkova-worker`._

---

## Open / release reference

**v1.0.0 — Platform v2 + Enterprise Hardening** (active release, Jira fixVersion `10266`, 10 epics; full status in Jira, not here):

| Priority | Epic |
|---|---|
| **Highest (P0 — blocks AI training)** | [SCRUM-1040 GEMB2](https://arkova.atlassian.net/browse/SCRUM-1040) |
| **Highest** | [SCRUM-1041 SEC-HARDEN](https://arkova.atlassian.net/browse/SCRUM-1041) |
| High | [SCRUM-1042 GCP-MAX](https://arkova.atlassian.net/browse/SCRUM-1042) · [SCRUM-1043 SOC2-TYPE2](https://arkova.atlassian.net/browse/SCRUM-1043) |
| Medium | [SCRUM-1044 MCP-EXPAND](https://arkova.atlassian.net/browse/SCRUM-1044) · [SCRUM-1046 PUBLIC-ORG](https://arkova.atlassian.net/browse/SCRUM-1046) · [SCRUM-1047 ADMIN-VIEW](https://arkova.atlassian.net/browse/SCRUM-1047) · [SCRUM-1048 CONNECTORS-V2](https://arkova.atlassian.net/browse/SCRUM-1048) · [SCRUM-1049 API-V2](https://arkova.atlassian.net/browse/SCRUM-1049) |
| Low | [SCRUM-1045 GH-CI-OPT](https://arkova.atlassian.net/browse/SCRUM-1045) |

**Gate:** [SCRUM-1040 GEMB2](https://arkova.atlassian.net/browse/SCRUM-1040) blocks further Nessie / Gemini Golden training. Vertex consolidation is Gemini-Golden-only; Nessie stays on Together.ai + Llama 3.1.

---

## Decision Log (durable)

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-24 | DocuSign completed-envelope intake uses raw-body HMAC, `organization_rule_events`, and retryable `job_queue` fetch jobs | Avoids new migrations, keeps raw Connect payloads/documents out of Postgres, gives failed fetches backoff + dead-letter. |
| 2026-04-24 | Manual rule "Run now" queues an execution row instead of synchronously running actions | Keeps the endpoint fast, preserves action-dispatch retry semantics + rate-limit controls. |
| 2026-04-23 | `search.arkova.ai` routes to `arkova.ai/o/:slug` via Cloudflare Worker | Brand-clean URL, single codebase, no auth-session leakage between public + app. |
| 2026-04-23 | Local-folder watcher deferred (cloud connectors only in v1) | Requires Electron/Tauri desktop surface; Drive + DocuSign cover ~95% of admin use cases. |
| 2026-04-23 | Vertex consolidation is Gemini-Golden-only | Nessie runs on Together.ai + Llama 3.1; no reason to migrate it. |
| 2026-04-23 | GEMB2 blocks further AI training | Avoid re-training against the old embedder; Gemini Embedding 2 is the new ground truth. |
| 2026-04-21 | `/api/treasury/health` is platform-admin-only (not org-admin) | USD aggregates are treasury state — only Arkova operators see them. |
| 2026-04-21 | Jira + Confluence are the canonical sources of truth | Repeated drift between CLAUDE.md / BACKLOG.md / Jira made the auditor view unreliable; `.md` files demoted to engineering notes. |
| 2026-04-16 | Vertex endpoint hygiene mandate | Idle intermediate-checkpoint endpoints were silently billing. Target 1–2 deployed; audit before/after tuning. |
| 2026-04-15 | Nessie strategy reset | v5 "87.2% F1" headline was measured against a non-serverless model. Narrow extraction per LoRA; deploy-proof before training. |
| 2026-03-22 | Pipeline anchoring creates individual anchors per document | Each document must appear in Treasury — batch-only is insufficient. |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence. |
| 2026-03-14 | MCP server uses Streamable HTTP transport | Native Cloudflare Workers compat. |

---

## Archive pointers

- Pre-2026-05-30 session narrative (2026-04 → 2026-05-29 entries): `git log HANDOFF.md` / git history.
- Pre-2026-04-21 HANDOFF.md: git history.
- CIBA release artifacts (migrations 0224–0231, worker modules, env vars): Confluence Data Model page + [ENV.md](docs/reference/ENV.md).
- `docs/archive/session-log.md` — older session notes. `docs/BACKLOG.md` — banner only, points at Jira.

---

_Last refreshed: 2026-06-29 by Claude (carson@arkova.io) — PI-0 S2 kickoff + Lane-2 S2 build close-out; claims verified against gcloud/MCP/CI/gh: prod worker `/health` git_sha=70b50223 healthy (mainnet, db/anchoring/kms ok) deployed by run 28400817406; prod migration head 0348 + 0343 absent via Supabase MCP on vzwyaatejekddvltxyye; 28 PRs merged 06-27→06-29 (origin/main d9773a64) via gh; Lane-2 draft PRs #1364/#1365/#1366 open. Prior footers remain in git history._
