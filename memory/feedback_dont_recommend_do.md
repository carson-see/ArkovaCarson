---
name: dont-recommend-do
description: Do the work; don't hand back a recommendation. "You should X" in a PR body or a doc means X did not get done and the reader inherited it.
type: feedback
---

When a task is executable inside the session, execute it. A PR description, handoff, or doc that says "you should update the snapshot" / "please consider adding a test" / "we recommend redeploying" has converted an agent's job into the reader's job.

**Why:** The failure is invisible at review time. The PR reads as complete, the checklist looks addressed, and the actual change is a sentence describing a change. It surfaces later as a gap nobody owns — the classic form being a feature shipped with its hook and no UI, where every gate was green because every gate was measuring the part that got built. Passive phrasing is the linguistic tell that precedes it.

**How to apply:**
- If you can run it, run it. If you can write it, write it. If you can file it, file it.
- If a step genuinely cannot be done by an agent — prod worker deploys (`feedback_worker_hands_off.md`), merges (`feedback_never_merge_without_ok.md`), account creation, credentials — don't phrase it as a recommendation. Name the owner and the exact command/artifact: "Carson runs `gcloud run deploy …` per runbook §4", not "you should redeploy."
- Same for deferred work: file the Jira ticket and link it, rather than leaving "consider filing a follow-up" in a body.
- Rewrite `you should` → the imperative with an owner. Rewrite `we suggest that` → what you did, or what is blocked and on whom.

**Enforcement:** CI lint `scripts/ci/feedback-rules/feedback_dont_recommend_do.ts` (SCRUM-1306, orchestrated under R0-7). It scans the PR body (`GITHUB_PR_BODY` / `PR_BODY`) and every changed `.md` file for `you should`, `please consider`, `recommend doing`, `suggest that`, `you could try`.

**This check is ADVISORY — it always exits 0 and never blocks a PR.** It prints matches so a human notices the pattern. (Note: `scripts/ci/feedback-rules/agents.md` describes it as "blocks" — that description is wrong; the script returns `ok: true` on every path.)

**Override label:** none needed — the check cannot fail.
