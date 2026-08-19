# FD-CRON-1 — in-process cron missed the 2026-08-19 daily flush (Trigger D)

**Day-7 finding. The 03:00Z daily forced flush did not run on 2026-08-19: no flush log
messages in the 02:50–03:35Z window, oldest PENDING aged to 1,395 minutes by 13:52Z, and
SECURED flat at 25,860 since 2026-08-18 ~14:37Z while injections continued to be accepted
(traffic agent 3/3 `201 accepted` every cycle). First missed flush of the window — the
16th, 17th and 18th all fired and are independently verified on-chain.**

## Mechanism (evidence-bounded)

The rig worker emits `[NODE-CRON] [WARN] missed execution ... Possible blocking IO or high
CPU user at the same process used by node-cron` warnings **chronically** — first occurrence
2026-08-11T16:00:03Z (before the window opened), observed at aligned minute-marks (:00,
:34, :50, :55) including 50+ in the final 24h. The instance was NOT idle-throttled at 03:00Z
(heap telemetry, treasury cache refreshes, and confirmation checks all logged through the
window) — this is event-loop contention inside the shared process, worst at the top of the
hour where multiple crons and IO collide. 03:00:00 is exactly such a collision point, and
last night — the quietest of the window — the daily flush was the cron that got skipped.

## What this changes in the evidence

- Trigger D reliability is **3 of 4 observed nights**, not "every night." The three firings
  and their on-chain verification stand unchanged; this document amends the coverage claim.
- A17 (drain liveness, 26h threshold) remained PASS throughout and would have breached at
  ~16:37Z — after clock close. The ~30 pending micro-queue anchors drain after the window
  closes, via an explicitly-labeled manual trigger (NOT counted as a Trigger D observation).
- NOT asserted: whether prod's 03:00Z drain shares this failure rate. Prod runs the same
  in-process cron architecture with different load; verifying prod's flush history is a
  named post-freeze action.

## Disposition

No rig intervention before clock close (2026-08-19T15:51:30Z) — a forced drain in the final
hours would trade a real finding for a cosmetic number. Durable fix direction: move
schedule-critical crons (daily flush, batch evaluation) from in-process node-cron to Cloud
Scheduler HTTP triggers — the pattern already exists in the codebase (cloud-scheduler
coverage contract; the digest jobs use it). Jira + bug-tracker rows to follow at close-out.

## Addendum (14:59Z): backlog drained organically; A18 blip = documented FD-CHAIN-1 recurrence

Between 13:52Z and 14:59Z a non-Trigger-D batch path drained the accumulated micro-queue:
SECURED 25,860 → 25,896 (+36). The 14:40:01Z health run then recorded the known FD-CHAIN-1
signature — "worker reported treasury empty" — because the fresh batch's change output was
the treasury's only UTXO and `listUnspent(minconf=1)` hides unconfirmed change (recurrence
of the documented one-block stall; recorded per standing rule, not re-diagnosed; fix is
draft PR #2250). By 15:00:00Z "Treasury pre-flight check passed" — visibility self-healed
on the next block, exactly the characterized behavior.

Consequences: (1) the planned post-window manual drain is unnecessary — the queue cleared
organically inside the window; (2) the Trigger D amendment stands unchanged (3 of 4 nights
— the 03:00Z flush itself did not run; a different batch leg recovered the backlog ~11.5h
later); (3) the 14:40Z A18 FAIL row in the health archive is expected evidence of the known
defect, not a new incident.
