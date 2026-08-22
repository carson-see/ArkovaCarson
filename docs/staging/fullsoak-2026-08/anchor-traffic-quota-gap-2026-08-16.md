# Anchor traffic is quota-blocked 16:27Z → 00:00Z on 2026-08-16 (self-inflicted)

**Read this before treating the failing `anchor-traffic` runs as a rig fault. They are not.**

## What happened

The Trigger B volume injection (16:14–16:27Z) submitted 3,100 anchors to make
`pendingCount >= MIN_BATCH_THRESHOLD (3,000)` reachable. It consumed the org's entire
FREE-tier daily quota (`TIER_QUOTAS.FREE.anchors_created = 100`) and then kept being
denied — 70 accepted, 3,030 × HTTP 429 `ORG_QUOTA_EXCEEDED`.

Consequence: **every scheduled `ai.arkova.soak.anchor-traffic` run from 16:37Z until the
quota resets at 2026-08-17T00:00:00Z will fail with 3 × 429.** The 16:37Z run already did
(`ANCHOR_TRAFFIC: FAIL`, 0 accepted / 3 rejected, launchd exit 1).

This is a consequence of my own action, not a defect in the rig, the worker, or the
instrument. It self-corrects at the daily reset. No intervention is being taken: moving an
org to PAID/ENTERPRISE to restore traffic sooner would change the state of the software
under test mid-window for no evidentiary gain, since Trigger D fires at 03:00Z regardless
and drains whatever is queued.

## It also produced clean incremental evidence for FD-RL-2

The failing runs demonstrate the increment-on-denial defect repeatedly and in miniature:

| Moment | `org_daily_usage.anchors_created` | Anchors actually created |
|---|---|---|
| After the injection (16:27Z) | 3,132 | 98 |
| After the 16:37Z traffic run (3 × 429) | **3,135** | **98** |

Three requests were denied, created nothing, and still moved the counter by exactly 3.
That is FD-RL-2 (SCRUM-3154) reproducing on demand, and it will repeat every two hours
until midnight — each run adding 3 to a counter already 32x past reality.

## What this does NOT affect

- The 98 PENDING anchors are unaffected and remain queued for the 03:00Z Trigger D flush.
- The frozen worker revision, its digest, env, git_sha and uptime are untouched.
- Health assertions A17 (drain liveness, 26h) and A18 (treasury visibility) both pass —
  neither keys off submission success, correctly.
