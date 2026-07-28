# Legacy Code Soak & Provenance Audit — Plan (all code predating the launch-soak window)

> **Story:** SCRUM-2980 lane, RTE deliverable. Companion to `72h-soak-runbook-2026-08.md` (soak #1) and `PREMORTEM-72h-soak-2026-08.md`. This document is soak #2's own pre-mortemed plan, per `72h-soak-runbook-2026-08.md` §0.5's instruction to draft it "the same way this one was."
> **Directive chain:** Founder (2026-07-28) — soak everything before 2026-05-01 → extended to 2026-06-01 → **corrected same day: "fucking close that 12 day gap then."** Final scope: **zero gap with the launch soak's 45-day window.** This document implements the final, zero-gap instruction. Earlier versions of this scope (May 1, June 1) are superseded and not used anywhere below.
> **Coverage guarantee (the founder-facing claim this document exists to make true, not assume):** every commit in this repository's history is covered by exactly one of the two soaks — the legacy soak (this document) or the launch soak (`72h-soak-runbook-2026-08.md`), with no commit falling in an uncovered seam between them. §1 proves this by count, not by date-label inspection.

---

## 0. Coverage guarantee — verified, not asserted

The launch soak's own scope document (`wave-merge-choreography-2026-08.md` §2) states its window as "everything merged in the last 45 days" and derives it live: `git log --since="45 days ago" --merges --oneline main` = 393 merge commits, spanning **2026-06-13 → 2026-07-28** (computed in that session on 2026-07-28). Re-deriving the same query in this session (also 2026-07-28, later in the day) returns 388 merge commits over the same calendar boundary — the small count delta is normal timing drift within the same day (`--since="45 days ago"` is evaluated at wall-clock invocation time, so two sessions run hours apart roll slightly different numbers of same-day commits into or out of the window), not a boundary disagreement. Both sessions independently land on **2026-06-13** as the window's start date.

**Exact boundary used:** `2026-06-13T00:00:00 UTC`. Legacy soak scope = every commit with author date strictly before this timestamp. Launch soak scope = every commit with author date at or after this timestamp.

**Verified by count, not by inspection of a date label:**

```
$ git rev-list --count HEAD
3810
$ git log --before="2026-06-13T00:00:00" --format='%H' HEAD | wc -l
2521
$ git log --after="2026-06-13T00:00:00" --format='%H' HEAD | wc -l
1289
2521 + 1289 = 3810  ✓ matches total exactly
```

This is a strict binary partition of the full commit history at a single timestamp: every commit is before the cutoff or at/after it, there is no third bucket, and the two counts sum to the total with no double-count and no gap. That arithmetic — not a claim that the two runbooks "line up" — is what makes the coverage guarantee true. Repo head at time of this analysis: `595b1b730011e37801f55ef62357daf0b1d84bbb` (2026-07-28).

**Naming convention note:** this document is filed as `PLAN-legacy-soak-pre-launch-window.md`, not `pre-2026-06.md` — the earlier filename implied a June 1 cutoff that no longer exists. The Drive copy is titled `Arkova — Legacy Code Soak & Provenance Audit Plan (all code predating the launch-soak window)` for the same reason.

---

## 1. Scope — derived, not asserted

### 1.1 Method

`git log --before=2026-06-13T00:00:00` gives commit-level history, but a commit existing in history proves nothing about today's `main` — code from that era may have been fully rewritten since. The number that matters is **surviving lines**: lines on today's `main` whose most recent edit (per `git blame`) traces to a commit dated before the cutoff. `git blame --line-porcelain` was run against every tracked file under the code-bearing directories (`services/`, `src/`, `scripts/`, `supabase/migrations/`, `integrations/`, `packages/`, `e2e/`, `tests/`, `machines/`, `eslint-rules/`, `infra/`, plus root config files), excluding binary formats blame cannot process (images, fonts, lockfile binaries — 10 OCR/spreadsheet test fixtures errored on UTF-8 decode and were skipped, all non-code binary fixtures). 3,035 files were scanned.

### 1.2 Headline number

**587,071 of 799,664 surviving lines (73.4%) trace to a commit before 2026-06-13.**

A meaningful fraction of both totals is generated/vendor content that inflates line counts without representing hand-maintained risk surface: `package-lock.json` files, `services/worker/docs/eval/*.json` (AI eval run snapshots), and `services/worker/src/ai/eval/golden-dataset*.ts` (generated golden-dataset fixtures). Stripping those (185,226 lines total, 140,590 pre-cutoff) gives a logic-only figure: **446,481 of 614,438 (72.7%)** — nearly identical to the headline percentage, which means the 73% figure is robust to this adjustment rather than being an artifact of vendor noise. Both numbers are reported; the subsystem table below uses the unadjusted (full-corpus) counts since the noisy files are heavily concentrated in only a few subsystems (worker, packages) and the per-subsystem percentages already reflect that.

### 1.3 Subsystem breakdown (surviving lines, full corpus)

| Subsystem | Total surviving lines | Pre-2026-06-13 lines | % legacy |
|---|---|---|---|
| **worker** (`services/worker/`) | 472,284 | 364,978 | **77.3%** |
| **frontend** (`src/`) | 141,042 | 117,617 | **83.4%** |
| **edge** (`services/edge/`) | 11,707 | 10,779 | **92.1%** |
| **api-gateway** (`services/api-gateway/`) | 3,163 | 0 | 0.0% (post-cutoff addition, PR #1505) |
| **migrations** (`supabase/migrations/`) | 25,232 | 19,534 | **77.4%** |
| **integrations** (`integrations/bullhorn,clio,zapier,shared`) | 19,928 | 19,654 | **98.6%** |
| **tests** (`e2e/`, `tests/`) | 18,278 | 14,930 | **81.7%** |
| **packages** (`arkova-py`, `embed`, `sdk`, `verifier`, `verifier-cli`) | 27,338 | 10,313 | 37.7% |
| **scripts** (`scripts/`) | 75,998 | 26,394 | 34.7% |
| **machines** (`machines/*.machine.ts`) | 2,186 | 962 | 44.0% |
| **eslint-rules** | 1,561 | 995 | 63.7% |
| **infra** | 852 | 820 | 96.2% |

**Highest-risk subsystems by this measure:** **edge** (92.1%) and **integrations** (98.6%) are almost entirely untouched since before June, meaning nearly none of their surface has passed through the post-review-discipline era at all. **worker** (77.3% of 472K lines = 365K legacy lines) is the largest absolute legacy footprint by a wide margin and is also where every named blast-radius category in this directive lives (auth middleware, SECURITY DEFINER RPC callers, credit/billing logic, chain/treasury client code). **frontend** (83.4% of 141K = 117.6K legacy lines) is second-largest and carries the client-side §1.6 privacy boundary (fingerprinting, OCR, PII stripping) — code whose correctness is a stated foundational guarantee, not just a feature. **migrations** at 77.4% means most of the live schema, including RLS policies and SECURITY DEFINER function bodies, predates the cutoff (see §1.4 — the true picture is more concentrated than this percentage alone shows, because of the baseline squash).

**Lowest-risk by this measure:** **scripts** (34.7%) and **packages** (37.7%) have been most heavily rewritten since June — consistent with this sprint's own visible work (CI/staging tooling, SDK publish prep) concentrating in exactly those directories. **api-gateway** is 100% post-cutoff (the Cloudflare gateway shipped in PR #1505, per `memory/project_partner_docs_drive.md`) and needs no legacy-soak coverage at all.

### 1.4 A structural caveat that changes how "legacy" should be read for migrations

`supabase/migrations/00000000000000_baseline_at_main_HEAD.sql` (15,114 lines, the single largest surviving file in the entire scan) is a `pg_dump` snapshot committed 2026-05-08 (PR #700, "Path C: pg_dump baseline retires 0000..0289 fresh-DB replay"). It consolidated migrations 0000–0289 into one file. This means `git blame` on the current schema cannot recover true original authorship or true original date for anything defined before migration 0290 — every one of those objects blames to the single 2026-05-08 squash commit. Practically: **the baseline is unambiguously legacy (2026-05-08 predates 2026-06-13 by five weeks), so nothing about this caveat moves any object out of legacy scope** — it only means the audit cannot distinguish "written in January" from "written in April" for pre-0290 objects; it can only confirm "written before 2026-05-08, i.e., before the cutoff either way." This is stated explicitly rather than left as a silent blind spot: the provenance audit in §3 below works around it by tracing function names forward through git log on the migrations directory instead of relying on blame alone for these objects.

---

## 2. Why this code is the riskiest — evidence, not assertion

**(a) It predates the review discipline built since.** Worktree isolation for parallel agents, the `agents.md` append-only guard, orphaned-export lint, and tier-based soak gating are all artifacts of this sprint and the weeks immediately before it (`POSTMORTEM-sprint-2026-07-28.md` §2.3, `sprint-2026-07-28-findings.md` #2/#6/#13). Code merged before 2026-06-13 was never subject to any of these controls, because none of them existed yet.

**(b) CI's silent job-tail skip means "green" never meant full coverage for this era.** `POSTMORTEM-sprint-2026-07-28.md` finding #2: `.github/workflows/ci.yml`'s `test` job could fail early on a flaky step and silently skip the worker test suite plus ~20 security scans, because later steps lacked `if: always()`. Verified in this session: the fix landed today, commit `be2e69f6755d42fc47f956fb81ac46e9aeb03a34` ("ci: worker test suite no longer silently skipped when root suite fails", PR #1748, 2026-07-28) — every step from the `supabase-keys`/`db-reset` outcome check onward in `ci.yml`'s `test` job now carries `if: always()` (verified by `grep -n "if: always()" .github/workflows/ci.yml`, 8 occurrences in that job as of this session). **The fix is real and on `main` as of today, but it fixes the gate going forward — it does not retroactively re-validate any historical "green" claim for a PR merged before today.** Every legacy-era PR's CI-green status is therefore an open question, not a known-good baseline, which is exactly why this soak cannot lean on "it was tested when it merged" as a reason to skip re-testing it now.

**(c) Corroborating evidence from this sprint — three claims, each independently verified against `git log`/`git blame` rather than repeated on trust:**

1. **`x-org-id` cross-tenant bypass (`services/worker/src/middleware/requireOrgId.ts`).** `git log --follow` on this file shows exactly two commits: the vulnerable code was introduced `2026-04-12` (commit `f4502b968a2b8eb9c983cd35c90b83a20b8267f2`, PR #370, "International Compliance REG-02/05/06/07/08/09/10/12/13/14/17/18") and the fix landed `2026-07-28` (commit `f1fb0d6681f3a65f7411dd585971fb6db7c8ae86`, PR #1749). **Confirmed: the bug's origin (2026-04-12) is legacy scope by more than eight weeks.** The fix itself is in-sprint and will be covered by the launch soak's own regression check (`72h-soak-runbook-2026-08.md` §5 ISOLATION pillar) — the legacy soak's job is not to re-prove this specific fix, but to look for the same class of defect (headers trusted without membership checks) elsewhere in the ~365K legacy worker lines that haven't been read this closely yet.
2. **Unguarded `anon`-grantable SECURITY DEFINER RPCs (migration 0377 revoked 7).** Migration `0377_sec_recon_revoke_unguarded_rpc_family.sql` itself is dated `2026-07-28` (commit `5f9166726d473a03478e4970a4657d90157334d9`, PR #1758) — the fix is in-sprint. But the six functions it revokes EXECUTE from (`submit_batch_anchors`, `batch_insert_anchors`, `allocate_monthly_credits`, `deduct_ai_credits`, `deduct_unified_credits`, `roll_over_monthly_allocation`) all originate in `00000000000000_baseline_at_main_HEAD.sql`, committed `2026-05-08` — **confirmed legacy, five weeks before the cutoff.** The over-broad grant these functions carried was legacy-era; only the fix is new.
3. **`batch_insert_anchors` implicit-cast index defeat (migration 0370).** Same pattern: the fix migration `0370_scrum3031_batch_insert_anchors_fix.sql` is dated `2026-07-28` (commit `595b1b730011e37801f55ef62357daf0b1d84bbb`, PR #1730), but the function it fixes is the same baseline-originated `batch_insert_anchors` from `2026-05-08`. **Confirmed legacy.**

All three claims hold under verification, with the same nuance in each case: **the bug is legacy, the fix is this sprint.** That nuance matters for scoping — it means the legacy soak's job is not to re-test these three specific fixes (the launch soak already covers that, per its own §5 EDGE CASES pillar naming migration 0377's positive-path RPC tests and the SCRUM-3031 regression check explicitly) but to look for the *next* instance of the same defect classes — unguarded header trust, over-broad SECURITY DEFINER grants, implicit-cast index defeats — across the roughly 365K legacy worker lines and 19.5K legacy migration lines these three examples were each a single needle inside.

**(d) A fourth, less publicized example in the same evidence class:** `services/worker/src/api/v1/ai-extract.ts` lines 240-252 contain the fail-open credit-deduction bug named in `72h-soak-runbook-2026-08.md` §0.9 scenario 8 and the RELEASE-PLAN §8 item 13 ("AI credit deduction failed — proceeding with extraction" — a broken RPC call still returns 200 and silently gives away a free extraction). `git blame` on those exact lines attributes them to commit `561ca3b786`, dated **2026-03-23** — solidly legacy, ten weeks before the cutoff, and authored by Carson directly (not an unknown actor). This is included here specifically because it demonstrates the risk class this soak exists to find is not confined to the three headline findings above — it is a pattern present in ordinary, attributable, competently-written legacy code, which is the harder case to catch by code review alone and the reason a soak (real traffic, real failure injection) is the right instrument.

---

## 3. Provenance audit — method and findings

**Framing, stated explicitly per the founder's ask:** this is a trust-boundary exercise about code provenance, not an accusation. Every identity below either did real, attributable, substantive work that shipped, or is a name in `git log` whose current standing needs a factual answer (does this account still have access, is the person still involved) rather than an inference. Nothing below implies wrongdoing by any named individual; it names facts about authorship, access, and blast radius so the next reviewer doesn't have to re-derive them from scratch.

### 3.1 Method

1. Enumerate every distinct `%an <%ae>` pair in `git log --before=2026-06-13 --format='%an <%ae>'`.
2. Reconcile each against known team members from session memory (`memory/project_art_roster.md`: Carson founder + CTO/CPO/Biz delegate roles, all operating as Claude Code sessions under Carson's own git identities) and against the repo's current GitHub collaborator list (`gh api repos/carson-see/ArkovaCarson/collaborators`).
3. For any identity that is not a recognizable Carson alias and not a bot (`dependabot[bot]`, `mergify[bot]`), `git blame` the files that identity touched to find which lines still survive on `main` today.
4. Weight surviving lines by blast radius: anything touching auth, RLS, SECURITY DEFINER functions, credits/billing, chain/treasury, or key custody is **REPLACE-not-review**; everything else is **review-and-risk-rate**.

### 3.2 Author inventory (pre-2026-06-13, by commit count)

| Identity | Commits | Resolution |
|---|---|---|
| `carson-see <carson@arkova.io>` | 858 | Carson (primary GitHub identity, admin) |
| `carson <carson@arkova.ai>` | 591 | Carson (alternate local git config) |
| `Carson <carson@Arkovas-Mac-mini.local>` | 583 | Carson (local machine identity, no email domain) |
| `dependabot[bot]` | 92 | Automated, not a code-authorship risk in this sense |
| `carson-see <257869717+carson-see@users.noreply.github.com>` | 72 | Carson (GitHub noreply alias) |
| `mergify[bot]` | 51 | Automated merge bot |
| `carson-see <carson-see@users.noreply.github.com>` | 17 | Carson (another noreply variant) |
| `Claude <noreply@anthropic.com>` | 13 | Claude Code session commits, self-labeled |
| **`prajalsharma <prajalsharma1120@gmail.com>`** | **7** | **Flagged — see §3.3** |
| **`BestNessie <129661809+BestNessie@users.noreply.github.com>`** | **6** (direct-author commits; more when counted by PR authorship, see §3.4) | **Flagged — see §3.4** |
| `carson <carson@arkova.io>` | 5 | Carson (email/name mismatch variant) |
| `carson <257869717+carson-see@users.noreply.github.com>` | 4 | Carson |
| `carson-see <carson@arkova.ai>` | 3 | Carson |
| `Arkova SCRUM-894 <noreply@arkova.ai>` | 1 (as sole listed identity — actually a shared local commit-author string; see §3.5) | Resolved — see §3.5, not a person |

Nine of the fourteen distinct identity strings above are Carson under different local git configurations or GitHub noreply aliases (2,116 commits combined) — an identity-hygiene footnote worth a one-line fix (a single canonical `user.email` per machine) but not a provenance risk. `dependabot[bot]` and `mergify[bot]` are automated and out of scope for a human-provenance audit. That leaves **two genuinely unattributed or externally-sourced identities** and one resolved false positive.

### 3.3 `prajalsharma <prajalsharma1120@gmail.com>` — named in the founder directive

Seven commits, all dated **2026-01-29 to 2026-02-19** — the very first commits in the repository's history (`first commit`, `Initial Arkova MVP setup`, `Initial Arkova MVP codebase`, plus the rename to "Arkova" and a UI redesign pass). This is the original project scaffold.

**Current GitHub standing:** the login implied by the commit email (`prajalsharma1120`) does not resolve via `gh api users/prajalsharma1120` (404 — account not found or renamed) as of 2026-07-28. **The identity is not a current repository collaborator** (absent from `gh api repos/carson-see/ArkovaCarson/collaborators`).

**Surviving footprint, measured directly (not estimated):** of the 195 files touched across those 7 commits, 157 still exist on `main` today (38 were deleted or renamed away entirely — most of the original prototype). Those 157 files contain 82,595 lines today, of which **20,192 lines (24.5%)** still blame directly to prajalsharma's original commits — meaning roughly a quarter of the content in those files is untouched since February.

**Blast-radius classification of the highest-surviving-line files** (full list of top 40 files by surviving prajal-attributed lines is in the scratch analysis this document is built from; the material ones):
- `tests/rls/p7.test.ts` (537 surviving lines) and `tests/rls/rls.test.ts` (457 lines) — **RLS test scaffolding.** Confirmed still exercised: `tests/rls/**` is excluded from the default `vitest run` glob (`vitest.config.ts:18`) but is run via a dedicated `npm run test:rls` script (`vitest.config.rls.ts`), which is invoked in `.github/workflows/ci.yml:707` — this is a legitimate split (fast unit tests vs. DB-backed RLS tests needing a live Supabase instance), not dead code. **REPLACE-not-review category** (RLS).
- `src/lib/validators.ts` (260 surviving lines) — the Zod validator module CLAUDE.md §1.2 requires on every write path. **REPLACE-not-review category** (write-path validation is the primary defense named in the constitution).
- `src/components/auth/SignUpForm.tsx` (174 lines), `src/components/auth/LoginForm.tsx` (141 lines) — auth-adjacent UI, not auth logic itself (Supabase Auth handles the actual authentication). **Review-and-risk-rate.**
- `src/components/billing/BillingOverview.tsx` (221 lines) — billing-adjacent UI. **Review-and-risk-rate** (not itself a money-moving code path; it's a display component).
- `src/lib/proofPackage.ts` (156 lines) — chain/proof-adjacent (constructs the evidence package a verifier reads). **Review-and-risk-rate**, trending toward REPLACE given it's on the proof-integrity path §1.5 governs.
- `src/components/upload/CSVUploadWizard.tsx` (448 lines) — **this file is dead code**, per `sprint-2026-07-28-findings.md` #25: "`CSVUploadWizard.tsx` is unreachable dead code — only `BulkUploadWizard.tsx` is actually rendered." No soak coverage needed; delete-or-wire is already an open backlog item, unrelated to this audit beyond noting it so nobody spends soak budget exercising a component nothing renders.
- The largest single surviving block, `package-lock.json` (4,511 lines), is a generated lockfile and carries no independent authorship risk.

**Assessment:** the original scaffolding survives mostly in test infrastructure and validator/auth-adjacent UI, not in the transaction-critical worker paths (credits, chain broadcast, SECURITY DEFINER RPCs) — those were all rebuilt well after February per the baseline squash (§1.4) and the subsequent worker build-out. The two RLS test files and the shared validator module are the genuine higher-stakes surviving artifacts and should be explicitly re-reviewed (not merely re-run) as part of this soak's provenance closure, since RLS-test-writer intent (what edge cases did the author think to cover) is exactly the kind of thing a passing test cannot self-certify.

### 3.4 `BestNessie <129661809+BestNessie@users.noreply.github.com>` — the higher-priority unknown

Six direct-author commits (2026-04-25 to 2026-04-27), but PR authorship (`gh pr view <N> --json author`) shows this identity as the actual GitHub author on six merged PRs in the same window: #568, #570, #571, #572, #573, and #1041 (the last one recovered/re-landed later by Carson, per commit `recover(CSI-04C/04D)`). **This is a current, active GitHub collaborator** — `gh api repos/carson-see/ArkovaCarson/collaborators` shows `BestNessie` with `push: true` access as of 2026-07-28, the same day this audit ran. Account created 2023-04-02, 2 public repos, no bio, no org affiliation visible via the public API. Unlike prajalsharma, this is not a resolvable "was here at the start and left" story — it is an identity with standing write access to the repository today, whose provenance (who this is, whether the access is still intended) has no answer in session memory or `MEMORY.md`'s roster.

**Files touched, all still tracked on `main`:** `.github/workflows/ci.yml`, `services/worker/src/api/v1/{ai-extract,anchor-evidence,anchor-lifecycle,batch,verify,webhooks}.ts` and their test files, `services/worker/src/jobs/batch-anchor.ts`, `services/worker/src/webhooks/{delivery,replay}.ts`, `src/tests/security/{audit-06-payment-ledger-invoker,audit-07-empty-policy-tables,audit-08-search-path-coverage,service-role-audit}.test.ts`, and — the highest-blast-radius items — three migrations: `0273_audit08_function_search_path_public.sql`, `0274_audit06_payment_ledger_security_invoker.sql`, `0275_audit07_empty_policy_tables.sql`.

**Blast-radius classification:** the three migrations are explicitly **REPLACE-not-review, top of the priority list** — they pin `search_path=public` on mutable functions (the exact defense CLAUDE.md §1.4 mandates against search-path hijacking of SECURITY DEFINER functions), flip `payment_ledger` to SECURITY INVOKER, and add deny-all RLS policies to seven tables. These are precisely the categories the founder's directive names as REPLACE-not-review: SECURITY DEFINER hardening and RLS policy work, authored by an identity this audit cannot independently vouch for, currently load-bearing on `main`. `ai-extract.ts` (touched by this identity, though not the specific fail-open lines in §2(d), which are Carson's) and `batch-anchor.ts` (the cron caller of `submit_batch_anchors`, one of the six RPCs 0377 just re-guarded) are adjacent enough to the same risk surface to warrant the same treatment.

**What this is not:** there is no evidence of malicious intent, and the commit messages, PR structure, and code style (session-pattern `docs(handoff)` / `chore(simplify)` commits interleaved with `feat`/`fix` commits, matching the operating pattern this repo otherwise uses for Claude Code sessions) are consistent with a legitimate contributor or a legitimately-run session under a personal GitHub handle rather than a compromised account. The finding is narrower and more useful than an accusation: **this identity's still-live push access and its authorship of exactly the highest-blast-radius category named in the founder's directive is a fact worth Carson's direct attention** — confirm who this is, confirm the access is still wanted, and treat the three migrations and adjacent worker files as REPLACE-not-review regardless of the answer, since the review standard for SECURITY DEFINER/RLS code should not depend on how comfortable anyone is with the author's identity.

### 3.5 `Arkova SCRUM-894 <noreply@arkova.ai>` — false positive, resolved

Traced via `gh api search/issues` against each commit SHA and `gh pr view` on the resulting PR numbers: commits under this local identity correspond to real PRs authored by both `carson-see` (e.g. #1242) and `BestNessie` (e.g. #1041), meaning **this is a shared local `git config user.name` string used across sessions/machines, not a distinct person.** No separate provenance action needed beyond the general identity-hygiene note in §3.2 — folded in here rather than treated as a third unknown actor, since treating it as one would double-count BestNessie's already-flagged work under a different label.

### 3.6 Standing precedent this audit exists to avoid repeating

The fired team's hollow 48h B1 soak (`PREMORTEM-72h-soak-2026-08.md` §1) is the concrete precedent for what happens when unknown-provenance work and unverified process both go unexamined at once — a soak ran, reported green, and validated nothing, because nobody had independently confirmed the work underneath it was sound. This provenance audit is the code-provenance half of not repeating that; the soak design in §4 below is the runtime half.

### 3.7 What "REPLACE" concretely means here

For the items flagged REPLACE-not-review in §3.3 and §3.4 (RLS test files, `validators.ts`, the three search-path/RLS migrations, and their adjacent worker call sites): the recommended action is not a deletion-and-rewrite-from-scratch project before the soak can start (that would itself be new, unsoaked code introduced under time pressure — see pre-mortem item #6 below). It is: (1) a from-scratch adversarial re-review by someone who did not author the original code, treating it exactly as if it arrived today via an untrusted PR; (2) any defect found gets fixed as its own tracked change, soaked and reviewed like any other fix; (3) only if a re-review finds the code fundamentally unsound (not just improvable) does a full replacement get scheduled, and that replacement is itself new code requiring its own soak, not a shortcut around this soak. This keeps the REPLACE label meaningful (an escalation path exists) without turning "the author is unverified" into an automatic rewrite mandate that would itself introduce risk.

---

## 4. Soak design

### 4.1 What's structurally different from the launch soak

The launch soak (`72h-soak-runbook-2026-08.md`) has a built-in correlation signal: for every PR in its scope, there is a specific changed surface and a specific expectation ("this endpoint should now do X because PR #NNNN changed it"). A failure during that soak can be pointed at a diff. The legacy soak has no such anchor — there is no recent change to blame a failure on, and a legacy code path that behaves identically to how it behaved yesterday could be silently wrong in a way nobody has looked for, because nobody has looked at all. This means the legacy soak's load/journey design has to **deliberately manufacture exercise of old paths** rather than passively watching whatever traffic shows up, which is the opposite failure mode from a generic load test: a generic load test proves the worker doesn't crash; this soak needs to prove specific legacy code paths, chosen because of their blast radius, actually behave correctly under real conditions.

### 4.2 Gate structure (reused from the launch soak, per instruction)

Same staged structure as `72h-soak-runbook-2026-08.md` §0.7: T+0–2h smoke gate, then T+6h, T+24h, T+48h, T+72h (or whatever the final duration lands on — see §6 for why this is not yet fixed). Same 4-pillar evidence standard (VOLUME + CONCURRENCY + EDGE CASES + ISOLATION, per `memory/feedback_soak_evidence_standard.md`) and the same continuous-monitor philosophy: page on breach, don't wait for the next daily check. The launch soak's abort-criteria table (§8 of that runbook) applies unchanged: dirty preflight, contamination, worker restart resets the clock, rig hollow = no-op.

### 4.3 Subsystem-to-journey mapping — which legacy surfaces get which exercises

| Subsystem | Legacy % | Journeys this soak must run |
|---|---|---|
| **worker — auth/tenant boundary** | 77.3% overall, but this specific class is the direct successor to the `x-org-id` finding | Sweep every worker route that reads an org/tenant-scoping header or param (not just the one already fixed) for the same defect class: header trusted without an independent membership check against the authenticated session. This is a targeted code-pattern grep (`grep -rn "req.headers\['x-org-id'\]\|req.params.orgId"` across `services/worker/src/` cross-referenced against which handlers call a membership-verifying helper) **feeding into** a live exercise: authenticated org-A session attempting cross-org reads/writes against every FERPA/HIPAA/audit-proof/org-KYB-adjacent route found, under concurrent load, matching the launch soak's ISOLATION pillar pattern but applied repo-wide instead of to the one already-fixed route. |
| **worker — SECURITY DEFINER RPC family** | Baseline-era (2026-05-08), confirmed legacy | Enumerate every SECURITY DEFINER function in the live schema (`select proname from pg_proc where prosecdef and pronamespace='public'::regnamespace`) and cross-reference against which ones grant EXECUTE to `anon`/`authenticated` beyond the six 0377 already revoked. For any newly-found over-broad grant: same positive-path-plus-negative-path pattern the launch soak's §5 EDGE CASES section already specifies for the six known ones — confirm the legitimate caller still works AND anon is denied, not anon-denied alone. |
| **worker — credit/billing fail-open paths** | 2026-03-23 origin for the one already found, legacy-era code style throughout `services/worker/src/utils/creditLedger*` and `paymentTierRouter.ts` | Grep for the log-then-proceed pattern (`logger.error` immediately followed by continuing execution rather than returning an error) across every credit-mutating and Stripe-adjacent file, not just `ai-extract.ts`. For each hit found: a targeted RPC-failure injection (temporarily break the specific RPC call, e.g. via a bad connection string scoped to that call path in a test harness) to observe whether the caller fails open or closed, exactly as `72h-soak-runbook-2026-08.md` §0.9 scenario 8 already does for the known one. |
| **worker — chain/broadcast/treasury** | Legacy-era signer code (`client.ts:279` WIF-precedence path, per `memory/project_bitcoin_signing_paths.md`) | Reuse the launch soak's failure-injection scenarios #1 (GetBlock RPC outage) and #2 (mempool.space outage) against legacy broadcast/confirmation code specifically, plus a targeted review of the WIF-vs-KMS precedence logic for any code path that could silently select the wrong signer — this is key-custody-adjacent and therefore REPLACE-not-review priority regardless of what the review finds. |
| **frontend — client-side privacy boundary (§1.6)** | 83.4% legacy | `generateFingerprint`, the OCR pipeline (PDF.js/Tesseract), and PII-stripping logic are all foundational and mostly pre-cutoff. Exercise via the existing OCR fixture corpus (`src/lib/__fixtures__/ocr/*`, already used by the launch soak's negative-testing scenario 6) plus a targeted audit confirming no code path introduced since accidentally sends raw bytes or unstripped PII off-device — this is a static/code-review exercise more than a load exercise, since the guarantee is architectural (nothing to load-test if the boundary is sound). |
| **migrations — RLS + SECURITY DEFINER surface (§1.4, §3.3, §3.4)** | Baseline-concentrated, 2026-05-08 or earlier | The three BestNessie-authored search-path/RLS migrations (§3.4) plus every other RLS policy defined in the baseline get a from-scratch adversarial pass: for each table, attempt cross-org and cross-role access it should deny, not just confirm the policy exists. This is the direct successor exercise to the launch soak's per-org isolation check, applied to the full policy set instead of the one credit-enforcement path. |
| **edge** (`services/edge/`) | 92.1% legacy, almost entirely unexercised by any recent soak | The Cloudflare Worker MCP surface (`memory/project_mcp_edge_server.md`) has had essentially no review pressure applied since before June. Needs its own pass: enumerate its exposed tools/endpoints, confirm auth/rate-limiting is actually enforced (not just present in code), and run a basic volume/concurrency pass since it has never been load-tested as part of any prior soak in this repo's history. |
| **integrations** (`bullhorn`, `clio`, `zapier`) | 98.6% legacy | Lowest-traffic, highest-legacy-ratio subsystem. Given limited soak time, scope to a code-review pass (credential handling, no server-side document byte persistence per §1.6A's connector carve-out conditions) rather than a full load exercise, unless usage data shows real production traffic through these paths that would justify more. |

### 4.4 Load model

Unlike the launch soak's derived 10k-DAU model (`72h-soak-runbook-2026-08.md` §0.6), this soak is not validating a capacity target — it is validating correctness of paths that may see low real traffic today but carry outsized blast radius if wrong (a cross-tenant leak or a fail-open credit deduction is damaging at any traffic level, not just at 10k DAU). Load here should be **sufficient to make the CONCURRENCY pillar meaningful** (the launch soak's own ≥15-parallel-request pattern is a reasonable floor to reuse) rather than scaled to a DAU projection — manufacturing volume on paths that are otherwise rarely hit matters more than raw throughput for this soak specifically.

---

## 5. Pre-mortem — assume this soak failed or proved nothing

Framed identically to `PREMORTEM-72h-soak-2026-08.md`: it is after this soak's window closed, and the result is worthless or the soak never meaningfully happened. Ten mechanisms, worked backwards.

### 1. Hollow soak (direct precedent: the fired-team B1 soak, and the founder's explicit framing for this exercise)

**Mechanism:** exactly the launch soak's own #1 risk, but with a legacy-specific twist — because there is no changed-surface anchor (§4.1), it is *easier* for this soak to look busy (uptime, request counts, a green dashboard) while never actually exercising the specific legacy paths named in §4.3. A generic anchor-creation loop running for a week produces the same shape of "evidence" whether or not anyone ever drove a request through the `x-org-id`-adjacent routes that weren't already fixed.
**Earliest signal:** at the T+0–2h gate, if the smoke check is "worker is up, one anchor secured" rather than "the specific §4.3 journey list has at least one real exercise queued and running," this soak is on track to be hollow.
**Mitigation:** the T+0–2h gate for this soak must include, as a hard-stop item, confirmation that each row of §4.3's journey table has an assigned, scheduled exercise — not just that the rig is healthy. **Owner:** RTE.

### 2. No baseline to compare against — "it behaved the same" gets mistaken for "it is correct"

**Mechanism:** the launch soak can say "this endpoint now returns X, matching the PR's intent." This soak can only say "this endpoint returned X, and nothing crashed" — which is a much weaker claim, because a legacy bug that has always silently misbehaved will keep silently misbehaving in exactly the same way under this soak's load, and a soak that only watches for *changes* in behavior will treat that consistency as clean.
**Earliest signal:** a §4.3 exercise "passes" with no assertion beyond "no 5xx, no crash" — for example, the SECURITY DEFINER grant sweep finding zero new over-broad grants would look identical whether the sweep query itself is broken versus whether the finding is genuinely clean.
**Mitigation:** every §4.3 exercise needs a **positive assertion of correct behavior**, not just an absence-of-error check — the same discipline the launch soak's §5 EDGE CASES section already applies to the six known RPCs (assert the balance delta, assert the resolved tier, not just HTTP 200). Write the expected-correct-value down before running the exercise, the same way a test asserts an expected value rather than merely "did not throw." **Owner:** RTE, reviewed by CTO-delegate before the exercise runs, not after.

### 3. Legacy paths that are dead in practice never get exercised, giving false all-clear

**Mechanism:** §3.3 already surfaced one live example — `CSVUploadWizard.tsx` is unreachable dead code (finding #25). A legacy soak that runs traffic through the app's normal UI/API surface will never touch code that nothing routes to, and a clean 72-hour (or however long) run says nothing about paths that were simply never reached, which can be mistaken for "reached and found sound."
**Earliest signal:** an exercise plan item with no corresponding request/response artifact by the first gate — the launch soak's own §0.8 continuity-control discipline ("every artifact above must be timestamped... not an agent's prose summary") applies here with extra force, since for legacy code the temptation to write "reviewed, looks fine" instead of "exercised, observed X" is higher precisely because there's no diff to point at.
**Mitigation:** before the soak starts, run a reachability check (route/component usage grep, same method that found `CSVUploadWizard.tsx`) across the §4.3 subsystem list and explicitly mark anything found unreachable as **excluded with a reason**, not silently skipped. An excluded-with-reason list is honest; a silent gap is not. **Owner:** RTE, at plan-freeze time (this is cheap, no-rig-needed work — see §6).

### 4. Provenance audit produces a list nobody acts on

**Mechanism:** §3's findings (BestNessie's live push access authoring RLS/search-path migrations, prajalsharma's surviving RLS test scaffolding) are exactly the kind of finding that's easy to file and then never revisit, especially once the soak itself starts consuming all the attention. `POSTMORTEM-sprint-2026-07-28.md` §5 already names "findings-per-hour" and "time-to-detect" as metrics this org doesn't currently track — the same gap applies to "findings acted on vs. filed."
**Earliest signal:** the T+72h (or final) gate closes with §3's REPLACE-not-review items still unreviewed and no explicit decision recorded (reviewed-and-cleared, reviewed-and-fixed, or escalated).
**Mitigation:** §3.4's BestNessie finding specifically needs a **named, dated decision from Carson** (confirm identity, confirm access intent) — not folded into the soak's general findings list where it can get lost among lower-stakes items. Track it as its own line item with an owner and a deadline independent of the soak's own clock. **Owner:** Carson (identity/access decision — this is the one item in this document that is inherently founder-reserved, per `memory/feedback_remind_founder_reserved_items.md`), RTE (the code-level REPLACE items in §3.7).

### 5. Replacement work introduces new bugs in code that was at least stable

**Mechanism:** §3.7 already names this risk directly — a rewrite mandate driven by "the author is unverified" rather than by an actual defect found on re-review would introduce new, unsoaked code under the same time pressure this whole two-soak structure exists to relieve. New code is definitionally not covered by either soak's frozen-head model until it goes through the launch soak's own process.
**Earliest signal:** a REPLACE-not-review item escalates straight to "rewrite this" without a documented adversarial re-review finding a concrete defect first.
**Mitigation:** §3.7's three-step discipline (re-review as if untrusted → fix what's found, soaked like any other change → full replacement only if re-review finds it fundamentally unsound) is the standing mitigation; the risk here is skipping step 1 under pressure. **Owner:** RTE enforces the sequence; CTO-delegate signs off before any replacement (not just a fix) is scheduled.

### 6. Scope explosion swallowing the launch

**Mechanism:** "the entire application" (§0.5 of the launch runbook's own framing for soak #2) is a much larger scope than a 40-PR wave, and §4.3's subsystem table above is itself already a lot of ground — the temptation to keep finding more legacy risk to chase (which this document's own §2 and §3 findings make easy to do) could extend this soak's actual working set past whatever duration gets set in §6, absorbing RTE/CTO-delegate attention that the 2026-08-10 launch needs.
**Earliest signal:** the §4.3 journey list growing after the plan is frozen, or the soak's start date sliding because "just one more subsystem" keeps getting added.
**Mitigation:** §4.3's table is the frozen scope for this soak's first run — anything found during the audit that doesn't fit is logged as a follow-up item (same treatment as any other backlog finding), not folded into this soak's live scope. §6 makes the sequencing constraint explicit and non-negotiable. **Owner:** RTE holds the scope line; Carson is the only one who can expand it.

### 7. Contention with the launch soak for rigs or attention

**Mechanism:** `72h-soak-runbook-2026-08.md` §0.5 already states this rule directly: soak #2 gets "a separate, new isolated rig — do not reuse or extend soak #1's rig." The risk is not the rule being wrong, it's the rule being violated under pressure (one operator, two soaks, easiest path is to reuse infrastructure) or the same RTE/CTO-delegate attention being split across both soaks' gate checkpoints at the same time, degrading both.
**Earliest signal:** any `gcloud`/Supabase command touching the launch soak's rig (`launch-72h-2026-08`) issued in service of this soak's provisioning or exercises.
**Mitigation:** §6 below states plainly that rig provisioning for this soak does not start until the launch soak matures or is far enough along that a second rig doesn't compete for the same operator-hours at the same gate checkpoints. Naming a separate rig identifier now (`legacy-soak-<start-date>`, chosen at actual provisioning time, not pre-committed here since the exact date is sequencing-dependent per §6) is a cheap guardrail against accidental reuse. **Owner:** RTE.

### 8. The soak reports success on the wrong metric

**Mechanism:** because this soak's subject is broader and less feature-shaped than the launch soak's PR-by-PR scope, there's a real risk of the evidence pack defaulting to generic worker-health numbers (uptime, request count, error rate) — exactly the launch soak's own pre-mortem item #5 ("passing for the wrong reason"), but with a higher chance of recurrence here specifically because there's no single PR's changed-surface list to force specificity.
**Earliest signal:** an evidence pack heavy on aggregate numbers and light on named-exercise artifacts (§4.3's table, one artifact per row).
**Mitigation:** reuse the launch soak's own rule verbatim: generic synthetic load is supporting evidence only. Every §4.3 row needs its own artifact tied to its own named exercise before this soak can be cited as legacy-surface evidence. **Owner:** RTE.

### 9. Provenance findings get treated as a verdict on individuals rather than a fact-finding exercise

**Mechanism:** §3's own framing note exists because this is a real risk — naming "BestNessie authored the RLS-hardening migrations and still has push access" could be read, out of context, as an accusation, which would be both unfair (nothing found here shows misconduct) and would chill the more useful reaction (a factual identity/access confirmation from Carson).
**Earliest signal:** this document, or any summary of it, gets cited without §3's opening framing paragraph, or gets shortened into a headline like "unknown contributor security risk."
**Mitigation:** keep §3's framing attached whenever this document's provenance findings are cited elsewhere (Jira, Confluence, the SOC2 evidence pack). The finding is "confirm and decide," not "something was found wrong." **Owner:** whoever cites this document downstream — stated here so the obligation travels with the content.

### 10. Human/process — this soak also spans days/sessions, same risk as the launch soak's #10, compounded by lower urgency

**Mechanism:** the launch soak has a hard external date (2026-08-10) forcing continuous attention. This soak has no comparably hard external deadline, which means the multi-session continuity risk `PREMORTEM-72h-soak-2026-08.md` §10 already names (context loss across sessions, nobody watching at 3am) is *more* likely here, not less, because there's less pressure keeping anyone checking in.
**Earliest signal:** a gate checkpoint slips by more than a day past its scheduled window with no session having touched the soak's state.
**Mitigation:** treat this soak's own gate checkpoints with the same named-owner-per-checkpoint discipline as the launch soak (`PREMORTEM-72h-soak-2026-08.md`'s own closing checklist item), even without launch-date pressure forcing it — schedule the checkpoints explicitly rather than leaving them to "whoever happens to be online," precisely because the lower-urgency framing makes drift more likely, not less. **Owner:** RTE, with Carson as the periodic sanity check per the launch soak's own pattern.

---

## 6. Sequencing and resourcing

**Non-negotiable constraint, stated by the founder for this exact document:** this soak must not delay the 2026-08-10 launch and must not contend with the launch soak for rigs or attention (pre-mortem items #6, #7).

### 6.1 What can start immediately, at zero rig cost

Everything in §1 (scope derivation) and §3 (provenance audit) is already done in this document — it required no rig, no deploy, no soak clock, only `git log`/`git blame`/`gh api` against the existing repo and GitHub state. The read-only follow-up work that extends it (§4.3's reachability check, the SECURITY DEFINER grant sweep query, the fail-open pattern grep across `creditLedger`/`paymentTierRouter`) is the same class of work — static analysis and live-schema queries, no rig required — and can start now, in parallel with the launch soak, without touching any soak infrastructure.

### 6.2 What must wait

Provisioning the legacy soak's own isolated rig (§4.3's live exercises: the org-A/org-B concurrent isolation sweep, the RPC failure-injection scenarios, the edge-service load pass) waits until the launch soak has matured past its own T+24h gate at minimum — not because of a hard technical dependency, but because both soaks compete for the same scarce resource this repo has repeatedly named as the actual bottleneck in every soak retrospective to date: a human (or Claude session) actually watching gate checkpoints in near-real-time, not rig capacity per se (two isolated rigs can coexist fine; two soaks needing continuous attention from the same one or two people cannot). Once the launch soak reaches a steady state where its own gates are past the highest-attention early window (T+0 through T+24h), a second rig's provisioning and early gates can start without directly competing for the same hours.

### 6.3 Explicit non-goal

This document does not set a soak start date, duration, or rig name — those are sequencing decisions that depend on the launch soak's actual progress, which is not yet known (per `72h-soak-runbook-2026-08.md`'s own state as of this writing: no rig provisioned, no PR set frozen, soak clock not started). Setting a fixed date now would be exactly the kind of unverified forward claim `memory/feedback_never_claim_unstarted_work_as_in_progress.md` warns against. What this document commits to is the **plan, the scope, the provenance findings, and the pre-mortem** — the same three deliverables the launch soak had before its own clock started. The trigger to schedule §6.2's rig work is: launch soak past its T+24h gate, or Carson's explicit go-ahead, whichever comes first.

---

_Written 2026-07-28, RTE/CTO-delegate session (SCRUM-2980 lane), per founder directive (initial: soak everything before 2026-05-01; revised same day to 2026-06-01; revised again same day to zero-gap against the launch soak's exact 45-day window — "fucking close that 12 day gap then"). Every quantitative claim above (surviving-line counts, subsystem percentages, author commit counts, the three verified corroborating-evidence claims, the coverage-guarantee count partition) was derived this session from live `git log`/`git blame`/`gh api` output against commit `595b1b730011e37801f55ef62357daf0b1d84bbb`, not carried forward from a prior session or from the founder's framing without independent verification. No rig has been provisioned for this soak. No soak clock has started. This document is the plan and pre-mortem only, per `72h-soak-runbook-2026-08.md` §0.5's own instruction for how soak #2 should be scoped before it runs._
