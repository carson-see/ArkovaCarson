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

### 2026-06-19 — Lane 3 Sprint-0 slice filed; CE secret hardened in place

Lane 3 (Credential Network & Intelligence) — the **last open Sprint-0 lane** (L1+L2 done) — delivered its slice (T0 design/audit) + executed the in-scope CE custody hardening. **Nothing merged; no existing PR/branch/soak touched** (Train C #1154, Train D rigs, #1208/#1211/#1213 hands-off). PR **#1224** (`lane3/s0-ce-custody-bq-design`, head `67e2c67e`, base `f3f72767`, **draft** (CI pending — promote on green), milestone Sprint 0); Jira **SCRUM-2542** (Needs Human; ↳ 2543/2544/2545 Done, 2546 continuation/merge) under SCRUM-2513; Confluence **85393410**; Drive report in *ARKOVA PI-1-S0*.

- **CE custody (S0-7.2 ↔ SCRUM-1867):** the CE key was **already** in Secret Manager (`Credential_Engine`, project `arkova1`). Hardened in place — per-secret `roles/secretmanager.secretAccessor` for the worker runtime SA (`270018525501-compute@…`, us-central1) + inventory labels; **verified via `gcloud secrets get-iam-policy Credential_Engine`** (SA → secretAccessor present) + `describe` (labels set). Value never read; additive (project grant unaffected); no move/rename. Dead rotation reminder (`secret-rotation-reminder.ts`, SCRUM-2536) wiring = Sprint-1. **No early CE continuation email** (premature); near-term action = consuming smoke (SCRUM-1921); continuation via the existing Jeanne/Jeff channel near the ~2026-09-09 trial cliff (R-1). SEC-HARDEN (SCRUM-1041) handed the project-wide-vs-per-secret IAM estate decision.
- **BigQuery (↔ SCRUM-1062):** NOT greenfield — the 5-table `arkova_analytics` mirror is shipped (migration 0297). Designed a PII-safe extension (credit-ledger / connector / AI-usage mirrors + marts); prod-deployment of the existing pipeline unverified (Sprint-1 task-0).
- **Partnership audit (S0-E2):** corrected the brief's stale IDs — HakiChain launch = SCRUM-1703 (1010 is CIBA); CPE/CLE epics = 1845/1865 (1962/1963 are eval-gate stories). Gate rows (CE/CASA/Kenya) supplied to S0-7.1 (SCRUM-2523).

_Last refreshed: 2026-06-19 by Claude (carson@arkova.io) — claims verified against gcloud (`secrets get-iam-policy`/`describe` on `Credential_Engine`: worker SA has secretAccessor; labels owner/category/service/risk/rotation-cadence) + Atlassian/GitHub MCP (PR #1224 draft, CI pending; SCRUM-2542/2543/2544/2545/2546; Confluence 85393410)._

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

_Last refreshed: 2026-06-05 by Claude (carson@arkova.io) — claims verified against gcloud/MCP/CI output._
