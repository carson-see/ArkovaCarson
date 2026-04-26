# SCRUM-1235 honest-close runbook (R1-9 / SCRUM-1263)

> **Scope:** R1-9 of the [SCRUM-1246](https://arkova.atlassian.net/browse/SCRUM-1246) recovery epic. Operational only — no code change. Runs after R0-4 (deploy unblock) lands a worker push and Cloud Run rolls a new revision with `--build-arg BUILD_SHA=$github.sha` baked.
>
> **Why:** SCRUM-1235 was marked "Merged + migration applied" on 2026-04-25 13:37 UTC but never transitioned `To Do` → `Done` because Cloud Run was still on rev `00394` (image SHA `b8bf567f4...`). Forensic 5/8 documented this. The R0 wave shipped the infrastructure that lets us close the story honestly; R1-9 executes the close.

## Prerequisites

- [x] R0-4 ([SCRUM-1250](https://arkova.atlassian.net/browse/SCRUM-1250)) merged — deploy gate uses `npm run lint`
- [x] R0-1 ([SCRUM-1247](https://arkova.atlassian.net/browse/SCRUM-1247)) merged — `BUILD_SHA` baked at Docker build, `/health.git_sha` returns it
- [x] R0-5 ([SCRUM-1251](https://arkova.atlassian.net/browse/SCRUM-1251)) spec merged — see `docs/jira-workflow/automation-rules.json`. UI deployment is [SCRUM-1305](https://arkova.atlassian.net/browse/SCRUM-1305) (operator step); R1-9 can complete without it but R0-5 rule R3 (Cloud Run SHA match) won't auto-block.
- [ ] At least one worker-touching commit landed on `main` since R0-4 merge so `deploy-worker.yml` actually fires
- [ ] Cloud Run image SHA matches `git rev-parse origin/main`

## Step-by-step

### 1. Confirm the deploy actually happened

```bash
# Live SHA on Cloud Run /health
LIVE_SHA=$(curl -fsSL https://arkova-worker-270018525501.us-central1.run.app/health | jq -r .git_sha)
HEAD_SHA=$(git rev-parse origin/main)
echo "live=$LIVE_SHA  head=$HEAD_SHA"
[ "$LIVE_SHA" = "$HEAD_SHA" ] && echo "✅ in sync" || echo "❌ drift — STOP and investigate"
```

If drift, look at the most recent `deploy-worker.yml` run on GH Actions and triage. Do NOT continue R1-9 until SHAs match.

### 2. Trigger Run Now smoke

Open the admin Production Smoke Tests panel at `/system-health` (admin-only) → click **Run Now**. Confirm:

- [ ] All 6 checks pass (`database`, `anchor-count`, `recent-secured`, `config-sanity`, `rls-active`, `build-sha-present`)
- [ ] All latencies < 1s
- [ ] Top-level `gitSha` field in response equals the live SHA from step 1
- [ ] `build-sha-present` `detail` shows the same SHA (proves the new R0-1 check is wired correctly end-to-end)

### 3. Capture verification artifacts

- Screenshot the smoke test result panel (success state, all checks green) → attach to the SCRUM-1235 Jira ticket as `verification-2026-MM-DD.png`
- Pull the matching `audit_events` row:

  ```sql
  SELECT created_at, details
  FROM audit_events
  WHERE event_type = 'smoke_test.completed'
  ORDER BY created_at DESC LIMIT 1;
  ```

  Paste the row JSON into the SCRUM-1235 ticket as a comment.
- Note the Cloud Run revision number (`gcloud run services describe arkova-worker --region=us-central1 --format='value(status.latestReadyRevisionName)'`)

### 4. Update Confluence audit page 27361284

- [ ] Tick all unticked `[ ]` boxes in the Definition of Done section that are now true
- [ ] Add a new `## Resolution (2026-MM-DD)` section linking:
  - Screenshot from step 3
  - audit_events row link
  - Cloud Run revision number + image SHA
  - SCRUM-1235 Jira ticket
  - PR #547 (the fix) + the post-R0 deploy commit

### 5. Bug-tracker entry

Add a row to https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4 with:

- ID: `BUG-2026-04-22-smoke-tests-anchor-count-timeout`
- Severity: P0
- Symptom: Smoke test `anchor-count` check timed out at 60s on `/cron/smoke-test`
- Root cause: `count: 'exact'` against 1.4M-row anchors table hit PostgREST 60s ceiling
- Fix PR: #547 (SCRUM-1235)
- Closure: this runbook (R1-9 / SCRUM-1263)
- Detection mechanism that should have caught it: now exists as count:'exact' baseline CI job (R0-8 / SCRUM-1254)

### 6. Update HANDOFF.md "Now"

Add a brief entry referencing this closure. Per R0-6 lint, every prod-state claim must link a verification artifact — the screenshot + audit_events row + revision number are sufficient.

### 7. Transition Jira

- SCRUM-1235 → Done. The R0-5 workflow validators (when SCRUM-1305 closes) will check:
  - PR merged > 30 min ago (PR #547 merged 2026-04-25 13:37 UTC ✅)
  - Cloud Run SHA matches the linked PR's merge commit (verified in step 1)
  - Confluence DoD ticked (done in step 4)
  - reporter ≠ resolver (the closure happens via this runbook, not the original author)
- Comment on SCRUM-1235 linking SCRUM-1263 + this runbook so future readers see the honest closure trail.

### 8. Close SCRUM-1263 itself

Same gate set. Update its Confluence per-story page with a link to this runbook + the verification artifacts.

## Acceptance criteria (DoD for SCRUM-1263)

- [ ] SCRUM-1235 status = `Done`, `resolution = Fixed`
- [ ] Confluence page 27361284 has a "Resolution" section with verifiable artifacts (screenshot, audit_events row, revision number, image SHA)
- [ ] HANDOFF.md "Now" reflects honest state with R0-6 lint passing
- [ ] Bug-tracker has a row for the regression
- [ ] R0-5 workflow validator did not block the transition (proves the validator works for legitimate closures) — this AC is **only verifiable after SCRUM-1305 closes**

## Why this is a runbook and not code

Every step requires either prod credentials (Cloud Run, audit_events SELECT, screenshot upload), Atlassian write permissions on a closed ticket, or a manual edit to the master bug-tracker Sheet. None of these can be automated from a worker code change. The R0 wave was the code work; R1-9 is the operational follow-through that proves R0 worked end-to-end.
