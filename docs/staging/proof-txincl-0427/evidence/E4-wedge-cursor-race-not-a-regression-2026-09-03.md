# PR #2524 -- wedge-cursor A2/A3 failures on live-08 / live-09: root cause

## Verdict

**Not a defect in the PR's H1 fix.** The sweep cursor in
`services/worker/src/jobs/confirmation-proof-populate.ts` advances and wraps
exactly as designed, and this is independently confirmed by direct database
state, not just by driver assertions. The two failed cycles (`r1-live-08`,
`r1-live-09`) are a **soak-driver / T3-evidence-methodology gap**: the
driver's A2/A3 assertions implicitly assume they are the only caller
advancing the shared in-process sweep cursor during a cycle, but the isolated
rig also runs a **required** Cloud Scheduler trigger (`Trigger A` in
CLAUDE.md Section 1.12's own T3 field list) hitting the exact same route, on
the exact same single instance, sharing the exact same module-level cursor
variable. A Scheduler tick landing between two driver-polled ticks silently
consumes the wedge cohort in a call the driver's own evidence log never sees.

Confidence: **high**. This is not inferred from the code alone -- it is
confirmed by live GCP config, exact-timestamp Cloud Run request-log
correlation in both failing cycles, and a direct read-only SQL check of
current `anchor_proofs` state.

## The mechanism, file:line

1. **The cursor is a single shared, in-process module variable, with no
   per-caller isolation.**
   `services/worker/src/jobs/confirmation-proof-populate.ts:414`
   ```ts
   let scanCursorAnchorId: string | null = null;
   ```
   Read at the top of every scan (`:466`: `const cursor = options.startAfterAnchorId ?? scanCursorAnchorId;`)
   and unconditionally rewritten after every scan, success or failure
   (`:550-551`):
   ```ts
   if (options.startAfterAnchorId === undefined) {
     scanCursorAnchorId = rows.length > 0 ? rows[rows.length - 1].anchor_id : null;
   }
   ```
   The function's own doc comment (`:395-401`) already scopes the guarantee
   correctly: "this is in-process state, so a restart (or **a second Cloud
   Run instance**) restarts its own sweep... it is not a durable checkpoint."
   It anticipates a second **instance**. It does not anticipate a second
   **caller on the same instance** -- which is exactly what this rig has.

2. **Two independent, uncoordinated callers share that one cursor.**
   - `services/worker/src/routes/cron.ts:350` -- the HTTP route
     `POST /jobs/populate-confirmation-proofs` calls `runConfirmationProofBackfill()`
     with no cursor override.
   - `services/worker/src/jobs/confirmation-proof-backfill.ts:94` --
     `populateConfirmationProofsForSecuredAnchors(db, provider, { minConfirmations })`,
     never passing `startAfterAnchorId`, so it always falls through to the
     shared `scanCursorAnchorId`.
   - `services/worker/scripts/pr2524-proof-txinclusion-driver.ts:1320` -- the
     driver's own ticks POST to `${targetUrl}/jobs/populate-confirmation-proofs`,
     the identical route.
   - The escape hatch the underlying function already exposes
     (`startAfterAnchorId`, `confirmation-proof-populate.ts:462`) is **not**
     threaded through either the HTTP route or `runConfirmationProofBackfill()`,
     so neither the Scheduler nor the driver can get an isolated cursor even
     if they wanted one -- both are structurally forced onto the same shared
     state.

3. **Trigger A (Cloud Scheduler, `*/5 * * * *`) is required, not accidental.**
   `scripts/staging/provision-isolated-rig.sh:688-717` provisions, for
   `chain`-profile isolated rigs, a Cloud Scheduler job
   `<service>-populate-confirmation-proofs` -> `POST /jobs/populate-confirmation-proofs`
   at `SCHEDULER_CONFIGURED_SCHEDULE="*/5 * * * *"` -- required because
   node-cron does not fire on a throttled Cloud Run instance (comment at
   `provision-isolated-rig.sh:685-688`, and again at `cron.ts:339-341`).
   CLAUDE.md Section 1.12's T3 row itself requires "Trigger A fires, Trigger B
   fires" as an evidence field. A prior operator note already on this rig,
   `evidence/E3-scheduler-trigger-observation-2026-09-02T2038Z.md`, names
   this exact job as Trigger A and the driver's own tick sequence as Trigger
   B -- the dual-trigger topology is by design, not an oversight to eliminate.

## Live confirmation (read-only, this session)

**Cloud Scheduler config**, confirmed directly against the rig:
```
$ gcloud scheduler jobs describe arkova-worker-proof-txincl-0427-staging-populate-confirmation-proofs \
    --project=arkova1 --location=us-central1
httpTarget:
  httpMethod: POST
  uri: https://arkova-worker-proof-txincl-0427-staging-kvojbeutfa-uc.a.run.app/jobs/populate-confirmation-proofs
schedule: '*/5 * * * *'
state: ENABLED
```
Same Cloud Run service, same route the driver polls, actively firing, right now.

**Exact-timestamp correlation**, `gcloud logging read` on
`resource.labels.service_name="arkova-worker-proof-txincl-0427-staging"`,
`httpRequest.requestUrl:"populate-confirmation-proofs"`:

`r1-live-08` (jsonl `utc`: `2026-09-02T22:32:22.414Z`, `status: fail`):
```
22:32:27.739  node                     tick 0  scanned=1000
22:33:14.352  node                     tick 1  scanned=1000
22:34:01.266  node                     tick 2  scanned=880   (sum=2880, all non-wedge rows)
22:34:48.401  node                     tick 3  scanned=0     (the documented wrap condition)
22:35:00.208  Google-Cloud-Scheduler   <-- independent Trigger A tick, 12s after the wrap
22:35:33.750  node                     tick 4  scanned=0, anchorsBlockMismatch=0  <-- driver never sees the wedge
```

`r1-live-09` (jsonl `utc`: `2026-09-03T00:32:12.974Z`, `status: fail`) -- **identical pattern**:
```
00:32:18.026  node                     tick 0  scanned=1000
00:33:05.248  node                     tick 1  scanned=1000
00:33:52.349  node                     tick 2  scanned=880
00:34:39.549  node                     tick 3  scanned=0     (wrap)
00:35:00.247  Google-Cloud-Scheduler   <-- independent Trigger A tick, 21s after the wrap
00:35:24.891  node                     tick 4  scanned=0, anchorsBlockMismatch=0
```

In both failing cycles, once the driver's own tick 3 exhausts and wraps the
non-wedge cohort, the only thing left eligible in the whole 3,000-row fixture
is the wedge (120 rows, `block_header IS NULL` by design, never resolvable --
the K1 per-anchor reorg gate in `confirmation-proof-populate.ts:237-244`
rejects every wedge row because its seeded `block_hash` deliberately never
matches the fetched proof). The Scheduler's independent call, landing in the
12-21 second gap right after the wrap, is the one that actually scans the
freshly-wrapped cursor's first page -- i.e. the wedge -- attempts and rejects
all 120 writes (invisible to the driver, since that HTTP response goes to
Cloud Scheduler, not the driver), and still advances the shared cursor past
it (per the documented "advance past a page whether or not it succeeded"
rule at `:538-540`). The driver's own tick 4 then queries a cursor that has
already moved past the wedge and finds nothing. `anchorsBlockMismatch` stays
0 in every tick the driver itself observes, so both A2 ("first page must show
the wedge") and A3 ("the tick after a wrap must show the wedge") fail -- not
because the sweep failed to visit the wedge, but because a different,
required caller visited it first, off-camera.

By contrast, the two earlier passing cycles found the wedge on the driver's
own tick 0 (`live-06.jsonl` A2 detail: "tick 1 scanned=1000 with
anchorsBlockMismatch=0 after tick 0 reported 120", i.e. tick 0 itself
reported mismatch=120). That is a timing coincidence -- no Scheduler tick
happened to beat the driver to the wedge that time -- not evidence the
mechanism is sound only sometimes.

**Direct DB check**, read-only, this session, Supabase MCP `execute_sql`
against project `uqobkjhlnqmcpjidngxr` (the isolated rig, never prod):
```sql
SELECT a.metadata->>'_cohort' cohort, count(*) n,
       count(*) FILTER (WHERE ap.block_header IS NULL) header_null,
       min(ap.anchor_id::text), max(ap.anchor_id::text)
FROM anchor_proofs ap JOIN anchors a ON a.id = ap.anchor_id
WHERE a.metadata->>'_purpose' = 'pr2524-proof-txinclusion'
GROUP BY 1;
```
Result:
```
bulk:   n=450,  header_null=0    anchor_id range 2524a000-...0001 .. ...01c2
spread: n=2430, header_null=0    anchor_id range 2524b000-...0001 .. ...0195
wedge:  n=120,  header_null=120  anchor_id range 00000000-...0001 .. ...0078
```
This is the exact, current, ground-truth state: 100% of the non-wedge cohort
(450+2430=2880) is fully populated, and 100% of the wedge remains
unresolved -- precisely the H1 guarantee (every non-wedge row visited and
completed; the un-completable wedge is the only thing still eligible, sorted
at the absolute floor of UUID space so it is always first after a wrap). This
matches a prior operator probe (`evidence/E1-direct-probes-2026-09-02.md`
Section 1), which independently walked `anchor_proofs` population counts
across scheduler ticks (880 -> 1,880 -> 2,880 populated, 120 remaining) and
concluded the same thing: "A build with the pre-fix cursor... reports 0/0 on
every tick; this rig advanced by 1,000 per page and stopped precisely at the
never-completable cohort." The fix works. The database proves it
independently of the driver's own tick bookkeeping.

## Ruling out the hypotheses given

- **(a) per-tx/per-block memoization silently skipping 119 of 120 wedge
  rows** -- ruled out by code: `populateConfirmationProofs` groups by
  `chain_tx_id` only to avoid redundant RPC *fetches* (one `gettxoutproof`
  call per unique tx, `:124-166`), but the write-set loop (`:196-267`)
  iterates and evaluates every anchor in the group independently through the
  K1 gate. There is no cache that would let one lucky fetch silently "handle"
  the other 119 rows -- all 120 are re-evaluated, and all 120 are rejected,
  every time the wedge is scanned. Consistent with the direct DB check:
  120/120 still `header_null`, not 1/120 or 119/120.
- **(b) an additional WHERE condition the wedge structurally fails** -- ruled
  out: the wedge is failing the intended, documented K1 reorg gate
  (`:237-244`), not an unintended predicate. It shows up in the scan (it's
  eligible -- `block_header IS NULL`), just never gets written.
- **(c) "wrap" is a one-time boolean latch** -- ruled out by code:
  `:550-551` recomputes `scanCursorAnchorId` from `rows.length` on every
  scan call, not from a sticky flag. It fires as many times as there are
  empty pages, from any caller, forever. The correlated logs above show a
  wrap being genuinely re-triggered by a normal Scheduler tick outside the
  driver's own polled ticks, which would be impossible under a one-shot
  latch.

## What should actually change (not executed -- read-only investigation)

The shipped H1 fix in `confirmation-proof-populate.ts` does not need a code
change. The gap is in T3 evidence collection for this PR:

1. `services/worker/scripts/pr2524-proof-txinclusion-driver.ts`'s A2/A3
   (`:393-437`) should either treat a direct DB probe (as `E1` already did
   manually) as authoritative when they disagree with the driver's own tick
   log, or the driver should briefly pause/resume the Scheduler job around
   each cycle's tick burst -- `provision-isolated-rig.sh` already has a
   pause/verify/resume pattern for Scheduler (`SCHEDULER_HOLD_SCHEDULE`,
   used around `clean_mirror`) that could be reused per-cycle.
2. `NOT_ASSERTED` in the driver (`:129`) currently warns only about
   multi-instance cursor divergence. It should be extended to name the
   multi-caller-single-instance case demonstrated here: Trigger A can race
   Trigger B on the same shared cursor and make a single cycle's A2/A3
   spuriously fail even though the sweep is behaving correctly -- re-run with
   a fresh rearm, or check `anchor_proofs` directly, before concluding H1 is
   broken.
3. Lower-priority, genuinely separate observation: the cursor has no
   concurrency guard at all (unlike, e.g., the proof-backcatalog classifier's
   advisory lock referenced in `cron.ts`). That is consistent with its own
   documented scope ("not a durable checkpoint") and is not something this PR
   ever claimed to fix, but it is the same root-cause class that produced
   today's flaky evidence and is worth a one-line acknowledgment if a future
   PR touches this cursor again.

## Files referenced

- `services/worker/src/jobs/confirmation-proof-populate.ts` (lines 237-244,
  395-414, 452-466, 500-513, 538-551) -- sweep/cursor/K1-gate logic,
  unchanged between the fix commit `a3f1d6b36` and the current PR head
  `e5815e9ac` (verified: `git diff a3f1d6b36 e5815e9ac --
  services/worker/src/jobs/confirmation-proof-populate.ts` is empty).
- `services/worker/src/jobs/confirmation-proof-backfill.ts` (line 94) --
  production wiring, no cursor override passed.
- `services/worker/src/routes/cron.ts` (line 350; comment at 339-341) -- the
  one shared HTTP route both Trigger A and Trigger B call.
- `services/worker/src/routes/scheduled.ts` (lines 55, 309) -- the in-process
  node-cron backup registration (not the active mechanism on this rig, since
  Cloud Run throttles it; Cloud Scheduler is).
- `services/worker/scripts/pr2524-proof-txinclusion-driver.ts` (lines 129,
  352-437, 1320) -- A2/A3 assertions and the driver's own tick target.
- `scripts/staging/provision-isolated-rig.sh` (lines 685-717) -- Trigger A
  provisioning, `*/5 * * * *`, required for `chain`-profile T3 rigs.
- Evidence already on disk (read, not modified): `live-06.jsonl` (pass),
  `live-07.jsonl` (pass), `live-08.jsonl` (fail), `live-09.jsonl` (fail),
  `E1-direct-probes-2026-09-02.md`, `E2-base-movement-residual-risk-2026-09-02.md`,
  `E3-scheduler-trigger-observation-2026-09-02T2038Z.md`.

## Scope / what was and wasn't touched

Read-only throughout. One `SELECT` via Supabase MCP `execute_sql` against
`uqobkjhlnqmcpjidngxr` (the isolated rig, confirmed not prod, not the shared
staging ref). `gcloud scheduler jobs list/describe` and `gcloud logging
read` are both read-only. No writes, no rearm, no redeploys, no PR edits, no
merges. Nothing on `main` or in prod was touched or queried.
