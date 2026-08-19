# Window close — 7-day SOC2 Type 2 full-application soak

**Window: 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. COMPLETE. Closed on schedule;
close-out executed 15:52–15:5xZ on 2026-08-19.**

## Final state

- Final in-window health reading (14:59Z): 15/16 PASS — the single FAIL was the documented
  FD-CHAIN-1 recurrence signature at 14:40Z (unconfirmed-change blindness post-batch),
  self-healed by 15:00Z, recorded per standing rule. SECURED 25,896, queue drained
  organically before close, uptime monotonic, main `f374aca97`, rig `00013-mrw` untouched
  end to end.
- Trigger record: A (10,000-cap batch), B (age), D (daily flush) proven with dual-explorer
  on-chain verification; **D amended to 3 of 4 observed nights** (FD-CRON-1, 2026-08-19
  miss, chronic node-cron event-loop contention; backlog recovered organically ~11.5h
  later). C (fee deferral) NOT exercised — explicitly not asserted.
- Changes during the window, all documented in this pack: poison-record prod repair
  (controlled), Kenya transfer-basis frontend deploys ×2 (controlled, counsel-ordered),
  dependabot #2277 auto-merge (uncontrolled-but-inert; contained same-day with a branch
  lock, root-caused, durable fix planned).

## Close-out actions (2026-08-19T15:52Z+)

- `main` branch protection lock REMOVED — restored to the exact backed-up pre-lock shape.
- Anchor-traffic LaunchAgent unloaded — injection instrument stopped.
- Manual drain SKIPPED — unnecessary, queue cleared organically in-window.
- **Prod FD-CRON-1 relevance CONFIRMED: 30+ `[NODE-CRON] missed execution` warnings on the
  prod worker in the trailing 7 days** — the contention class exists in production's
  in-process cron scheduler, which owns the nightly billing drain. Migration of
  schedule-critical crons to Cloud Scheduler HTTP triggers is now a priority post-freeze
  item (pattern already in-repo via the digest jobs).

## What this window is and is not

Seven days of monitored availability and change control; ~3 days of full-throughput
durability (days 0–3 pre-load are documented as such); staging-rig observation with prod
monitoring alongside — an input artifact to SOC 2 Type 2 (SCRUM-1043), not the audit
itself. Every deviation in the window is named, root-caused, and carries its remediation.

## Post-close production catch-up (2026-08-19T19:2xZ)

Wave 0 (7 T0/T1 PRs) merged via Mergify after the close; `DEPLOY_WORKER_PAUSED` was set
false for one controlled catch-up deploy (workflow run 32290974654) and re-set true
immediately after verification, keeping the deferred-consolidated-soak merge path open for
the chain/rate-limit trio riding the 48h rig soak. Verification: prod `/health` reports
`git_sha b6cfad73c...` (main tip), status healthy, all checks ok; revision
`arkova-worker-01313-ram` at 100% traffic. Prod is fully current with main for the first
time since 2026-08-08.
