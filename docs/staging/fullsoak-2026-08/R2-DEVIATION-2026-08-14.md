# R2 deviation — rig restart 2026-08-14, clock NOT reset (founder ruling)

**Status: recorded deviation from a written rollback trigger. Not a silent redefinition.**

## What happened

| | |
|---|---|
| Event | Cloud Run recycled the rig instance |
| Cold starts | `2026-08-14T03:53:03Z` and `2026-08-14T04:07:38Z`, both on `…-00013-mrw` |
| Shutdown signal | `2026-08-14T04:11:47Z` (`Received shutdown signal`) |
| Uptime effect | `131377s` → `3773s` |
| Detected by | `fullsoak-90min-soc2-health.sh` at `2026-08-14T05:09:30Z`, verdict FAIL, message: *"DROPPED 131377 -> 3773 — rig restarted; R2 (>1 restart/24h restarts the soak day) applies"* |
| Second incident | `2026-08-14T09:39Z` — `/health` returned **503 `degraded`** for ~10 min, self-recovered by the next cycle |

## The rule as written

Premortem §8 / R2: **"> 1 restart in 24 h restarts the day."** Two cold starts inside 15 minutes on 2026-08-14 trigger it on a literal reading.

## Ruling — founder, 2026-08-15: **the clock is NOT reset.** Day 7 remains 2026-08-19T15:51:30Z.

Reasoning, stated so an auditor can disagree with it:

- **The subject of the soak never changed.** Revision `00013-mrw`, image digest `sha256:8ace89d4…`, git_sha `f5d1070fc…`, env, flags and migration ledger head `0409` were verified identical before and after, and have been re-verified every 90 minutes since. R2 exists to catch *the thing under test changing*; a process lifetime ending is not that.
- **Instance recycling is inherent to Cloud Run**, and production experiences it too (prod runs min=2/max=10). A soak that forbids it is testing an environment we do not operate.
- **Uptime was a proxy, and a better direct measure now exists.** When R2 was written, worker uptime was the only continuous signal for "nothing changed". The 90-minute check now asserts revision + digest + git_sha + env-hash + flag-hash + ledger head directly, so continuity of the *subject* is measured rather than inferred.

## What this ruling does NOT claim

- It does **not** claim uptime was continuous. It was not: there is a genuine interruption at `2026-08-14T04:07Z`, and a ~10-minute `degraded` window at `09:39Z`.
- It does **not** amend R2 for future soaks. R2 stands as written; this is a documented deviation for this window, with reasoning attached.
- The Day-7 report **must** carry this deviation and both incidents. Availability during the window is *not* 100%, and any statement implying unbroken uptime is prohibited.

## Control gap this exposed, and the fix

The restart was **detected and recorded** by the local 90-minute monitor — but that monitor writes files; it does not page. The GCP alarm that WOULD have paged (`SOAK rig boot-line`) had been **retired ~12 hours earlier**, on 2026-08-13, on the reasoning that it fired on autoscaling cold starts rather than revision changes. For a soak whose clock is uptime, a cold start *is* the event of interest — retiring it removed the signal, not the noise.

**Fixed 2026-08-15:** the cold-start alarm is restored and re-enabled, with documentation on the policy itself stating it must not be retired again and that the revision-drift detector cannot see a same-revision recycle. Both detectors now run: five SOAK alert policies, all enabled.

Separately, the daily parity check was asserting only policies matching `"SOAK rig"`, so the `"SOAK bitcoind VM down"` alarm was never checked at all. Match broadened; expected count corrected 3 → 5; monitoring baseline deliberately re-captured (previous baseline archived alongside it).
