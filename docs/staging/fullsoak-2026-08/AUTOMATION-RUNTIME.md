# Soak automation runtime — why it is launchd, not cron

**Problem found 2026-08-13 (Day 1):** none of the 7 crontab instruments had fired since install.
Every attempt failed with `Operation not permitted` writing to the repo.

**Root cause, established by controlled test — not assumed:**
- cron *was* executing (a control job wrote to `/tmp` successfully at 11:28Z).
- The repo lives on an **external USB APFS volume** (`/Volumes/Extreme`). macOS TCC denies
  scheduled jobs access to it — **reads and writes both** (proven: a LaunchAgent could not even
  `ls` the scripts directory).
- Granting Full Disk Access to `/usr/sbin/cron` did not help: that daemon has run since
  **Aug 4**, and TCC is evaluated at process launch. `sudo launchctl kickstart -k system/com.vix.cron`
  is refused — **`Operation not permitted while System Integrity Protection is engaged`**.
  Only a reboot would restart it.
- A user LaunchAgent was **also** blocked, so "LaunchAgents inherit the session's grants" was wrong.
  The responsible process is `/bin/bash`, which has no grant for this volume.

**Resolution — remove the dependency instead of fighting TCC.** The instruments now live on the
**internal disk** and write evidence there; a session syncs artifacts into the repo and commits.

| Path | Purpose |
|---|---|
| `~/arkova-soak-instruments/` | Executable copies of the portable instruments |
| `~/arkova-soak-evidence/` | Evidence output (`EVID_ROOT` override — the scripts already supported this) |
| `~/Library/LaunchAgents/ai.arkova.soak.*.plist` | Schedules |

| Agent | Cadence | Mechanism |
|---|---|---|
| `ai.arkova.soak.90min` | every 90 min | `StartInterval 5400` — an exact interval, unlike cron which needs two alternating entries |
| `ai.arkova.soak.daily-check` | 09:07 | `StartCalendarInterval` |
| `ai.arkova.soak.daily-probes` | 09:23 | `StartCalendarInterval` |
| `ai.arkova.soak.prod-mainnet` | 10:30 | `StartCalendarInterval` |

**Second launchd-only defect, caught by testing rather than assuming:** `gh variable get` infers the
repository from the working directory's git remote. Under launchd there is no repo context, so both
CC6.1 freeze-gate checks read empty and reported a false FAIL. Fixed by pinning
`--repo "${GH_REPO_SLUG:-carson-see/ArkovaCarson}"`. Verified after the fix: **13/13 PASS, exit 0.**

**Not migrated (require repo access, so they stay session-run):** `fullsoak-cron-exerciser.sh` and
`fullsoak-sdk-integration.sh` — the exerciser enumerates routes via `git show <sha>:…/cron.ts`.

**Standing caveat:** these run only while this Mac is awake and logged in. The GCP-side controls
(4 alert policies, 4 uptime checks) are server-side and were unaffected throughout the outage —
which is why the soak itself never went unobserved, even while local evidence collection was dead.
