---
name: actions-spend-discipline
description: GitHub Actions minutes are a metered budget. PRs stay draft until merge-ready, CI runs once per merge-ready head, commits are batched locally, and a zero-step "Actions budget" failure is a billing wall, not a code signal.
type: feedback
---

PRs are opened as draft and stay draft until merge-ready (drafts skip the full test matrix); total open PRs stay at or under 20, all draft, or 15 if any session-authored PR is non-draft, bot PRs included. CI runs once per head: never "re-run all", and never re-run CI on a head that is mid-soak just to turn it green. Commits are batched locally, because every push to a PR branch is a full matrix. A job that fails with zero steps and the annotation "an Actions budget is preventing further use" is a billing wall: stop pushing, do not re-run, tell the founder.

**Why:** a Monday Dependabot batch (twelve PRs, each a full matrix plus Mergify speculative runs) on top of a heavy PR day exhausted the Actions budget; every job then failed with zero steps, nothing could go green, Mergify could merge nothing, and no deploy could run until the budget was raised. Sessions that kept pushing and re-running would have burned the refill the same way.

**How to apply:**
- Open PRs with `gh pr create --draft`; convert to ready only when evidence and reviews are complete. `gh pr ready --undo` does not move the head, so it never voids a soak window.
- Before re-running anything, read one failed job: zero steps plus the budget annotation means stop, not retry.
- Dependabot volume is capped in `.github/dependabot.yml` (sum of `open-pull-requests-limit` at or under 7, majors grouped, schedules staggered). Raising it is a founder decision.

**Enforcement:** documentation only today (CLAUDE.md §0 rule 11). The Dependabot cap is enforced by the config file itself; a limit-sum lint under `scripts/ci/feedback-rules/` is the intended CI guard.
