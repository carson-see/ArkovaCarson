# DEG-5 triage — `org-queue-scheduler` INTERNAL (13) on the fullsoak rig

Premortem reference: `docs/staging/SOAK-PREMORTEM-SOC2-2026-08-11.md` §4 DEG-5, action-plan step 8.
Triage performed 2026-08-12 (read-only: gcloud describe/logging + bounded read-only SQL on rig ref `gnkuaywlpmsaezwvlvhk`). No infra changed, nothing restarted, no database writes.

## Verdict up front

- **Root cause (named):** `claimDueOrganizations` in `services/worker/src/jobs/org-queue-scheduler.ts` — the Zod schema at **line 18** (`org_id: z.string().uuid()`, Zod 4.4.3 strict RFC-9562) rejects the seed fixture org UUIDs `aaaaaaaa-0000-0000-0000-000000000001` and `bbbbbbbb-0000-0000-0000-000000000001` (from `supabase/seed.sql`) that `claim_due_org_queue_runs` returns; the wholesale `z.array(...).safeParse` throw at **lines 261–264** turns one bad row into a 500 for the whole pass.
- **Is it prod F-1?** **No.** Same route, same 5xx symptom, different defect. Prod's failures are transport/PostgREST-transient; the rig's are deterministic data-vs-validator mismatch. The rig did **not** reproduce F-1's mechanism (details in §4).
- **Current state:** the job stopped failing at 2026-08-11T23:44Z and has returned 200 on every attempt since (verified through 2026-08-12T12:54:08Z). It is **dormant, not fixed** — the defect re-arms the moment either seed org has a PENDING anchor again, which the 7-day soak load will cause.
- **Recommendation:** fix at the already-mandated step-11 rig rebuild by seeding RFC-4122-compliant fixture UUIDs (rig-scoped, data-only); track the worker validator defect as a separate non-gating bug. Acceptance text provided in §7 if the founder prefers to run with the defect.

## 1. Measured — job identity and config

A naming trap first: **two** jobs answer to "org-queue-scheduler" in `arkova1`/us-central1.

| Job | Target | Schedule |
|---|---|---|
| `org-queue-scheduler` (unprefixed) | `https://arkova-worker-270018525501.us-central1.run.app/jobs/org-queue-scheduler` (**prod** worker) | `*/15 * * * *` |
| `arkova-worker-fullsoak-2026-08-staging-org-queue-scheduler` | `https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app/jobs/org-queue-scheduler` (**rig**) | `4-59/5 * * * *` |

The premortem's measurement ("last attempt 2026-08-11T21:24:10Z, status.code=13") is the **rig** job — 21:24:10 matches the rig's `4-59/5` cadence, not prod's `*/15` — and the log evidence below confirms a rig 500 at exactly that timestamp. Anyone re-running `gcloud scheduler jobs describe org-queue-scheduler` gets the **prod** job; use the prefixed name.

Rig job config (describe, 2026-08-12): POST, OIDC audience = rig URL, SA `270018525501-compute@developer.gserviceaccount.com`, `attemptDeadline: 600s`, `retryCount: 3`, `state: ENABLED`, `status: {}` (last attempt succeeded), `lastAttemptTime: 2026-08-12T12:54:08Z`.

## 2. Measured — failure window and pattern

Scheduler-side (`resource.labels.job_id="arkova-worker-fullsoak-2026-08-staging-org-queue-scheduler" severity>=ERROR`, all occurrences in 120h):

```
2026-08-11T16:25:14Z … 2026-08-11T23:44:09Z   INTERNAL   URL_UNREACHABLE-UNREACHABLE_5xx (HTTP 500)
(23 ERROR entries total; none after 23:44:09Z)
```

Cloud Run request logs for `/jobs/org-queue-scheduler` on the rig service show the precise pattern — **one 500 every ~20 minutes, each immediately followed by a 200 on the Scheduler retry ~18s later; every other 5-minute tick is a fast 200 (~0.1s)**. Excerpt:

```
2026-08-11T23:44:21Z  200   (retry)
2026-08-11T23:44:03Z  500   <- last failure
2026-08-11T23:24:19Z  200   (retry)
2026-08-11T23:24:02Z  500
...
2026-08-11T21:24:28Z  200   (retry)
2026-08-11T21:24:10Z  500   <- the attempt the premortem measured
```

So the premortem's "a job that will fail every 5 minutes for seven days" was not the observed behaviour: it failed once per ~20-minute cycle (the 15-minute claim-lock reclaim window + next 5-minute tick), succeeded trivially in between, and stopped entirely at 23:44Z. Failures spanned revisions 00007→00010, so no revision change is implicated. First failure 16:25:14Z — two minutes after the rig DB was seeded (16:23:30Z, §3).

## 3. Measured — the actual error and the offending rows

Worker application log for every 500 (identical error group `CK74kI2uqcKerQE`; this one at 23:44:03Z, `req_3401fd4d6ae064f693a5db27`):

```
Error: claim_due_org_queue_runs returned invalid rows: [
  { "origin": "string", "code": "invalid_format", "format": "uuid",
    "pattern": "/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-...|ffffffff-...)$/",
    "path": [0, "org_id"], "message": "Invalid UUID" } ]
    at claimDueOrganizations (file:///app/dist/jobs/org-queue-scheduler.js:162:15)
    at async runOrgQueueScheduler (file:///app/dist/jobs/org-queue-scheduler.js:183:21)
    at async file:///app/dist/routes/cron.js:761:24
```

Bounded read-only SQL on the rig (`gnkuaywlpmsaezwvlvhk`, `statement_timeout='8s'`):

```
organization_queue_run_state rows failing the RFC-9562 pattern:
  aaaaaaaa-0000-0000-0000-000000000001  locked_at=2026-08-11 23:44:03.59+00  locked_by=org-queue-1  last_run_at=NULL  last_run_status=running  pending_anchors=0
  bbbbbbbb-0000-0000-0000-000000000001  locked_at=2026-08-11 17:15:20.68+00  locked_by=org-queue-1  last_run_at=NULL  last_run_status=running  pending_anchors=0

organizations: both created 2026-08-11 16:23:30 ("Arkova Inc." / "Acme Corporation" — the supabase/seed.sql fixtures)
anchors for those orgs: aaaaaaaa → 4 rows, all SUBMITTED (last_updated 2026-08-12 00:00:02); bbbbbbbb → 1 row, SUBMITTED (last_updated 2026-08-11 17:22:55)
```

`aaaaaaaa`'s `locked_at` equals the final 500 to the millisecond — that row was the last one claimed-and-rejected.

**Mechanism, end to end.** `claim_due_org_queue_runs` (migration `0294_org_queue_scheduler.sql`) self-seeds `organization_queue_run_state` from orgs holding PENDING anchors, then claims due orgs by **committing** `locked_at`/`locked_by` and returning `(org_id uuid, last_run_at)`. Back in the worker, `ClaimedOrgSchema` (`org-queue-scheduler.ts:18`) validates `org_id` with `z.string().uuid()`. Zod 4.4.3 enforces RFC-9562: version nibble `[1-8]`, variant nibble `[89ab]`. The seed UUIDs have `0` in both positions — valid to Postgres's `uuid` type, invalid to Zod. `safeParse` fails, the throw at :261–264 escapes to the route handler (`routes/cron.ts:724`), 500. The claim is already committed, so the Scheduler's immediate retry finds the org locked and returns 200 with zero claims; 15 minutes later the lock expires, the next tick re-claims the same row, and the cycle repeats. The failures stopped at 23:44Z only because the seed orgs' PENDING anchors were drained to SUBMITTED by the batch/flush path (independent of org-queue), so the `EXISTS (… status='PENDING')` due-condition stopped matching. Nothing about the defect was fixed.

Two aggravations worth naming:
- `z.array(...)` rejection is **wholesale**: one invalid row voids every org claimed in the pass, and all of them stay locked/stranded (`last_run_status='running'`, `last_run_at` never set) for 15 minutes. On the rig, where the fixture orgs are the population, org-queue scheduling never completes a recorded run — matching the premortem's downstream-unevidenced concern exactly.
- This is a **class**, not a line: the worker has **57** strict `z.string().uuid()` / `z.uuid()` validator sites in non-test source. Any of them that touches a seed-fixture id (`aaaaaaaa-…`, `bbbbbbbb-…`, `44444444-…` users, etc.) on the rig can fail the same way. Prod is structurally immune: its ids come from `gen_random_uuid()` (v4, always RFC-valid).

## 4. Is it the same defect as prod F-1? No.

Prod worker (`arkova-worker`), `msg="Org queue scheduler pass failed"`, 2026-07-29 → 2026-08-12: **3 occurrences total**:

```
2026-08-11T16:45:18Z  claim_due_org_queue_runs failed: Could not query the database for the schema cache. Retrying.
2026-08-02T16:45:15Z  (error serialized as {} — transport-shaped throw, no message captured)
2026-08-02T16:30:20Z  (same)
```

- Prod F-1 = **rare, transient** (3 in 14 days), PostgREST schema-cache / transport failures at the RPC call site (`org-queue-scheduler.ts:257-258` path), self-clearing on the next tick.
- Rig DEG-5 = **deterministic, periodic** (every reclaim cycle while a seed org holds a PENDING anchor), Zod validation of the RPC's *successful* result (`org-queue-scheduler.ts:261-264`).

Same route and same "5xx from /jobs/org-queue-scheduler" symptom; different failing statement, different trigger, different frequency signature. The premortem's fidelity claim ("the rig *is* reproducing a real production defect") does not survive root-cause: the rig reproduced the **symptom** of F-1, not the defect. F-1 remains open and un-reproduced on the rig.

## 5. Soak-window risk if left as-is

`organization_queue_run_state` still holds both invalid rows with `last_run_at=NULL` (always "due" whenever a PENDING anchor exists). The 7-day soak's load generation anchors under the seed orgs, so PENDING anchors will exist for long stretches → the job will 500 every ~20 minutes for those stretches, org-queue scheduling will never record a completed run, and every downstream assertion depending on it is unevidenced — the exact DEG-5 caveat, but now known to be self-inflicted seed data rather than production fidelity. It will also pollute the R8 alert-channel signal with a known-benign repeating error.

## 6. Recommendation (preferred): fix at the step-11 rebuild — rig-scoped, data-only

The premortem already mandates a full rig rebuild before Day 0 (action-plan step 11 / BL-1). Fold the fix into it:

1. **At rebuild seeding, use RFC-4122-compliant fixture org UUIDs** — e.g. `aaaaaaaa-0000-4000-8000-000000000001` and `bbbbbbbb-0000-4000-8000-000000000001` (version nibble `4`, variant nibble `8`; still visually greppable). No live-DB surgery, no FK cascade, no worker code change, no image change — BL-1's "prod's exact image digest" constraint is untouched. This is also the honest clean-mirror posture: prod contains zero non-RFC UUIDs, so a mirror should not either.
2. **Durable version:** change the UUIDs in `supabase/seed.sql` itself. Blast radius is 8 files that pin the current literals (`supabase/seed.sql`, `src/tests/rls/helpers.ts`, `tests/rls/security-hardening-0160.test.ts`, `e2e/public-org.spec.ts`, `e2e/public-org-page.spec.ts`, `services/worker/src/api/admin-actions.test.ts`, `src/components/compliance/OrgCpeMemberDashboard.test.tsx`, `src/hooks/useOrgCpeMemberSummary.test.ts`) — a test/seed-only change, T0 by the tier matrix, but it must land as one PR so fixtures don't skew. If that PR can't land before the rebuild, hand-patch the two UUIDs in the rig's seeding step and file the seed.sql PR after.
3. **File the worker defect separately (non-gating):** `ClaimedOrgSchema.org_id` validates a Postgres-`uuid`-sourced value with a strict RFC checker, and one bad row DoSes the whole pass. Fix (normal PR + bug-tracker entry, T2 since it is worker behavior): shape-only UUID validation for DB-sourced ids, and per-row salvage (log + skip invalid rows) instead of wholesale `z.array` rejection. Sweep the other 56 strict-uuid sites for the same DB-sourced pattern while there. This does not gate the soak — with compliant seed UUIDs the rig cannot trigger it, and prod cannot trigger it today.

## 7. Written acceptance (only if the founder chooses not to fix before Day 0)

> **Caveat for the evidence pack (DEG-5, corrected).** *Measured:* the rig's `arkova-worker-fullsoak-2026-08-staging-org-queue-scheduler` job returned INTERNAL (HTTP 500) once per ~20-minute claim cycle from 2026-08-11T16:25Z to 23:44Z, and will do so again during any soak interval in which a seed-fixture org holds a PENDING anchor. The failure is `claimDueOrganizations` (worker `org-queue-scheduler.ts:18,261-264`) rejecting the non-RFC-4122 seed org UUIDs from `supabase/seed.sql`; it is deterministic rig seed data, **not** a reproduction of production finding F-1, whose three occurrences in 14 days are transient PostgREST/transport failures with a different failing statement. *Asserted:* the defect is confined to environments seeded with hand-crafted fixture UUIDs; production ids are `gen_random_uuid()` and cannot trigger it. *NOT asserted:* that org-queue scheduling operated during the soak — no `organization_queue_runs` completion row can be recorded for a fixture org while the defect stands, so every downstream assertion that depends on org-queue scheduling is unevidenced for the period and is listed as such; and NOT asserted that the soak exercises or evidences anything about F-1.

Accepting means the soak's org-queue lane produces seven days of known-benign 500s and zero evidence. Given the fix is two seed literals at a rebuild that is already mandatory, acceptance is the strictly worse trade.

## Appendix — evidence provenance

- `gcloud scheduler jobs describe {org-queue-scheduler, arkova-worker-fullsoak-2026-08-staging-org-queue-scheduler} --location=us-central1 --project=arkova1` (2026-08-12).
- `gcloud logging read` on `cloud_scheduler_job` (job executions, severity>=ERROR, 120h) and `cloud_run_revision` for both services (request logs 2026-08-11T16:00Z→2026-08-12T01:00Z; app error `req_3401fd4d6ae064f693a5db27` et al., error group `CK74kI2uqcKerQE`).
- Read-only SQL on rig `gnkuaywlpmsaezwvlvhk` (`SET statement_timeout='8s'`): `organization_queue_run_state`, `organizations`, `anchors` aggregates only.
- Source: `services/worker/src/jobs/org-queue-scheduler.ts` (@ working tree, branch `fix/auth-es256-jwks-and-oidc-warn-hygiene`), `services/worker/src/routes/cron.ts:724-736`, `supabase/migrations/0294_org_queue_scheduler.sql`, `supabase/seed.sql`, worker `zod@4.4.3`.
