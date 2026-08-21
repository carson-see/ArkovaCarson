# FD-WAVE3-1 — wave3 load driver sent an empty bearer for the first 5h10m of a T2 window

**Filed:** 2026-08-20
**Severity:** Evidence-invalidating (no production impact — staging rig only)
**Rig:** `arkova-worker-wave3-2026-08-staging` / Supabase `jiotjhqmedkajdsojsbn`
**Status:** Fixed and verified 2026-08-20T21:50Z; load window extended

## Summary

The wave3 soak driver never created its identity-token file, so **every request it made
carried an empty `Authorization: Bearer ` header**. Between the soak clock start
(`00004-cjk`, 2026-08-20T16:40:21Z) and the fix at 21:50Z, wave3 produced **zero valid
load** — not degraded load, none. Its only load artifact in that span was a manual
`soak-load-chunk1` run from 13:35, before the clock even started.

## Mechanism

In `wave3-load-loop.sh`:

- `refresh_token()` was **defined** but called from exactly one place — inside the request
  loop, gated on a `last_token_refresh` interval.
- `last_token_refresh` was pre-seeded to `start_ts`, i.e. as if a refresh had just
  happened.
- The refresh interval exceeds the 25-minute per-cycle run, so the gate never opened.
- The token file was therefore never created, and every probe ran
  `-H "Authorization: Bearer $(cat "$IDTOKEN_FILE")"` against a missing file.

The failure was visible only as repeated `cat: .../wave3-idtoken: No such file or
directory` lines in the driver log, and the mint itself was written
`> "$IDTOKEN_FILE" 2>/dev/null`, so any real mint error would also have been swallowed.

**This was not the initially suspected cause.** A cold-start health-probe race was
proposed first (the service has `maxScale=2` and no `minScale`, so it does scale to zero
and a short probe can lose to a cold start). That race is real and was also fixed, but it
only skipped some cycles. The empty bearer broke *every* request in *every* cycle.

## Fix

1. Call `refresh_token` **once at startup, after the function is defined**, and `exit 1`
   if minting fails.
2. Mint to a `.tmp` file, `mv` into place, `chmod 600` — never leave a partial token.
3. Send mint stderr to `${IDTOKEN_FILE}.err` instead of `/dev/null`.
4. Separately, retry the health probe 3× at 45s so cold starts stop skipping cycles.

## Verification

75-second run immediately after the fix, against the live rig:

```json
{ "durationSec": 75,
  "requests": { "ok": 41, "fail": 0, "status_200": 41, "status_other_2xx_4xx": 0 },
  "cronFires": 1 }
```

41/41 at HTTP 200, versus zero valid requests before.

## Consequence for the wave3 T2 evidence

wave3 is declared **T2** (7 members), minimum 12h soak.

Per FD-CLOCK-1 the *clock* is the serving revision's `creationTimestamp` plus integrity
conditions, and those hold: `00004-cjk` unchanged, traffic 100%, health green. **The clock
is not reset.** But CLAUDE.md §1.12 additionally requires that *the soak exercise the
changed behavior*, and for 16:40:21Z → 21:50Z nothing was exercised.

**Ruling: do not declare wave3 mature at 04:40:21Z.** The load window is extended to 12h
measured from first real load — **2026-08-21T09:50:00Z**. Declaring maturity on a window
half of which carried no load would not meet the standard set for the 7-day soak.

## Note on what was NOT a defect

While investigating, wave2's harness looked like it was failing 99% of requests. It is
not. `scripts/staging/load-harness.ts` deliberately drives:

- `/api/v1/verify/STG-ANC-DEADBEEF` and `/api/v1/anchors/STG-ANC-DEADBEEF` — an ID that is
  *meant* to be absent, to exercise the lookup path; 404 is the correct response.
- `/api/rules/demo-event` unauthenticated — the harness comment states this exercises "the
  auth middleware + rate limiter under load"; 401/429 is the intended outcome.

The harness counts every non-2xx as `fail`, which makes correct behavior read as failure
in the evidence JSON. **No harness change was made.** Read the mode comments before
treating a high `fail` count as a regression.

## Related

- `FD-CLOCK-1-instance-uptime-is-the-wrong-soak-clock.md` — clock definition.
- `FD-TRIGGER-1-ambient-load-cannot-reach-triggers-a-b.md` — the companion load-driver
  defect found in the same sweep.
