> ## ⚠️ CORRECTED 2026-08-21T20:40Z — the mechanism named below is wrong
>
> This finding blames TRAIN-6's own `2249-anchor-expiry-sweep` probe for reverting the fixture
> anchor `SUBMITTED → PENDING`. **It did not, and could not.** `jobs/anchorExpirySweep.ts` selects
> only `status = 'SECURED'` (`.eq('status','SECURED')`, `expires_at < now`, `deleted_at IS NULL`)
> and moves those to `EXPIRED`. It has no code path that reads or writes a `SUBMITTED` row.
>
> The reclaimer was `public.recover_stuck_broadcasts()` (migration `0379`), run by the in-process
> `recover-stuck-broadcasts` cron (`routes/scheduled.ts`, `*/2 * * * *`) against
> `status IN ('BROADCASTING','SUBMITTED') AND updated_at < now() - 5 min AND chain_tx_id IS NULL`.
> The row stamps its own provenance: `metadata._recovery_reason = 'stuck_submitted_null_txid'`,
> `_recovered_from_status = 'SUBMITTED'`.
>
> **This matters because it changes the fix.** Retargeting or removing the driver probe — step 4
> of the Resolution below — would have changed nothing: no load-driver change can stop an
> in-process DB cron. The fixture itself had to change (`chain_tx_id` NOT NULL). It is also not
> TRAIN-6-specific: **every** rig seeded with `scripts/staging/seed-baseline-fixture.sql` has it.
>
> Full mechanism, proof, and the durable-fixture recipe:
> [`FD-SEED-1`](FD-SEED-1-baseline-fixture-self-reverts-in-7-minutes.md).
>
> **The general rule this finding states is still correct and still worth keeping** — "check
> whether the driver's own actions can violate the preconditions its window is judged against."
> The rule survives; only the worked example's causal attribution was wrong. Widen it slightly:
> ask the same question of every scheduled job in the *deployed image*, not only of the probes
> in your driver. Everything below is retained unedited.

# FD-TRAIN6-1 — a soak driver can invalidate its own preflight condition

**Found:** 2026-08-21, running the real preflight against TRAIN-6.
**Jira:** SCRUM-3189. **Class:** evidence integrity — a new one. Not "the driver measured nothing"; the driver **destroyed the precondition its own window is judged against.**

## What happened

TRAIN-6 soaks **PR #2249** (`services/worker/src/jobs/anchorExpirySweep.ts` — anchor lifecycle, T3)
on an isolated rig. Its preflight returns `environment_type: fixture_seeded`, **exit 1**, failing
exactly one check:

```
submitted_anchors  false  "Zero SUBMITTED anchors — environment may lack test fixtures."
```

An operator noticed the rig's single fixture anchor was `PENDING`, transitioned it to `SUBMITTED`
at ~18:52Z, and recorded that in the stand-up doc. By **19:00:19Z it was `PENDING` again** — eight
minutes into the window.

Nothing external touched the rig. **The soak's own load driver did it.** Its
`2249-anchor-expiry-sweep` probe invokes `anchorExpirySweep` on every pass, and that job reclaims
exactly the anchor state the preflight requires. The rig converges back to `fixture_seeded` under
its own load, so re-flipping the fixture mid-window is undone within a minute and the window can
**never** reach a passing preflight while its driver runs.

## Why this is not a "note the residual risk and continue"

The chain-pair window also ran `fixture_seeded` and that was accepted, with reasoning: it was an
isolated rig, §1.11A's `clean_mirror` requirement is scoped to **shared** staging, and no PR in
that union touched the affected surface. **That reasoning does not transfer here.**

The failing check is the one that matters for this specific PR. `submitted_anchors` failing on an
**anchor-lifecycle** PR means the rig has nothing for the code under test to operate on. Waiving it
would be waiving the exact precondition that makes the soak meaningful — the soak equivalent of
asserting a test passes because it never ran.

§1.11A is also explicit: do not start, restart, or claim a soak on a project whose preflight fails.

## Resolution

The window was **voided and restarted**, not patched. ~1.5 h of a 48 h clock had elapsed, so a
clean restart was cheaper than arguing about a compromised one. The restart requires:

1. A **durable** fixture set — `SUBMITTED` anchors whose timestamps fall **outside** the sweep's
   reclaim window so they survive every pass, **plus** at least one reclaim-eligible anchor so the
   sweep still has real work and #2249's changed path is genuinely exercised.
2. Proof of durability **before** the clock restarts: seed, let the driver run ≥2 sweep passes,
   re-query, and require the `SUBMITTED` count to be unchanged.
3. A new revision, because the clock is the serving revision's `creationTimestamp` (FD-CLOCK-1).
4. The driver's sweep probe re-pointed at the reclaim-eligible fixture only, so it can no longer
   consume the anchors the preflight depends on.

## The rule this is a case of

**Check whether the driver's own actions can violate the preconditions its window is judged
against.** A soak that mutates state is not just measuring the system; it is changing the
environment the evidence describes. This is most likely exactly where it hurts most — a PR that
modifies a reclaim/cleanup/expiry job will, by construction, have a driver that destroys the
fixtures such jobs consume.

Concretely, when standing up a soak: name the preflight checks the window must satisfy, then ask
for each one whether any probe in the driver could flip it. If yes, either the fixture must be
durable against that probe or the probe must be scoped away from it. Related: [[FD-WAVE3-1]],
[[FD-LOAD-1]], [[FD-PROBE-1]] — all cases of a driver reporting something other than what it
actually exercised.
