# S0-E4 — Release-Management Process Fixes (Parallel-Safe Pipeline)
## Refinement · Planning · Pre-Mortem

> **Engineering note, not Confluence documentation.** Per CLAUDE.md §0 rule 4,
> the canonical S0-E4 spec lives in the Sprint 0 doc (Drive folder `PI-1-S0`) and
> the Confluence Sprint-0 AUDIT page (83689473). This file is the working record
> of the three ceremonies the train ran before coding, plus the execution log.
>
> **Epic:** S0-E4 (Sprint 0). Reuses parent Epic SCRUM-2313 (RELEASE-OPS); story
> S0-4.2 reuses SCRUM-2500. **Owners (personas):** RTE + Release Manager + DBA,
> Tech Lead reviewing. **Retires roadmap risk R-3** (T3 soak throughput can't
> absorb 3-lane volume). **Hard prerequisite for any parallel T3 soak in Sprints 1+.**
>
> **Merge authority:** Carson is the sole merge gate (T2/T3 surfaces + the live
> infra/branch-protection actions below). Nothing here is merged by the train.

---

## 0. Inputs read in full (session start)

- 12-Month Technical Roadmap v3 (Confluence 82444290 / Drive) — Part IV risk R-3,
  Part VI "Release eng: isolated soak-rig automation; full-ledger CI audit (SCRUM-2500)".
- PI-1 Program Increment Plan (Master) — §6 critical paths, §7 release/soak
  serialization + tiered merge.
- Sprint 0 — Foundation & Hardening (Plan + Jira Backlog) — EPIC S0-E4 stories
  S0-4.1 / S0-4.2 / S0-4.3 + ACs + subtasks; Part B EPIC 4 (T2; reuse 2313/2500).
- PI-1 Sprint 0 — Lane 1 Sprint Report — S0-E4 logged **NOT STARTED**, "train
  RTE/RelMgr/DBA epic … NON-NEGOTIABLE before Sprint 1".
- Repo grounding: `.github/workflows/migration-drift.yml`, `scripts/ci/check-migration-prefix-uniqueness.ts`,
  `scripts/ci/check-staging-evidence.ts` (`requiredTierFor` / `PATH_RULES` / `STAGING_TOOLING_ALLOW`),
  `.mergify.yml`, `docs/reference/STAGING_RIG.md`, `supabase/migrations/agents.md`, CLAUDE.md §0/§1.11/§1.11A/§1.12/§6.

---

## 1. REFINEMENT

### 1.1 Story breakdown (from the Sprint 0 doc, verbatim AC)

| Story | AC | Subtasks |
|---|---|---|
| **S0-4.1** Isolated soak-rig provision/teardown | provisions clean isolated Supabase project + wired `*-staging` Cloud Run + `clean_mirror` preflight; teardown reclaims + flags paid projects; **2 T3 trains soak concurrently in a rehearsal** | provision script · teardown + paid-project flag · rehearse 2 concurrent soaks · runbook |
| **S0-4.2** [SCRUM-2500] Full-ledger numeric-integrity CI audit | CI checks the **ENTIRE ledger** for numeric-prefix + duplicate name/version (**not just PR-diff**); an **injected timestamp row fails in test**; stale exemptions removed once green | audit script + fixture · wire into CI · remove stale exemptions |
| **S0-4.3** Mergify/stacked-PR playbook + tiered-merge codified | playbook (per-PR `agents.md` block titling; "delete base branch to auto-retarget"; dequeue-before-edit); tiered-merge **tier computed by path detector, fails closed to "needs Carson"**; council + daily digest | playbook + CI lint for `agents.md` collision · codify tiered-merge in branch protection + Mergify (Carson-reviewed) |

### 1.2 What already exists (reuse, don't rebuild)

- **`scripts/ci/check-migration-prefix-uniqueness.ts`** (SCRUM-1287): blocks *new local file* prefix collisions only. S0-4.2 is broader — it audits the **prod ledger** (`version`/`name` integrity, the timestamp-regression class) which prefix-uniqueness never sees.
- **`scripts/ci/check-staging-evidence.ts` → `requiredTierFor(files)` + `PATH_RULES`**: a battle-tested path→tier detector. S0-4.3's "tier computed by path detector, fails closed to needs Carson" **reuses this exact function** — no second detector.
- **`.github/workflows/migration-drift.yml`**: PR-diff drift gate + the `exempt_regex` holding the stale `0299–0310` ledger exemptions. S0-4.2 is the *full-ledger* complement that makes those exemptions safe to retire.
- **`STAGING_TOOLING_ALLOW`** in `check-staging-evidence.ts`: the registry that classifies CI tooling as T0. New CI checks register here (the file self-exempts), so the audit is honestly tiered.

### 1.3 Issues surfaced in refinement (→ addressed in §4)

- **R1 (DBA).** "ENTIRE ledger" is the **prod** `supabase_migrations.schema_migrations` (the thing that silently re-regressed on 2026-06-15). CI cannot mutate prod and a sandboxed agent cannot verify prod state. **Resolution:** the audit is a *pure validator* over a ledger payload; CI fetches the live prod ledger read-only (reusing the migration-drift.yml auth pattern); tests drive the validator with fixtures (incl. the injected-timestamp row). It **also** runs a network-free local-file integrity pass so it has value even with no token.
- **R2 (RelMgr).** S0-4.1's "2 concurrent T3 soak **rehearsal**" provisions **real paid** Supabase projects + Cloud Run = cost + infra mutation, gated by §1.11A. **Resolution:** ship idempotent provision/teardown scripts that **default to `--dry-run`** (print the plan, mutate nothing) + a runbook; the *live* 2-rig rehearsal is a Carson-gated checklist step, not run by the train.
- **R3 (RTE).** Codifying tiered-merge in **branch protection + Mergify** is itself a T2 control-plane change owned by Carson. **Resolution:** ship the *computation* (a script the council/CI runs) + the playbook + a **drafted** `.mergify.yml`/branch-protection diff for Carson to apply. Do not mutate branch protection or Mergify from the train.
- **R4 (DBA).** "remove stale exemptions" (migration-drift `exempt_regex`) is **fail-closed**: a wrong removal blocks *every* PR. It is only safe once the new audit proves prod is numeric for those prefixes. **Resolution:** removal is a Carson-gated follow-up, gated on the new audit going green against prod; documented, not done blind here.
- **R5 (Tech Lead).** Tier of the deliverable. The *process scope* of S0-E4 is "T2", but the *artifact* shipped here is CI scripts + tests + docs + `scripts/staging/*` + a `ci.yml` step — all **T0-only** per `requiredTierFor` once the new checks are registered in `STAGING_TOOLING_ALLOW`. The genuinely T2/T3 actions (branch-protection apply, Mergify apply, live rig rehearsal, prod exemption removal) are explicitly carved out to Carson. **Resolution:** keep the train PR a clean T0; never claim a soak.

### 1.4 Definition of Ready — met

AC unambiguous ✓ · dependencies known (reuses 2313/2500/`requiredTierFor`/migration-drift auth) ✓ · test strategy clear (pure validators + fixtures, vitest already globs `scripts/**/*.test.ts`) ✓ · risky/irreversible actions identified + gated to Carson ✓.

---

## 2. PLANNING

### 2.1 Scope split — train-now vs Carson-gated

| # | Deliverable | Owner | Tier of artifact | Status target |
|---|---|---|---|---|
| 4.2a | `check-ledger-numeric-integrity.ts` pure validators + CLI | DBA | T0 | **build now (TDD)** |
| 4.2b | Fixtures incl. injected-timestamp-fails-in-test | DBA | T0 | **build now** |
| 4.2c | Wire audit into `ci.yml` (read-only prod fetch, fail-closed on bad token) | RTE | T0 | **build now** |
| 4.2d | Remove stale `migration-drift.yml` exemptions | DBA | T2 | **Carson-gated** (after 4.2c green vs prod) |
| 4.3a | `check-agents-md-migration-collision.ts` lint + tests | RTE | T0 | **build now** |
| 4.3b | `compute-merge-authority.ts` (reuses `requiredTierFor`, fails closed) + tests | RTE | T0 | **build now** |
| 4.3c | Mergify/stacked-PR + tiered-merge **playbook** | RTE | T0 (docs) | **build now** |
| 4.3d | Apply tiered-merge to branch protection + `.mergify.yml` | Carson | T2 | **Carson-gated** (drafted in playbook) |
| 4.1a | `provision-isolated-rig.sh` + `teardown-isolated-rig.sh` (dry-run default) | RelMgr | T0 (`scripts/staging/`) | **build now** |
| 4.1b | Staging-rig automation runbook | RelMgr | T0 (docs) | **build now** |
| 4.1c | Live 2-concurrent-soak rehearsal | Carson | T3 | **Carson-gated** (runbook checklist) |

### 2.2 Sequencing & DoD

Order: **4.2 → 4.3 → 4.1** (4.2 is the highest-value risk-retirement; 4.1 the most infra-coupled). Each artifact: tests written-first (red→green), typecheck clean, registered in the tier allow-list, documented. Branch `claude/s0-e4-refinement-planning-myy61i`; commit + push; **do not open a PR or merge** unless Carson asks. Jira/Confluence transitions are Carson/Planning-gated (the train leaves stories in their current state with an honest comment).

---

## 3. PRE-MORTEM ("it's Sprint 3 and S0-E4 made things worse")

| # | Failure imagined | Likelihood×Impact | Mitigation applied |
|---|---|---|---|
| P1 | New full-ledger audit is **fail-open** when the Supabase token is missing (the 2026-04-24 / SCRUM-1182 class) → green while blind | Med×High | Audit **fails closed** on a configured-but-unreadable token (mirrors migration-drift.yml); a *missing* token in CI runs local-file integrity + emits an explicit "ledger pass skipped — no token" notice, never a silent green for the ledger pass. |
| P2 | Audit too strict → blocks every PR on **pre-existing** lettered-suffix / baseline files (`0055b`, `00000000000000_baseline…`) | Med×High | Validator whitelists the baseline + lettered-suffix grammar and reuses `migration-prefix-baseline.json` for grandfathered prefixes. Tested against the *real* current ledger shape. |
| P3 | Someone runs `provision-isolated-rig.sh` and it **creates a paid project** by accident | Low×High | `--dry-run` is the **default**; a real run requires explicit `--apply` **and** `CONFIRM_PROVISION=<project-name>`; the script refuses to touch prod refs (`vzwyaatejekddvltxyye` hard-denied). |
| P4 | `compute-merge-authority.ts` **fails open** (treats unknown surface as council-mergeable) | Low×Severe | Defaults to `needs-carson` on any error/unknown; only emits `council` when `requiredTierFor` returns T0/T1 with zero error. Unit-tested with a chain/migration path → `needs-carson`. |
| P5 | The audit **duplicates** `check-migration-prefix-uniqueness.ts` and they disagree | Med×Med | Audit consumes the same `migration-prefix-baseline.json`; scope is documented as complementary (local-file *grammar* + *prod-ledger* integrity, not just local collisions). |
| P6 | Removing the migration-drift `exempt_regex` entries (4.2d) blocks all PRs because prod isn't actually reconciled | Med×High | 4.2d is **not done here** — Carson-gated, gated on 4.2c running green against prod first. |
| P7 | Editing `.mergify.yml` / branch protection from the train silently changes who can merge | Low×Severe | Train ships a **drafted** diff only; the apply is Carson's. `.mergify.yml` is left untouched in this branch. |
| P8 | The agents.md collision lint flags legitimate non-migration `agents.md` edits | Med×Med | Lint scopes strictly to `supabase/migrations/agents.md` and only to duplicated `## Recent migrations` headers lacking the `(PR #NNNN)` discriminator (CLAUDE.md §6 rule). |

**Pre-mortem verdict:** proceed. Every irreversible/outward action is gated to Carson; every train artifact is reversible CI/docs/tooling that fails closed.

---

## 4. EXECUTION LOG (2026-06-17)

Built on branch `claude/s0-e4-refinement-planning-myy61i`. **Nothing merged; no PR opened; no infra provisioned; no prod/staging/ledger mutation.** Two streams ran as parallel personas (Release Manager → S0-4.1; RTE → S0-4.3 playbook) while the main session built S0-4.2 + the CI wiring.

| Deliverable | File(s) | Status |
|---|---|---|
| 4.2a/b validators + tests | `scripts/ci/check-ledger-numeric-integrity.ts` (+ `.test.ts`, 12 tests) | ✅ TDD red→green; 0 false-positives on the real 48-file set; injected-timestamp row fails (CLI-proven) |
| 4.2c CI wiring | `ci.yml` (local pass) + `migration-drift.yml` (prod-ledger pass over the already-fetched payload) | ✅ YAML validated; fail-closed; Dependabot-skip respected |
| 4.2d remove stale exemptions | — | ⏸ **Carson-gated** (after 4.2c green vs prod; fail-closed) |
| 4.3a agents.md collision lint | `scripts/ci/check-agents-md-migration-collision.ts` (+ `.test.ts`, 4 tests) | ✅ relaxed after P8 fired in test — accepts `(SCRUM-…)`/`(PR #…)` discriminators, flags bare/duplicate headers; passes the real file |
| 4.3b merge-authority | `scripts/ci/compute-merge-authority.ts` (+ `.test.ts`, 7 tests) | ✅ reuses `requiredTierFor`; fails closed to needs-carson; wired into `ci.yml` (advisory) |
| 4.3c playbook | `docs/runbooks/mergify-stacked-pr-playbook.md` | ✅ (RTE persona) |
| 4.3d branch-protection/Mergify apply | drafted in the playbook | ⏸ **Carson-gated** (drafted, not applied; `.mergify.yml` untouched) |
| 4.1a provision/teardown | `scripts/staging/{provision,teardown}-isolated-rig.sh` | ✅ (RelMgr persona) dry-run default; prod + shared-staging + shared Cloud Run hard-denied (exit 1, verified) |
| 4.1b runbook | `docs/runbooks/isolated-soak-rig-automation.md` | ✅ |
| 4.1c live 2-rig rehearsal | runbook checklist | ⏸ **Carson-gated** (T3 live infra) |
| tier registration | `STAGING_TOOLING_ALLOW` in `check-staging-evidence.ts` (+ test) | ✅ the 3 new checks classify T0 |

**Verification:** `npx vitest run scripts/` → **530/530 green** (31 files; +23 new); `npx tsc --noEmit` → **0 errors**; eslint on new files → 0 errors (scripts/ are outside `eslint src/`); both staging scripts `bash -n` clean + dry-run/deny paths exercised.

**Outstanding (Carson / Planning, not the train's to do):** 4.2d, 4.3d, 4.1c (above); Jira transitions + Confluence per-story pages for S0-E4 (the train leaves an honest comment, does not transition); the live rig rehearsal is the only thing that fully closes S0-4.1's AC.

### Post-build: code-review · simplify · debug · pre-mortem · retro

_(appended after the iterate-to-done build, per Carson's 2026-06-17 directive — see §5–§7 below.)_
