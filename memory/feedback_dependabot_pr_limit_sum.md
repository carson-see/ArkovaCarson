---
name: dependabot-pr-limit-sum
description: .github/dependabot.yml's open-pull-requests-limit values must sum to <= 7 across every updates entry, and every entry must set the field explicitly (an omitted field silently defaults to 5 and breaks the sum without showing up as a number in the file).
type: feedback
---

The 2026-09-21 Dependabot wave opened 13 PRs at once, took the repo to 20 open against the founder's 15-PR open-PR ceiling, and helped exhaust the GitHub Actions budget the same day — each new PR runs the full required-check matrix plus a Mergify speculative run.

**Why:** `.github/dependabot.yml`'s own header (CTO decision 2026-09-21) states the invariant: the `open-pull-requests-limit` values across all `updates` entries must sum to <= 7, so a single full Dependabot wave can never consume more than half the 15-PR ceiling in one shot. A rule stated only in a comment is easy to violate by accident on the next edit (adding an ecosystem, bumping a limit during a backlog push) with nobody re-adding the arithmetic up by hand. (The 15-PR open-PR ceiling itself is a separate, pre-existing founder rule tracked outside this repo's `memory/` corpus at present — this file does not carry it as an enforceable pointer.)

**The missing-field trap:** GitHub Actions defaults an *omitted* `open-pull-requests-limit` to 5. An entry that forgets the field reads as harmless in the YAML (no large number visible) but silently raises the TRUE effective sum — the failure mode is invisible to a human skimming the file. The detector treats a missing field as a violation on its own, independent of whatever the declared sum comes to.

**How to apply:**
- Every `updates` entry in `.github/dependabot.yml` must set `open-pull-requests-limit` explicitly.
- The sum of all declared limits must stay <= 7.
- Raising the sum, or removing a limit from an entry, is a founder decision (per the file's own header) — not something to work around locally. If the budget genuinely needs to grow, update `.github/dependabot.yml`'s header comment and this file in the same change, with the founder decision named.

**Enforcement:** CI lint `scripts/ci/feedback-rules/dependabot-pr-limit.ts`, run by `scripts/ci/check-feedback-rules.ts` (the `Policy Lints` job) on every PR. Evaluates the CURRENT file on disk (not diff-scoped) — a pre-existing violation is exactly as real as one a PR introduces. Tests: `scripts/ci/feedback-rules/dependabot-pr-limit.test.ts`.

**Override label:** none. This is a founder-decided budget, not a per-PR style call.
