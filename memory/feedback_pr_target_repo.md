---
name: pr-target-repo
description: PRs live on `carson-see/ArkovaCarson`. Not `Arkova-io/arkova-mvp2`, not a fork, not a personal mirror. CI fails if the workflow is running on any other repository.
type: feedback
---

`carson-see/ArkovaCarson` is the only repository where Arkova PRs are opened, reviewed, gated, and merged. It is what `origin` points at in this checkout, and it is the repo the CI script hard-codes as the sole allowed value.

**Why:** All of the machinery that makes a change safe is attached to *this* repo: branch protection, the `Staging Soak Evidence Gate`, the Mergify queue in `.mergify.yml`, the Merge Authority tier label, the feedback-rules orchestrator, and the CodeRabbit/Sonar review path. A PR opened against `Arkova-io/arkova-mvp2` (the named wrong target in `scripts/ci/feedback-rules/pr-target-repo.ts`) runs none of it. The work looks done — branch pushed, PR open, checks apparently passing — while sitting somewhere that Carson does not review and Mergify cannot merge.

**How to apply:**
- Before opening a PR, confirm the remote: `git remote -v` must show `https://github.com/carson-see/ArkovaCarson.git`.
- Pass `--repo carson-see/ArkovaCarson` explicitly to `gh pr create` / `gh pr view` / `gh pr checks` when a session's working directory or gh default could be ambiguous.
- If you find yourself on a fork or mirror, do not "fix it later" by re-pointing after review — re-open the PR on the correct repo so CI, the tier detector, and the evidence gate all run against the head that will actually merge.
- The one operator-authorized exception is a *different* repo entirely: `carson-see/arkova-marketing` (static Vercel marketing site, no staging rig) has its own carve-out in `.claude/hooks/block-pr-merge.sh`. That carve-out is about merge authority there, not about retargeting app-repo work.

**Enforcement:** CI lint `scripts/ci/feedback-rules/pr-target-repo.ts` (R0-7 / SCRUM-1253). It reads `GITHUB_REPOSITORY` (set automatically by GitHub Actions) and fails when it is anything other than `carson-see/ArkovaCarson`. When the variable is unset it skips — that is the local-dev path, not a pass.

**Override label:** none. There is no legitimate reason to land app-repo work elsewhere.
