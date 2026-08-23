# My manual health runs were reading a stale state file (2026-08-15 → 2026-08-16)

**The automated SOC 2 evidence was correct throughout. What was wrong is the health
status *I* reported from manual runs during the monitoring loop.**

## What was broken

`fullsoak-90min-soc2-health.sh` compares uptime and SECURED count against a prior
reading held in a state file. Two state files existed:

| Path | Written by | State |
|---|---|---|
| `~/arkova-soak-evidence/90min-health-last-state.txt` | launchd (plist sets `STATE_FILE` explicitly) | fresh, every 90 min |
| `~/arkova-soak-evidence/day0-snapshots/90min-health-last-state.txt` | nothing since 2026-08-15T14:52Z | **frozen at `last_uptime=125147`** |

The script read `EVID_ROOT`, but my manual runs passed `EVID_ROOT_ABS` — which every
*other* soak instrument honours and this one ignored. So my runs fell through to the repo
default and read the orphaned `day0-snapshots` copy. My rsync (`~/arkova-soak-evidence/` →
repo) then restored that stale orphan over the freshly-written repo copy every pass,
preserving its Aug-15 mtime.

## Why it matters

For ~33 hours every manual run reported `A1.2 uptime monotonic — PASS`, comparing live
uptime against a frozen `125147`. It passed **only because uptime kept exceeding that
number**, not because it matched the previous reading. That is an assertion passing for
the wrong reason — the exact failure class this check exists to prevent.

After the 22:57:05Z instance recycle it then FAILed for the wrong reason too, reporting
`DROPPED 125147 -> 2067` when the true previous reading was 258.

**The launchd captures — the actual SOC 2 evidence — were correct the whole time.** The
23:17:31Z capture reports `DROPPED 236445 -> 1228`, the true pre-restart uptime, and
detected the recycle properly. No evidence artifact is invalidated. What was unreliable
was my in-loop reporting of A1.2.

## Fixes

1. **Orphan deleted** (both copies) so it cannot mislead again.
2. **`EVID_ROOT_ABS` now accepted** as an alias for `EVID_ROOT`, so every soak instrument
   takes the same override and a manual run cannot silently diverge from launchd.
3. **Default `STATE_FILE` moved** off the `day0-snapshots/` subpath to match what launchd
   actually uses.
4. **New assertion `CC7.2 monotonic-state freshness`** — FAILs when the prior state is
   older than 3h (cadence is 90 min), because a monotonic comparison against a stale
   anchor is not an assertion. Verified in both directions:
   - correct env → `PASS (prior state 0m old)`, 16 pass / 0 fail
   - deliberately stale file → `FAIL (prior state 1963m old)`, 14 pass / 2 fail

The guard also caught a bug in itself during development: it was first called one line
*before* `check()` was defined, so it silently no-op'd and never appeared in the report.
The count staying at 15 instead of 16 is what exposed it.

## Correct invocation for manual runs

    EVID_ROOT="$HOME/arkova-soak-evidence" \
    STATE_FILE="$HOME/arkova-soak-evidence/90min-health-last-state.txt" \
    GH_REPO_SLUG=carson-see/ArkovaCarson \
      bash scripts/staging/fullsoak-90min-soc2-health.sh
