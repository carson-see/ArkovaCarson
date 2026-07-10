# HANDOFF.md - Arkova Living State Snapshot

> **Purpose:** Current state of the project. Updated at the end of every session. Keep this short; historical detail belongs in git log, Jira, Confluence, Drive archives, or Supermemory.
>
> **Source-of-truth layering:**
> - **Jira** = story status, scope, acceptance criteria -> https://arkova.atlassian.net/jira/software/projects/SCRUM
> - **Confluence** (space "A") = topic docs + per-epic audit pages -> https://arkova.atlassian.net/wiki/spaces/A
> - **Bug tracker** = Confluence [Bug Tracker - Master Log](https://arkova.atlassian.net/wiki/spaces/A/pages/88768514)
> - **HANDOFF.md** = rolling snapshot of now, not a session transcript
> - **CLAUDE.md** = operating directive / rules
> - **git log** = what changed, by whom, when

---

## Now

### 2026-07-10 (RTE/ART) — S3.3 planned + CTO-ratified; Lane 4 chartered; T0 wave open (7 draft PRs); no soak/rig/prod mutation

**S3.3 ART planning held** (RTE + CTO + 3 lanes + research; founder directives integrated). Plan of record partially superseded by CTO rulings — six claims overturned with evidence: (1) **A/B candidate = v6, not v7** (v7's only eval is an in-tree FAIL "DO NOT CUT OVER", 11/16 gates, endpoint deleted — `services/worker/docs/eval/eval-gemini-golden-v7-vs-v6-2026-04-16.md:10`); v7.1 surgical retrain upgraded to unconditional-RUN (Google credits), window-entry gated on offline gates vs the frozen corpus; (2) exit criterion 3 STRUCK — tuned inference **shares base-model quota** (official docs) and prod is on the Developer-API surface (live env read: `GEMINI_MODEL=gemini-2.5-flash`, no `GEMINI_TUNED_MODEL`); replaced by five-bucket attribution + degradation + R-7 honesty; (3) drain invariant is **per-trigger** (org pass vs global flush); (4) 429 map corrected (perOrgRateLimit UNMOUNTED dead code; Vertex 429→`provider_error` misclassification); (5) provision Step-4 broken under `--apply` (3 defects → zero Scheduler jobs); (6) corpus scoped depth-first (full ~50/domain = 240–500h, refused). **Vertex inventory: ZERO tuned endpoints deployed anywhere** (v6/v7 model artifacts preserved); **prod drain topology: NO org-queue-scheduler job exists — prod drains global-only via 4 out-of-band Scheduler jobs absent from `scripts/gcp-setup/cloud-scheduler.sh`**. Plans: 4 Google Docs in the Drive sprint-scoping folder ("Arkova Sprint 3.3 ART Sprint, Testing & Release Plan — 2026-07-10" + 3 lane plans); spec 96894977 amendment pending.

**Lane 4 (Corpus & Data) chartered** (founder-authorized, CTO R11–R13): producer/acceptor separation — Lane 4 produces, L3 accepts every batch; wave 1 delivered: 81 held-out entries (50 licensing / 22 AU-KE / 9 OOD), 28/28 quality tests, datasheet ([#1498](https://github.com/carson-see/ArkovaCarson/pull/1498) draft).

**T0 wave PRs (all DRAFT, opened after tier fences — none Ready, none merged):** [#1492](https://github.com/carson-see/ArkovaCarson/pull/1492) L2-S2a-FIX provision Step-4 repair (rig-day blocker), [#1493](https://github.com/carson-see/ArkovaCarson/pull/1493) L2-S8 classify-backcatalog driver rescue + test, [#1495](https://github.com/carson-see/ArkovaCarson/pull/1495) L2-S0 five-bucket 429 map + drift lint, [#1497](https://github.com/carson-see/ArkovaCarson/pull/1497) L2-S1 sequencing gate, [#1494](https://github.com/carson-see/ArkovaCarson/pull/1494) L3-S0 candidate packet + Vertex inventory + multimodal spike memo, [#1496](https://github.com/carson-see/ArkovaCarson/pull/1496) L1 txid-journal design core (RTE ruling: split docs→T0, code folds into post-07-12 T3 wiring PR — tier detector correctly reads `src/jobs/` as T2), [#1498](https://github.com/carson-see/ArkovaCarson/pull/1498) L4 corpus wave 1. **Rig-day HELD** until 07-12 T3 train + prod migration chain + #1492 merge; earliest eval window after that. Jira: epic SCRUM-2670 stories SCRUM-2677–2699 filed + bugs 2701/2703/2705/2707; SCRUM-2673 → Done vs #1465 (residuals split to 2697); #1461 tier note posted (T3, not tonight's T2 set). Local checkout drift resolved: 1 file rescued via #1493, rest archived to session scratchpad + restored (all verified BEHIND main). **Two lane agents died on the account API spend limit** mid-wave; RTE completed their deterministic finish work from the worktrees — raise the limit before the next parallel wave.

_Verified via: gcloud (prod env read rev arkova-worker-01031-xem; `gcloud ai endpoints list` = 0 items us-central1/us-east4; `gcloud scheduler jobs list` topology in docs/lane1/s33-prod-drain-topology.md PR #1496); `gh pr view/create` #1492–#1498; Jira MCP creates/transitions (SCRUM-2670 tree, 2673 Done); Drive doc creates (4 plan docs); Confluence footer comment 98369537 on 88768514; eval record in-tree. No soak, rig, secret, prod, or migration state changed; nothing merged; nothing marked Ready._

### 2026-07-10 (RTE) — S3 release wave: 3 merged; mass soak-runner death detected + all 14 open PRs relaunched on verified clocks

**Merged:** [#1415](https://github.com/carson-see/ArkovaCarson/pull/1415) CPE/CLE export SECURED-gate (worker deployed healthy, `/health` git_sha `c104cc36`, deploy run 2026-07-10T13:17Z success), [#1458](https://github.com/carson-see/ArkovaCarson/pull/1458) false EU-US DPF claim removed (SCRUM-2283 stays open — counsel owns the real transfer basis), [#1416](https://github.com/carson-see/ArkovaCarson/pull/1416) WEBEXT NER self-contained bundle (gate fixed by dropping self-carried checker edits superseded by #1490).

**Mass runner death:** ALL soak load-runners died 2026-07-09T21:25Z–2026-07-10T06:23Z (host session death; verified via `gcloud logging read` request-continuity audit per rig). Every "RUNNING" soak claim was false. All 14 open PRs relaunched with fresh clocks + truthful body updates; gap-waivers uniformly rejected. New windows: T2 (#1471/#1443/#1441/#1439) mature 2026-07-11 ~01:50–02:37Z; T3 (#1408/#1410/#1417/#1427/#1455/#1457/#1459/#1461/#1462) mature 2026-07-12 ~13:52–14:13Z. #1461 runs on Cloud Scheduler (`soak-pr1461-runner`) — the durable pattern; the rest are host-local nohup+caffeinate (survive session death, NOT reboot — **do not reboot/logout the host before 2026-07-12 ~14:30Z**). #1413: GitHub-conflict resolved (union merges → head `7c54a4ff`), rig redeployed via canonical deploy.sh (staging_deploy_log id 223, clean_mirror preflight on `xhoaxtodbslazitlnhgy`); prior soak death root-caused to 1h rig JWT expiry (pool now 14h). #1427 rig preflight now `clean_mirror` at exact head from a PR-head worktree (preflight judges ledger legitimacy against the checkout's migration files — always run it from the PR's head).

**Merge order constraints:** ledger contiguity (prod head 0353, verified via Supabase MCP) forces #1410 → #1427 (0354) → #1457 (0355/0356) → #1455 (0357); RTE prod-applies each per §0 rule 10 as it lands. Webhooks: #1471 before #1443 (delivery.ts byte-identical; scripts-only conflict on the second = tooling-only residual-risk note, no re-soak). #1455+#1462 share Supabase `nwbrkwjkoyabazfpxjbt` — accepted with cross-soak disclosures in both bodies (0357 GUC-OFF inert for #1462's traffic).

**Hygiene sweeps (week 07-06..07-10, 43 merged PRs):** Jira/Confluence — 17 tickets → Done, 19 subtasks closed, 13 Confluence pages created, 4 bug-tracker rows verified on 88768514, SCRUM-2352 mislabel corrected to SCRUM-2624; left open with reasons: SCRUM-2501 (contract only), SCRUM-2377 (needs CE reconciliation note), SCRUM-2603 (fix unbuilt), SCRUM-2283 (counsel). GitHub — 30 merged-PR remote branches deleted, 74 stale bot review threads resolved, 0 label noise; 529 merged local branches + 19 merged-PR worktrees flagged for post-wave cleanup (some hold soak artifacts — do not prune before T3 wave lands).

**Dev-resume conditions (active):** no commits to the 14 soaking branches; new branches off main; next free migration **0358**; no soak-rig touches; no host reboot/logout before the T3 wave closes.

**Prod watch item:** `/health` reports `lastSecuredAt` 2026-06-29 with `pendingCount: 0` — quiet intake, not an alert; check funnels.

_Verified via: prod `/health` (git_sha c104cc36, db/anchoring/kms ok) + `gh run list --workflow deploy-worker.yml` (13:17Z success); `gcloud logging read` per-rig request continuity; Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (ledger head 0353); `gh pr list/checks/view` across all 17 PRs; specialist reports with per-rig `/health` git_sha checks, staging_deploy_log id 223, preflight artifacts._


### 2026-07-07 (Lane 2 / S3) — 5 draft PRs delivered + reviewed; migration-reality correction

**Migration ledger reality (correcting a branch-checkout staleness that misled S3 planning):** the live prod ledger head is **0353** — `0343` (connector_artifact), `0349` (reconciler fix), `0350`, `0351`, `0352`, `0353` are ALL applied to prod `vzwyaatejekddvltxyye`. The connector loop is unblocked at the schema level; the "0343 prod-apply blocker" that appeared in an early S3 plan draft was stale feature-branch HANDOFF data, not reality. **Next-free Lane-2 migration prefix = 0355** (0354 is reserved by Lane-1 draft #1427).

**Lane-2 S3 first execution wave (all DRAFT; code-only, nothing soaked this session by design — RM owns soak scheduling). Each is green on all CI gates except the Staging Soak Evidence Gate (honest PENDING) unless noted:**
- **[#1438](https://github.com/carson-see/ArkovaCarson/pull/1438)** SCRUM-2495 does-not-assert disclaimer (T2) — + a claims-review sweep that scoped app-wide "permanently secured/anchored" copy to the *fingerprint*, never the document. UAT 1280/375 in `docs/uat/pr-1438/`.
- **[#1439](https://github.com/carson-see/ArkovaCarson/pull/1439)** SCRUM-2501 FE-PROOF-GATE 3-state + E2E (T2) — built to the #1405 contract; stacked with the additive `proof_error_code` 404-discriminator follow-up. *Residual TypeCheck red = the ART-wide `react-hooks/set-state-in-effect` regression (see below), not this PR's code.*
- **[#1441](https://github.com/carson-see/ArkovaCarson/pull/1441)** SCRUM-2401 OPS-03 SLO dashboards (T2) — 5 live surfaces, platform-admin-gated. Review fixes: connector depth via planner-estimated count (not a row sample); worker↔frontend contract types isolated in `src/types/opsSlo.ts` (CPD-excluded like `database.types.ts`). SonarCloud green.
- **[#1443](https://github.com/carson-see/ArkovaCarson/pull/1443)** SCRUM-2396/97/98 WH-01..03 webhook catalog + test-ping + replay/DLQ UI (T1/T2) — closed a real gap: the webhook API was API-key-only; added a JWT self-service bridge (same SSRF guard, audit events on replay, metadata-only DLQ).
- **[#1434](https://github.com/carson-see/ArkovaCarson/pull/1434)** SCRUM-2625 QUEUE-10 drain hardening (T2) — F-1 reaper + F-3 were already on main (from #1366's review); real gap was F-4: alert reason strings now PII-scrubbed centrally.

**ART-level CI flags raised (not Lane-2 defects):** (1) dependabot bump **f79f7622** enabled a strict `react-hooks/set-state-in-effect` rule that now fails `TypeCheck & Lint --max-warnings 0` for frontend PRs containing pre-existing violations (Lane-3 `ConnectIssuerDialog.tsx`, `IssuerPartnershipsPage.tsx`) — needs a lane-neutral hotfix. (2) The handoff-claims two-dot base-drift bug (fix pending in open PR **#1429**) intermittently false-flags Policy Lints on frontend PRs. Ceremony record: Confluence [94928898](https://arkova.atlassian.net/wiki/spaces/A/pages/94928898); Drive Sprint-3 plan mirror.

### 2026-07-06 (Lane 3 SM) — PI-0 S3 Lane-3 built to ready-for-release-team (3 draft PRs); connector-loop 0343 now LIVE in prod

**Prod truth (verified read-only, 2026-07-06):** worker **git_sha `0dd7bc9f`**, `/health` healthy (mainnet; db/anchoring/kms ok). Prod (`vzwyaatejekddvltxyye`) migration ledger head **0353** (numeric, contiguous 0341->0353; 0344 correctly absent/renumbered-to-0349). `origin/main` = `5b35e9cb` (#1444); 21 PRs open. **Connector-loop launch-blocker CLEARED: mig `0343` (`connector_artifact`) is NOW IN PROD** (was the standing "0343 NOT in prod" blocker). This train also landed **#1380** (Drive DRIVE-01/02/03/06 + mig `0351`) MERGED 07-06 17:32Z and **#1367** (Lane-2 QUEUE-09 fair connector-drain + mig `0350`) MERGED 07-06 17:48Z; **#1398** (the 0352/0353 ledger-exemption stopgap) was **CLOSED/superseded** — orphan rows `0352`/`0353` legitimized by their owning Lane-2 PRs merging. Connector producer/consumer flags stay OFF in prod (go-live gated on a both-sides soak).

**Lane 3 PI-0 Sprint 3 (executed early at founder direction; migration-free; nothing merged/soaked by Claude):** 6-persona team (incl. a PO persona — Carson is founder, NOT the PO) → refinement/planning/release-plan/pre-mortem → 3 worktree-isolated TDD build streams → adversarial `/code-review` (12 confirmed findings, 0 shipped-prod breaks) → `/debug` red-first fixes → 2 founder-P1 rounds → clean re-review → ceremonies + reports. **3 draft PRs (all green except #1415's pre-soak Staging gate; DRAFT, awaiting the release team's soak + merge):** **#1412** `lane3/s3-ce` @ `aaea5a06` (CE-04 ContactHour/ValueProfile SCRUM-2375 + CE-06a fail-closed claims gate 2377a; export-only v1.0); **#1413** `lane3/s3-ai` @ `b95851d5` (AI-01 golden set 2381 + AI-02 F1>=0.80 eval gate 2382 + AI-03 template-review MVP 2383); **#1415** `lane3/s3-cpe-cle` @ `c39aa896` (CPE-01 2378 / CLE-01 2379 / CPE-02 org dashboard 2380). Founder P1s both fixed STRUCTURALLY (#1413 recursive byte-smuggling guard; #1415 CLE bucket preflight in the shared upload seam). 2 pre-existing prod bugs found+logged+fixed: BUG-2026-07-06-002 / **SCRUM-2630** (P1 `revocationReason` PII on public CTDL endpoint) + BUG-2026-07-06-003 / **SCRUM-2631** (P2 Zod-v4 `uuid()` blocked valid CPE/CLE exports). Founder ruling (on #1413): AI **extraction-decision path (AI-03)** re-tiered **T2->T3** (load-soak >=5k users/hr, eval gate run LIVE during it). **Warning:** a green "Staging Soak Evidence Gate" on #1412/#1413 is field-presence, NOT soak — none of the 3 PRs have real soak evidence yet. Reports (Drive `ARKOVA PI-0-S3`): Sprint-3 Plan `1geJcMuW4RdxhUSkIPUa20iSiAyweTmKdOFK3uWYNeNM` + Pre-Release Report `1Gzw417Jafx6fRWuvOf6_XpbuqIQxNJjnMlVPbYz_UHw`; supermemory `H4iBRavvD4zpDBKVhGvghN`. **Open constitution gates 2/3 (Jira transitions + per-story Confluence pages) + UAT screenshots NOT closed on the 8 stories → NOT "Done".** S4 carries: CE-06b Jeanne sign-off (blocked-on-partner, CE trial ~2026-09-09), #1380 2xx-at-volume soak, RLS member-scoping migration (T3), live-Gemini eval recording + `--require-live` CI wiring, per-field-confidence follow-up. Codified: multi-commit agent work on the resumable Workflow rail ONLY (2 raw-background fix waves died 0-salvage); under a sustained API 529, pivot to the main loop; CI now rejects `worktree-*` head branches.

_Verified via: Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (ledger head 0353; 0343/0350/0351/0352/0353 present); Cloud Run `/health` git_sha `0dd7bc9f` healthy mainnet; `gh pr view` #1380/#1367 MERGED 07-06 + #1398 CLOSED + #1412/#1413/#1415 open-draft; `git log origin/main` HEAD `5b35e9cb`. No prod schema/worker state changed by Claude; nothing merged; nothing soaked._

### 2026-07-06 (tooling) — lint:copy multi-line-JSX blind spot CLOSED (SCRUM-2666, PR #1440, T0)

The `lint:copy` per-line scan short-circuited raw JSX text lines (no quote char + no same-line `<`/`>` pair) — the blind spot that shipped "Bitcoin blockchain" in `PublicVerification.tsx:658` (copy removal owned by open PR #1433). Fixed with a cross-line **context-stack** JSX state machine (`scanFileContent()` in `scripts/check-copy-terms.ts`) that also tracks copy inside `{cond && (…)}` renders, `.map()` callbacks, and fragments; 28 red-first tests + fixture (`scripts/fixtures/`). Round-2 adversarial review (parallel refuter agent) killed the round-1 flat machine — closing-tag guard bug had put 1,932 code lines into force-scan mode; all 8 confirmed findings fixed + test-locked; post-fix census: 0 code-shaped force-scanned lines. Fixed-scanner sweep of the full 356-file scope found exactly 3 pre-existing hits, all grandfathered with retirement conditions in `copy-terms-baseline.json`: PublicVerification 658 ×2 (retire on #1433 merge) + `PipelineAdminPage.tsx:1196` "worker service" (UX-03; reword-vs-ops-exclusion follow-up session spawned). Also allowlisted `scripts/check-copy-terms*.ts` + `scripts/fixtures/` as T0 tooling in `check-staging-evidence.ts` (was falling through to T1 "default frontend"). Bug row BUG-2026-07-06-004 in the master log; Jira SCRUM-2666 In Progress; Confluence page 96108545.

_Verified via: `npx vitest run scripts/check-copy-terms.test.ts` (115/115) + `scripts/ci/check-staging-evidence.test.ts` (165/165); `npm run lint:copy` (0 new, 11 grandfathered, 0 stale); `tsc --noEmit` (0); `requiredTierFor(<changed files>)` → T0; instrumented repo census (4,855 continuation lines, 0 code-shaped); PR https://github.com/carson-see/ArkovaCarson/pull/1440. No prod/staging/schema state asserted or changed._

### 2026-07-06 (RTE/ART) - Final Sprint 3.25/3.5/3.75/3.8/3.85/3.9 artifact packet

Use this clean final-artifacts folder for founder review: https://drive.google.com/drive/folders/1ItbVr6LtLMzif20hCUwEClYhcHYUsddd.

It intentionally contains only the current final sprint artifacts:
- Sprint 3.25 ART Launch Bug Sprint Report: https://docs.google.com/document/d/1r4_OSv0_5XlD2Lp0mJ8DcCPHR2xqEB3UtoF7haQJqIk/edit?usp=drivesdk
- Sprint 3.5 Release Confidence ART Plan: https://docs.google.com/document/d/1_JkNoMBjthykcS7fPTSmpFhme9ttfVS6H2BGQA_SOEc/edit?usp=drivesdk
- Corrected Sprint 3.75 / PI-1 CE-Haki Critical Path + 12-Hour Release Priority: https://docs.google.com/document/d/1wze9aOe-A4yNoW4tSqWjzC-VtwjEupTy5DAcsQPOFos/edit?usp=drivesdk
- Sprint 3.8 Program Administrator Provisioning & Internal Controls ART Plan: https://docs.google.com/document/d/1cqv_rOc-YnGo0w3ri6VVrsHUIGoHKxd1M4rDaPwoYfI/edit?usp=drivesdk
- Sprint 3.85 Launch Trust / Security / Privacy / Usability Gap Sweep ART Plan: https://docs.google.com/document/d/19ptuJWHViaCe8y4F6_zgwrmAPAmsdL6c65D9W_F79RY/edit?usp=drivesdk
- Sprint 3.9 Sprint 4 Readiness Evidence / UAT / Founder Go-No-Go ART Plan: https://docs.google.com/document/d/17Qyd4kBEJWWdyZbZLSWTtgV9YhCHNHNQCiDFnm-NyK4/edit?usp=drivesdk

Current sprint interpretation:
- **3.25:** launch-blocker hardening sprint. Lane 2 first for security/privacy/legal risk; Lane 1 second for proof/chain integrity; Lane 3 third for public verification/API trust. Planning/report/story packet is done; this does **not** assert the underlying bugs are fixed/live.
- **3.5:** Release Confidence / CI-CD / staging parity after 3.25. Supabase work remains a supporting workstream, not the whole sprint.
- **3.75:** corrected PI-1 S1-S7 Credential Engine + HakiChain critical-path reconciliation. This is not a standalone "make CE/Haki done" sprint and does not replace the PI-1 sequencing.
- **3.8:** program administrator provisioning and internal controls sprint. Lane 2 leads; CTO/RM/Security review required; Lane 1 consults on evidence integrity; Lane 3 consults on CE/Haki/program account scope.
- **3.85:** launch trust/security/privacy/usability closure-evidence sprint. Lane 2 has top priority for operational/user-visible risk; Lane 1 second for security/privacy/proof gates; Lane 3 third for public verification, AI/PII, and CE/Haki smoke evidence. This does **not** replace Sprint 3.0 or 3.5.
- **3.9:** Sprint 4 readiness evidence sprint after 3.85. It packages founder go/no-go, current UAT, CE/Haki acceptance bridge evidence, incident/support/rollback proof, backup/restore proof, API onboarding, privacy ops, and status/config-drift evidence. It is not a hiding place for unresolved 3.85 P0s.

Sprint 3.0 active execution state - do not erase:
- Sprint 3.0 is still active. The 3.25/3.5/3.75/3.8 planning packet does **not** mean Sprint 3.0 is complete, merged, live, or soaked.
- As of the 2026-07-06 PR check, open S3 story PRs remain draft/blocked/dirty across all lanes. Nothing in this documentation cleanup accepts launch soak or replaces lane-level delivery evidence.
- Lane 1 still has open proof/chain/verifier work: `#1408` chain resilience, `#1410` back-catalogue classifier, `#1411` verifier parity, `#1416` web extension vendor fix, `#1417` batch anchoring producer, `#1427` proof completeness migration/write path, and `#1433` proof-surface disclaimer.
- Lane 2 still has launch-critical queue/security follow-through: `#1434` QUEUE-10 drain hardening / SCRUM-2625 is open and blocked; OPS-03 dashboards and QUEUE-08 instant-secure remain Sprint-4 entry criteria unless Jira/PR evidence explicitly closes them.
- Lane 3 still has CE/Haki/public-trust S3 work open: `#1412` CE mapping/fail-closed claims gate, `#1413` AI golden set/eval/template review, and `#1415` CPE/CLE secured export/dashboard.
- Release/CI management still has open support PRs: `#1428` prod-tables snapshot refresh is unstable/dequeued and `#1429` TLA jar/handoff-claims hotfix is blocked.
- Do not start clean Sprint 4 / 3.25 integration as "post-S3" work until these S3 inputs are merged, closed as intentionally deferred, or explicitly risk-accepted by CTO/RM/ART. No 48-hour launch proving soak is asserted here.

Jira / Confluence trace:
- Sprint 3.25 trace: `SCRUM-2483` comment `16785`
- Sprint 3.5 trace: `SCRUM-2312` comment `16786`
- Sprint 3.75 CE trace: `SCRUM-1867` comment `16787`
- Sprint 3.75 Haki trace: `SCRUM-1010` comment `16788`
- Sprint 3.8 anchor: `SCRUM-2637`, comment `16789`
- Sprint 3.85 epic: `SCRUM-2638`, comment `16790`; Confluence page `95944705`
- Sprint 3.9 epic: `SCRUM-2639`, comment `16791`; Confluence page `95977473`
- Sprint 3.85/3.9 JQL: https://arkova.atlassian.net/issues?jql=project%20%3D%20SCRUM%20AND%20labels%20in%20(sprint-3-85%2C%20sprint-3-9)%20ORDER%20BY%20key%20ASC
- Confluence roadmap trace: page `82444290` footer comment `95780866`
- Confluence program-board trace: page `85622786` footer comment `95715332`

Archive / stale guidance:
- Legacy session packet folder: https://drive.google.com/drive/folders/1cQ5rbbFStwDRI870su-gpm-Ud7Aq_JrB
- Founder-provided Archive root: https://drive.google.com/drive/folders/1uA7CQZohx50gHTAX9cFjQvg8hBg3Raq0
- Session archive subfolder: https://drive.google.com/drive/folders/1smgQGFggH5vLpk02AiUWFdrMVP4VG6Vb
- Do not use the superseded 3.75 report, old 12-hour arbitration report, original Bug Hunt report, original Sprint 4 prioritization report, or Supabase meeting notes as current guidance.

Known loose ends:
- SSD backup remains pending; no Crucial SSD backup state changed in this session.
- No production, schema, deploy, runtime, or database state changed by the documentation/refinement pass.
- Two older pre-existing lane docs still appear in the legacy S3 folder because Drive returned `appNotAuthorizedToFile` even after Archive access was granted: `1OAltgtonRD39SvHYh-9foTk7zj8lY5YxZX5tUO9GuXI` and `1jl7KoMryRrmgWM9afFvXjmmPbfpwnzx6hwOcG7fOE68`.

_Last refreshed: 2026-07-06 by Codex - verified against Drive readback for final folder `1ItbVr6LtLMzif20hCUwEClYhcHYUsddd`, docs `1r4_OSv0_5XlD2Lp0mJ8DcCPHR2xqEB3UtoF7haQJqIk`, `1_JkNoMBjthykcS7fPTSmpFhme9ttfVS6H2BGQA_SOEc`, `1wze9aOe-A4yNoW4tSqWjzC-VtwjEupTy5DAcsQPOFos`, `1cqv_rOc-YnGo0w3ri6VVrsHUIGoHKxd1M4rDaPwoYfI`, `19ptuJWHViaCe8y4F6_zgwrmAPAmsdL6c65D9W_F79RY`, and `17Qyd4kBEJWWdyZbZLSWTtgV9YhCHNHNQCiDFnm-NyK4`; Jira/Confluence trace above; GitHub PR check restored Sprint 3.0 active state; Supermemory saves `CKbwLFbkWtWtDgLRS5ofb6`, `57e6zJKR4SgazS1gKPZrj1`, `ihUSJZ8Tv15MMYxfyhzA3u`, `BZTruDzwRqg29Vcm3QL1qE`, `me9Tr3Qpdx1KkDAuPkywL7`, `AS8CbDkqRGyRUMeoWKG55D`, and `t4D2F5KyrY2YhbdMwzypLV`._

_Last refreshed: 2026-07-07 by Claude — claims verified against gcloud/MCP/CI output (Supabase MCP migration listing on prod `vzwyaatejekddvltxyye`; `gh pr view`/`gh pr checks` for #1434/#1438/#1439/#1441/#1443; Confluence https://arkova.atlassian.net/wiki/spaces/A/pages/94928898)._

_Last refreshed: 2026-07-10 by Claude (RTE/ART, S3.3 planning session) — claims verified against gcloud/MCP/CI output (prod env read rev arkova-worker-01031-xem; gcloud ai endpoints list = 0; prod Scheduler topology per PR #1496 docs; gh pr create #1492–#1498 all draft; Jira MCP SCRUM-2670 tree + 2673 transition; Drive/Confluence create responses; prior entry's artifacts unchanged)._
