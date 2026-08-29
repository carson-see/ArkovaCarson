---
name: read-the-emitting-code
description: Before filing a finding about a gate, error or check, read the function that emits the message and the config that feeds it. A mechanism inferred from an error string is a hypothesis, not a finding.
type: feedback
---

An error message tells you a check **fired**. It does not tell you **why**, and it does not tell
you **which code decided**. Before writing that down as a finding — especially one that lands in
`docs/staging/findings/` where others will act on it — open the function that produces the
string and the config that feeds it.

**Why:** on 2026-08-22 a finding (FD-GATE-3) was filed claiming the staging soak gate invalidated
evidence because `BASE_REF_SHA` is a frozen ref two-dot-diffed by `changedFiles()`. It merged to
`main` before three independent reviews refuted it. **Three of its four claims were false**, and
each was refuted by a file that was never opened:

- *"`BASE_REF_SHA` is frozen for this gate"* — `.github/workflows/staging-evidence.yml` **live-
  resolves** it via `gh api …/pulls/N` → `.base.sha`, and a contract test forbids reverting to
  the event payload. (It **is** frozen in `ci.yml` and `merge-authority.yml` — different jobs,
  a real but separate bug.)
- *"the drift is misattributed `main` history"* — `git merge-base --is-ancestor` showed the cited
  commit is genuinely between the evidence base and the current base. Real drift, 653 files.
- *"the file list comes from `changedFiles()`"* — it comes from `driftFilesIntersectingSurface`,
  fed by a diff between **two `main` commits**. `changedFiles()` supplies a different input.

The proposed fix would not have worked either: the "intersection" it recommended still left the
blocked PR failing, on a different file. And the behaviour called a bug turned out to be
**deliberate and test-pinned** — `check-staging-evidence.test.ts` asserts exactly it.

The mechanism had been assembled from the error text plus a comment in a *neighbouring* file.
Both refuting files are about thirty lines.

**How to apply:**
- **Find the emitter.** Grep the distinctive words of the message. Read the function that builds
  it, and read what feeds its inputs — a variable named for one thing is often computed from
  another.
- **Read the workflow, not just the script.** Env vars a script trusts are set in YAML, and the
  YAML may already have been fixed. `staging-evidence.yml` and `ci.yml` disagree about
  `BASE_REF_SHA` today.
- **Check whether it is deliberate before calling it a bug.** Look for a test that pins the
  behaviour and a comment explaining the choice. `changedFiles()` documents *why* it uses two-dot
  rather than three-dot; a "fix" that ignores that argument is a regression, not a repair.
- **Demonstrate the consequence, do not infer it.** Construct the case in a throwaway worktree
  and show the numbers. Two claims about gate misattribution were measured on 2026-08-22: one was
  a 27× inflation and real, the other was zero and imagined.
- **Never sample only cases you just touched.** Pushing to a PR resyncs its base, so a bug that
  affects stale PRs measures clean on any PR you have just pushed to. That produced a confident
  false "no inflation" reading the same day.
- **Re-read a current artifact before generalising from an old one.** "The soak's anchor-state
  counters are null" was true of four early cycles and repeated for a day; every current cycle
  carried them, and they showed the lifecycle transitions the soak existed to prove.

**Enforcement:** Documentation only. There is no detector for "the author did not read the
function," and a lint that demanded citations would be satisfied by pasting a path. This is
judgement, recorded because the failure shipped to `main` and cost three reviews to catch.
