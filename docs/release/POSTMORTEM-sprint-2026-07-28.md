# Post-Mortem — Pre-Soak Sprint, 2026-07-28

> **Scope:** the single-day sprint that prepared the ~40-PR wave (SCRUM-2980 lane) feeding into the 72h signet soak. Blameless. This is not a victory lap — five findings below are real process failures and are described as such.
> **Sources:** `docs/release/RELEASE-PLAN-2026-08-FINAL.md`, `docs/release/72h-soak-runbook-2026-08.md`, `docs/release/wave-merge-choreography-2026-08.md`, `docs/staging/sprint-2026-07-28-findings.md`, `docs/staging/sprint-2026-07-28-plan-of-record.md`, `HANDOFF.md` (2026-07-28 entry), `git log origin/main --since="18 hours ago"`.
> **Companion:** `docs/release/PREMORTEM-72h-soak-2026-08.md` — the forward-looking counterpart to this document, written as if the soak has already failed.

---

## 1. What we set out to do vs what happened

**Plan (plan-of-record, ratified by CTO 2026-07-28):** prepare every PR for the launch wave in one day, across three builder lanes (L1/L2/L3) plus RTE and RM, under a strict rule from the founder: nothing merges into a real soak this sprint. The single 72h soak runs afterward, on signet, covering everything merged in the last 45 days. Council of 5 planned the sprint, pre-mortemed it, and recorded 19 CTO rulings before building started.

**What actually happened, verified against `git log origin/main --since="18 hours ago"`:**

- **38 commits landed on `main` in the window**, spanning gate fixes, migrations, feature PRs, and five separate HANDOFF/release-doc commits.
- At least **29 PRs** were prepared per the CTO's own HANDOFF entry; the wave inventory in `wave-merge-choreography-2026-08.md` names 14 open at one snapshot, growing to include Wave S items (#1725–#1763 range) opened live during the session.
- **3 migrations landed this window** with numbers assigned in the RTE table (0367–0378 band reserved; 0370, 0377 confirmed applied/merged this session per commit messages `7a148b511`, `5f9166726`, and others).
- The founder's "nothing soaks now" instruction was **not maintained as originally stated** — mid-sprint the founder and CTO introduced `deferred_consolidated_soak` mode (PR #1756) specifically because the alternative was "Mergify merges nothing above T0 for the whole wave." That is a real scope pivot, not a violation, but it means the sprint's actual shape diverged from its own morning plan by midday.
- **Findings filed:** 26 items in `sprint-2026-07-28-findings.md`, split into new defects (14), verify-and-close (5), deliberately deferred (8), plus a further "later additions" batch (items 15–26) found as the sprint progressed — the finding count grew across the day rather than being fixed at planning time, which is expected for a sprint this size but is worth naming: nobody predicted 26 findings at 9am.

**Bottom line:** the plan was executed largely as scoped, but the sprint discovered materially more mid-flight (security bypasses, broken endpoints, a root-caused merge-driver bug) than the morning's plan accounted for, and the "don't soak" instruction evolved into "soak later, but let CI-gate around it" under real pressure from the Mergify queue mechanics. Neither is a failure by itself. Both are signals that a sprint this size cannot be fully pre-planned, and the process should assume that going in rather than being surprised by it after the fact.

---

## 2. What went right, and why it worked

### 2.1 Adversarial review caught defects CI did not

Three findings this sprint were **found by a human/agent reading code, not by an automated gate**, per the CTO's own HANDOFF framing ("THREE CRITICAL FINDINGS — all found by adversarial review, none by CI"):

1. **Cross-tenant `x-org-id` bypass** (`services/worker/src/middleware/requireOrgId.ts`) — the header is trusted verbatim with no membership check, exposing FERPA disclosure logs, HIPAA audit trails, and org-KYB data across tenant boundaries. No test caught this; a human reading the middleware did.
2. **CI's silent job-tail skip** — `.github/workflows/ci.yml`'s `test` job fails early on a flaky timeout and skips the worker test suite plus ~20 security scans, because the later steps lack `if: always()`. This means "green CI" has been overstating coverage for the entire 45-day window this soak is about to grade, not just this sprint. Found by reading a specific CI run (`gh run view --job 90310187553`), not by the gate itself.
3. **`merge.union.driver=true`** in local `.git/config` — silently discarded incoming content on every local `agents.md` merge for months, misattributed in `CLAUDE.md` §6 to a git/`ort` behavior that isn't what actually happened. Found by tracing a specific missing section back through the actual merge mechanics rather than accepting "the union driver did something weird" as an explanation.

A fourth defect of the same shape — **`/api/v1/anchor/bulk` returning 500 on every real call** because an insert omitted a `NOT NULL` `filename` column — was hidden behind a fully-mocked test suite that stayed green. This is the same root cause as finding #2 in miniature: the automated signal (green tests) did not mean what it appeared to mean.

**Why this worked:** the sprint's operating model explicitly budgeted for a review pass (`/code-review` + `/debug` + `/simplify` per PR, "review battery" in the plan of record) rather than treating CI green as sufficient. That is the actual lesson, not "we got lucky finding these" — the sprint structure made room for someone to read the code with the specific question "what would a hostile actor or a real production call do here" instead of "did the test suite pass."

### 2.2 Verification-before-assertion

Multiple entries in this sprint's record show a claim being made, then re-checked against a live source before being trusted:

- The RPC-revoke migration's rollback block was **read** (not assumed present) and cross-checked against a live `aclexplode(pg_proc.proacl)` query on prod before being declared correct (`RELEASE-PLAN-2026-08-FINAL.md` §8 item 13).
- The dependabot vulnerability count (GitHub's banner claimed "45 vulnerabilities, 1 critical, 27 high") was checked against the actual API and found to be **7 open** alerts, all dev-scope. The banner number would have been wrong to cite in a SOC 2 evidence pack; the finding explicitly says so.
- The migration ledger collision (#1739 vs #1741, both claiming `0375`) was caught by push-order timestamps, not by the lint — the lint only checks `main`, and the finding explicitly states this is a structural gap, not a one-off.
- The RC manifest's PR inventory in `wave-merge-choreography-2026-08.md` is stamped with the exact `gh pr list` command used to derive it and an explicit warning to re-run it before trusting the snapshot, because new PRs were opening during the session.

**Why this worked:** the sprint's written artifacts treat "I read the code" and "I re-queried the live system" as different confidence levels and label which one backs each claim. That labeling is what makes this post-mortem itself possible to write with any confidence — most of what's asserted above traces to a specific command or file read, not to a prior agent's summary.

### 2.3 Worktree isolation and the documented collision map

The Sprint-S collision map in `wave-merge-choreography-2026-08.md` is the sprint's best single artifact: it identifies that `#1735`, `#1736`, `#1740` all edit `src/lib/ocrWorker.ts`'s dispatcher, that `#1736` and `#1738` both rename the same dispatch function in `FileUpload.tsx` with *semantically different* behavior, and it was verified with **real `git merge --no-commit` runs in scratch worktrees**, not a guess from reading two diffs side by side. It names a mandatory land order (`#1735 → #1736 → #1737 → #1738 → #1740`) and a specific owner for the final union rebase.

This worked because parallel builder lanes worked in isolated worktrees rather than a shared checkout, which let the collision be discovered and mapped *before* a real merge attempt, rather than being discovered as a merge conflict or — worse — a silent bad union under load. Compare this to §3.1 below, where the discipline this map represents was not applied to a different collision that materialized the same day.

---

## 3. What went wrong

### 3.1 The merge-order inversion: #1740 before #1743 broke `main`

**What happened, verified via `git log`:** PR #1740 (`feat(extract): TIFF/HEIC decode + scanned-PDF OCR fallback`) merged at `7a148b511`. PR #1743 (`chore(worker): drop orphaned pdfjs-dist + tesseract.js devDependencies`) merged nine minutes later at `5255442c7`. A fix, PR #1762 (`fix(test): assert worker manifest EXCLUDES client-only OCR deps`), landed at `d657cdcde` roughly nine minutes after that.

#1743 removed `pdfjs-dist` and `tesseract.js` from `services/worker/package.json` on the theory that they were orphaned dev dependencies with zero worker-side importers (finding #22 in `sprint-2026-07-28-findings.md`: "Orphaned worker devDependencies... ZERO importers in the worker"). A pre-existing test asserted the worker manifest's dependency shape and broke once those packages were gone, because the assertion predated #1743's cleanup and had never been updated to expect their absence. #1762 fixed the test to assert the correct invariant (client-only OCR deps *excluded* from the worker manifest) rather than the stale one.

**Root cause:** the collision between "a PR that adds OCR-related code" (#1740) and "a PR that removes OCR-related dev dependencies" (#1743) touching the same conceptual surface was knowable hours before either merged — the findings document (finding #22) that motivated #1743 was written the same session, and the ocrWorker.ts collision map in the choreography doc shows the sprint *was* actively tracking cross-PR collisions on this exact file family. But the ordering between #1740 and #1743 specifically was never added to that tracked list, and nobody re-checked "does anything currently landing touch the same test assertions #1743 is about to invalidate" at the moment #1743 was queued. The map existed for one collision class (source-file dispatch logic) and did not extend to a second, less obvious collision class (a devDependency removal invalidating a manifest-shape test written against the old dependency set).

**This is a scope gap in the choreography document, not a one-off mistake.** The Sprint-S collision map in §3.3 above worked because someone asked "what else touches this file" for `ocrWorker.ts` and `FileUpload.tsx` specifically. Nobody asked the equivalent question for `package.json` test assertions.

### 3.2 The cascade: every merge re-conflicted the rest

Once collisions like 3.1 exist in a ~40-PR wave landing inside hours, each merge that lands changes the base every remaining open PR is measured against. The wave choreography doc itself names this pattern explicitly for the `agents.md`-touching migration trio (Wave M): "serial, agents.md-verified after each... this is not a batching convenience — each migration builds on ledger state the prior one leaves," and separately warns "never push to or edit a PR while it's in the Mergify queue... a push resets queue progress and re-runs speculative checks (pure churn)."

The actual cost of this sprint's cascade is not fully quantified in the source documents — there is no single number for "how many rebase rounds did this cost" — and that absence is itself worth naming: **the sprint did not track cascade cost as a metric**, even though it clearly happened (the choreography doc's own "Before G1 / Before G2 / Before G3" pre-checks, and the repeated "re-verify at execution time, not fully enumerated this pass" caveats throughout the RTE migration table, are symptoms of a fast-moving base).

**Would a merge-queue/train have avoided it?** Partially. Mergify's `batch_size: 10` (per the choreography doc §3) already behaves like a train for T0/T1 traffic — it batches speculative checks so PRs succeed or fail together against a consistent base. It does **not** help Wave M's serial T3 migration trio, which is deliberately non-batched (each migration must fully land before the next starts, because each depends on ledger state the prior one leaves) — that portion of the cascade is inherent to the work, not a tooling gap. The gap is narrower than "we need a different merge tool": it's that a same-day, 40-PR wave with cross-cutting file touches (shared `agents.md`, shared `ocrWorker.ts`, shared `package.json` test assertions) needs the choreography document's collision-mapping discipline applied **exhaustively to every shared file**, not just the ones an author happened to notice were contentious. The tooling did what it was built to do; the coverage of what got mapped was incomplete.

### 3.3 Live unpatched-vulnerability detail in a briefly-public HANDOFF.md

The founder flagged this directly during this sprint: HANDOFF.md's 2026-07-28 entry contains a specific, actionable description of the cross-tenant `x-org-id` bypass — the exact file (`requireOrgId.ts`), the exact endpoints affected (FERPA disclosure log, HIPAA audit trails, `org-kyb.ts`, `signatureCompliance.ts`), and the exact exploit mechanism (trust the header, no membership check) — while the fix was still "in flight," not yet merged. The repository was briefly flipped public during this window, which means that detail was, for some period, readable by anyone.

**This is a real process failure, independent of whether anyone actually exploited it.** HANDOFF.md exists to give the next session enough detail to act fast, and the instinct to write the finding down precisely is correct in isolation — the failure is that the document's audience assumption (next Claude session, private repo) silently broke when repo visibility changed, and nothing in the HANDOFF-writing workflow checks repo visibility before naming an unpatched vulnerability's exact mechanism and file paths in the clear. The safer pattern is well-established for security disclosures generally: name that a critical finding exists and is in flight, link to the fix PR, and keep exploit mechanics out of a document whose distribution isn't controlled by the same gate that controls, say, the bug tracker or a private security advisory.

### 3.4 A subagent brief seeded with an interpretation, not an observation

A dispatched subagent was asked to verify the HakiChain KPI-1 anchor count against a brief that framed the task as confirming a shortfall, rather than neutrally asking what the current count is. The subagent's response echoed that framing back, and the echo was then relayed upstream as if it were independent verification of the shortfall, rather than as a response shaped by its own prompt.

This is a specific instance of a general risk that this sprint's own house style otherwise explicitly guards against — `memory/feedback_assert_prod_state_directly.md` ("never infer prod flags/schema/data/rev from code/PR claims; query prod in-session") exists precisely because agent self-report is not verification. The HakiChain case shows the same failure mode one layer up: the *query itself* was not neutral, so even a technically-accurate agent response could not produce a trustworthy answer. `RELEASE-PLAN-2026-08-FINAL.md` §8 item 10 correctly flags that the live HakiChain anchor count still needs re-verification "NOW (not carried forward from a prior session's note)" — which is itself an admission that the number in circulation cannot be trusted as-is.

**The fix is procedural:** briefs for verification subagents should state the question being answered, not the expected answer. "What is the current count of real anchors for the HakiChain org, verified by a live query against prod" is a different brief than "confirm the shortfall," even though both might produce superficially similar-looking responses.

### 3.5 CI over-promised: whole job tails silently skipped

Covered in §2.1 above as a *catch*, but it is also, independently, a *failure* worth restating on its own: this is not a one-time bug, it is a **retroactive integrity problem for every soak and PR evidence claim made during the entire 45-day window** this soak is about to grade. `RELEASE-PLAN-2026-08-FINAL.md` §2.14 states this explicitly: "'green CI' has been over-promising across the ENTIRE 45-day window, not just this wave... call it out explicitly in the SOC 2 evidence pack rather than silently trusting historical green checks." The fix (adding `if: always()`) was "in flight" as of HANDOFF's last entry, unconfirmed merged. Until it lands and a full-suite re-run is done against the frozen head, no claim of "CI was green" for any PR in this window can be taken as full coverage without an asterisk.

---

## 4. Systemic lessons — concrete changes, not platitudes

1. **Extend the collision map's scope, not just its rigor.** The Sprint-S collision map process (real `git merge --no-commit` scratch-worktree runs, named owner, mandatory land order) is good and should stay. It needs to run against **every file two or more same-day PRs touch**, including `package.json`, test manifests, and CI config — not just source dispatch logic that an author happened to flag as contentious. A cheap mechanical pass (`git diff --name-only` across all open PRs' branches, intersected) run once at wave-freeze time would have surfaced the #1740/#1743 test-assertion collision before either merged.

2. **Track cascade cost as a number.** "How many times did a PR get re-based because of a merge landing ahead of it" is measurable (each `Mergify` rebase/requeue event is a webhook/log entry) and currently isn't tracked anywhere in this sprint's artifacts. Without the number, "should we have used a different batching strategy" cannot be answered quantitatively next time either.

3. **Gate HANDOFF.md's live-vulnerability detail on repo visibility, not on writer discretion.** A mechanical check — either a CI lint that flags patterns like exact file/line vulnerability descriptions in HANDOFF commits, or a documented convention (name the finding + fix PR, not the exploit mechanics) — removes the dependency on every session remembering this by itself under time pressure.

4. **Write subagent verification briefs as neutral questions, reviewed for framing before dispatch.** A one-line self-check before dispatching any "verify X" subagent — "does this brief state a question or an expected answer" — would have caught the HakiChain framing. This is cheap enough to make a standing habit rather than a rule that needs tooling.

5. **Land the `if: always()` fix and re-run full CI against the frozen head before the 72h soak's clock starts.** This is already listed as an explicit open blocker in `RELEASE-PLAN-2026-08-FINAL.md` §9 item 6 — restating it here because it is the single highest-leverage fix from this sprint: it retroactively re-validates (or invalidates) every other CI-green claim in the 45-day window.

6. **Give the deploy-gate control (`DEPLOY_WORKER_PAUSED`) a named owner for the un-pause, tracked as a gate, not a reminder.** This is already built into `RELEASE-PLAN-2026-08-FINAL.md` §7 as gate G4 — worth reinforcing here because it is exactly the kind of thing a fast, high-pressure sprint is likely to forget once the immediate goal (get the wave merged) is achieved. See the soak pre-mortem's corresponding failure mode for the forward-looking version of this same risk.

---

## 5. Metrics worth tracking next time

- **PRs opened vs merged vs still-blocked** at sprint close, with blocker reason per PR (this sprint's data exists scattered across `wave-merge-choreography-2026-08.md` and HANDOFF but was never consolidated into one count).
- **Findings-per-hour trendline** across the sprint day — did the 26-finding total cluster early (planning-time review) or late (under-time-pressure discovery)? This sprint's findings document doesn't timestamp individual findings, so the answer isn't currently knowable.
- **Rebase/requeue events per PR** (cascade cost, §4 item 2).
- **Time-to-detect for CI-integrity gaps** (the `if: always()` bug existed for the whole 45-day window; how long between introduction and discovery, and how many PRs' "green" status does that span cover).
- **Ratio of findings caught by adversarial review vs by CI vs by a live-system re-query** — this sprint's record supports a rough count (3 critical findings by review, several by live re-query, ~0 of the critical ones by CI) but was never tallied as a formal ratio. Tracking it would make the case for continued adversarial-review investment concrete rather than anecdotal.

---

_Written 2026-07-28 as the pre-soak-sprint post-mortem, ahead of `PREMORTEM-72h-soak-2026-08.md`. Every specific claim above is cited to a file, commit SHA, or PR number from the sources listed at the top; anywhere a number could not be derived from a source (cascade cost, findings-per-hour) it is named as unknown rather than estimated._
