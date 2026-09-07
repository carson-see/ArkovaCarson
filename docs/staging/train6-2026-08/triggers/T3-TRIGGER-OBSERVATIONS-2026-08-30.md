# PR #2249 — the four T3 observations §1.12 requires, 2026-08-30

**Rig:** `arkova-worker-wave2-2026-08-staging`, revision `arkova-worker-wave2-2026-08-staging-00006-gik`, tag `train-6`
**Supabase:** `tkciooifwxwnkoizgalp` (`arkova-wave2-2026-08`, isolated)
**Image:** `arkova-worker@sha256:76f1d043280c24ea593932ebe4e32158afbe56a647c4be709ca93f121d8508b4`
**Deployed head (`/health` `git_sha`):** `f0e4cfe2e375b838a6f164f7c15e23d6b981c34b` — the TRAIN-6 union head, which contains PR #2249 at `df0e6fa932660d783fd5ca804b4c9c1dc5395684`
**Revision `creationTimestamp`:** `2026-08-21T20:33:58.053472Z`, unchanged — never redeployed, so the soak clock (FD-CLOCK-1) has been running continuously since the window opened

The 48h TRAIN-6 window closed `2026-08-23T20:33:58Z` having produced real lifecycle evidence
(100 anchors SECURED→EXPIRED, sum conserved) but its own stand-up doc recorded the four
T3-specific observations as **NOT RUN**. This file is those four, plus the load/concurrency
proof and a rollback rehearsal that doubles as a live negative control.

## Why these are the triggers

CLAUDE.md §1.12 names "Trigger A fires, Trigger B fires". `FD-TRIGGER-1` defines A and B as
`batch-anchor.ts`'s thresholds (10,000 pending; 3,000 pending + 3h age). **PR #2249 does not
touch `batch-anchor.ts`.** Firing those thresholds would produce exactly the generic synthetic
load §1.12 calls supporting worker-health evidence only, and the hollow single-surface evidence
the 2026-08-27 standard forbids. The two independent trigger paths of the *changed* surface were
fired instead, and each is paired with the pre-#2249 revision's result on the same rig and the
same rows so that none of them is an observation that could not have failed.

## The discriminating signal

Zod 4.4.3's `z.string().uuid()` is a strict RFC-9562 check: version nibble must be `1-8`, variant
nibble `8/9/a/b`. Postgres `uuid` is looser. A "poison" row here is one whose id Postgres stores
happily and the base validator refuses. Measured with the tree's own zod:

```
5eed0000-0000-0000-0000-0000000000b1 | strict .uuid(): false | dbUuid: true
5eed0004-0000-0000-0000-000000000001 | strict .uuid(): false | dbUuid: true
a1b2c3d4-0000-4000-8000-000000000001 | strict .uuid(): true  | dbUuid: true
b2c3d4e5-0000-4000-9000-000000000001 | strict .uuid(): true  | dbUuid: true
```

Three orgs were used: **P** = `5eed0000-…-b1` (poison org id), **G1** = `7c3f1a92-4b6d-4e18-9a25-1f0b8d47e6c3`
and **G2** = `2d84e5b7-9f3c-4a61-b7de-5c02a9184f6e` (both RFC-valid). G2 is the clean control org.

## Trigger A — `anchorExpirySweep` poison-row batch

15 due SECURED anchors: 5 poison in org P, 2 poison + 3 valid in G1, 5 valid in G2.

```
POST /jobs/anchor-expiry-sweep   2026-08-30T03:12:38Z   HTTP 200
{"checked":15,"newly_expired":15,"webhooks_dispatched":15,"errors":[],"pages":1}

worker log 2026-08-30T03:12:41.678930Z  "anchor expiry sweep complete"
  checked=15 newly_expired=15 webhooks_dispatched=15 error_count=0
  correlationId=req_37d2dded2e65f28a65a28638
```

Row transitions — all 15 SECURED→EXPIRED, one audit row each, correct org on every one:

| org | tag | rows | status after | `anchor.expired` rows | org matches |
|---|---|---|---|---|---|
| Seed Fixture Org (P) | P-poison | 5 | EXPIRED | 5 | 5 |
| T3-ORG-G1 | G1-poison | 2 | EXPIRED | 2 | 2 |
| T3-ORG-G1 | G1-rfc | 3 | EXPIRED | 3 | 3 |
| T3-ORG-G2 | G2-rfc | 5 | EXPIRED | 5 | 5 |

DB totals: SECURED 15→0, EXPIRED 100→115, `anchor.expired` audit rows 100→115, dispatch-failure
sentinels 0.

Differential control over the exact ids read back from the rig: the base validator would have
thrown on **7 of 15** in `casUpdateToExpired` and the same **7 of 15** in `insertAuditEvent`; the
PR validator rejects **0**. Note the blast radius here is per-row, not whole-pass — the sweep
already wraps each anchor in try/catch — so the base-code failure mode is *permanent starvation*
of the poison rows on this and every future sweep, not an aborted pass. The whole-pass abort
lives in Trigger B.

## Trigger B — `org-queue-scheduler` whole-batch claim (the actual DoS)

Three orgs made due, each with PENDING anchors, `last_run_at` NULL, locks clear. The literal RPC
payload the worker's `parseDbRows` receives was captured directly at `2026-08-30 03:14:42.784797+00`:

```json
[{"org_id":"2d84e5b7-9f3c-4a61-b7de-5c02a9184f6e","last_run_at":null},
 {"org_id":"5eed0000-0000-0000-0000-0000000000b1","last_run_at":null},
 {"org_id":"7c3f1a92-4b6d-4e18-9a25-1f0b8d47e6c3","last_run_at":null}]
```

```
POST /jobs/org-queue-scheduler   2026-08-30T03:15:02Z   HTTP 200
{"claimed":3,"succeeded":3,"skipped":0,"failed":0,"processed":0,"quarantined":0}

worker log 2026-08-30T03:15:03.279023Z  "Org queue scheduler pass complete"  claimed=3 quarantined=0
plus three per-org "Batch anchoring disabled (ENABLE_BATCH_ANCHORING off) — skipping batch run"
```

Row transitions in `organization_queue_run_state` — `last_run_at` NULL → timestamp on all three:

| org | last_run_at after | status | locked_at |
|---|---|---|---|
| Seed Fixture Org (P) | 2026-08-30 03:15:02.952+00 | succeeded | released |
| T3-ORG-G1 | 2026-08-30 03:15:03.147+00 | succeeded | released |
| T3-ORG-G2 | 2026-08-30 03:15:02.795+00 | succeeded | released |

Three new `organization_queue_runs` rows, distinct idempotency keys, all `succeeded`.

Differential control on that exact payload: `z.array(ClaimedOrgSchema).safeParse` under the base
validator returns **false**, so **0 of 3** orgs are served — a DoS blast radius of **3 orgs from
1 poison row**, two of which parse fine individually. `parseDbRows` returns rows=3, quarantined=0.

`processed_count` is 0 because `ENABLE_BATCH_ANCHORING` is off on this rig; the claim, the
per-org dispatch and the run-state write are the changed-code path and all three fired.

## Daily flush observation

600 due SECURED anchors — 300 poison, 300 valid, 200 per org — with `expires_at` spread every
~2.4 minutes across the preceding 24 hours (oldest `2026-08-29 03:18:11Z`, newest
`2026-08-30 03:16:11Z`). One invocation of `POST /jobs/anchor-expiry-sweep`, the endpoint
production's daily Cloud Scheduler job hits and the identical handler the in-process
`0 3 * * *` cron in `routes/scheduled.ts` calls.

```
worker log 2026-08-30T03:17:48.925756Z  "anchor expiry sweep complete"
  checked=600 newly_expired=600 webhooks_dispatched=600 error_count=0
  correlationId=req_f8e912e266b053a313400326
```

SECURED 600 → 0, EXPIRED 0 → 600, 600 audit rows, sum conserved. `EXPIRY_SWEEP_PAGE_SIZE` is
500, so draining 600 in one invocation means the keyset cursor advanced across a page boundary
with poison rows in the backlog.

**Disclosed:** curl aborted at ~60s with an HTTP/2 framing error before the body returned, so the
result above is the worker's own completion log, not the HTTP body, and `result.pages` is derived
from the 600-row drain rather than quoted. The trigger was the job endpoint rather than the
wall-clock 03:00Z tick, because this rig scales to zero and the in-process node-cron tick is not
reliably observable on it.

## Per-org isolation check

Across all 925 EXPIRED anchors on the rig, grouped by owning org:

| org | expired anchors | `anchor.expired` rows | cross-org audit rows | duplicate audit targets |
|---|---|---|---|---|
| Seed Fixture Org (poison org id) | 372 | 372 | **0** | **0** |
| T3-ORG-G1 | 272 | 272 | **0** | **0** |
| T3-ORG-G2 (clean control) | 271 | 271 | **0** | **0** |

Queue-run isolation: exactly one `organization_queue_runs` row per org, distinct idempotency
keys, all succeeded. Global conservation: 931 anchors = 925 EXPIRED + 5 SUBMITTED + 1 PENDING
residue; 925 audit rows 1:1; 0 `anchor.expired_dispatch_failed`. SUBMITTED held at exactly 5
throughout, so the preflight `submitted_anchors` invariant survived every write.

`cross_org_audit_rows` and `duplicate_audit_targets` are counts that would be non-zero if the
poison org's rows had leaked into another org's attribution, or if the six concurrent sweeps had
double-emitted. Both are 0 across all 925 rows.

## Load / concurrency

Six `POST /jobs/anchor-expiry-sweep` fired in parallel against one 200-row poison-mixed backlog,
`2026-08-30T12:31:11Z` → `12:31:34Z`, ~23.2 s each, all HTTP 200, all `errors:[]`:

```
{"checked":159,"newly_expired":1}   {"checked":200,"newly_expired":59}
{"checked":159,"newly_expired":2}   {"checked":200,"newly_expired":57}
{"checked":200,"newly_expired":60}  {"checked":158,"newly_expired":21}
```

`newly_expired` sums to **exactly 200** against a 200-row backlog — the compare-and-set drained
every row once, no double transition and no lost row — while `checked` sums to 1076, so the
passes genuinely contended rather than serialising.

## Rollback rehearsal, doubling as a live negative control

Traffic shifted 100% to revision `00003-qiz` (`BUILD_SHA a7ac4abd7c9a2923fea066f3cf5a0cf2a1baac1e`,
which does **not** contain this PR — `git merge-base --is-ancestor df0e6fa93 a7ac4abd7` is false),
same Supabase rig via the same `supabase-url-wave2` secret. A traffic split creates no revision,
so the soak clock is untouched.

Fixture: 10 due SECURED anchors, 5 poison / 5 valid, across G1 and G2.

| | PRE-#2249 (`00003-qiz`) | POST-#2249 (`00006-gik`) |
|---|---|---|
| `/health` `git_sha` | `a7ac4abd7…` | `f0e4cfe2e…` |
| expiry sweep | `checked:10 newly_expired:5` + **5** `CAS update failed … "Invalid UUID"`; 5 poison rows left **stuck SECURED** | `checked:5 newly_expired:5 errors:[]` — the same 5 rows, no data change, now EXPIRED |
| org-queue scheduler | **HTTP 500** `{"error":"Processing failed"}`; all three orgs left `last_run_status='running'`, locked `2026-08-30 15:21:29.97+00`, `last_run_at` **NULL** | `claimed:3 succeeded:3 quarantined:0`, HTTP 200 |

The base-code rejection quoted its own pattern, which is the defect in one line:

```
"pattern":"/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|…)$/"
"message":"Invalid UUID"
```

Traffic restored to `00006-gik`; `/health` `git_sha` back to `f0e4cfe2e…`; revision
`creationTimestamp` re-verified at `2026-08-21T20:33:58.053472Z`. The abandoned queue locks were
cleared (disclosed data-only reset to the pre-experiment state) rather than waiting out the RPC's
15-minute lock timeout, so the recovery half started from identical conditions.

## Rig writes — all data-only, all disclosed

Synthetic anchors in four tagged sets (`OBS-A-trigger-a`, `OBS-B-trigger-b`, `OBS-C-daily-flush`,
`OBS-L-concurrency`, `OBS-E-negative-control`), two additional organizations with RFC-valid v4
ids so the poison org has a control to be isolated from, PENDING anchors to make orgs queue-due,
and `organization_queue_run_state` resets of `last_run_at` / `locked_at`. **No**
`supabase_migrations.schema_migrations` writes, **no** `migration repair`, **no**
`db push --linked`, **no** reset.

## Raw artifacts

Untracked alongside this file, matching this train's convention that only `.md` is committed:
`obsA-trigger-a-sweep.json`, `obsA-differential-control.json`,
`obsB-trigger-b-org-queue-scheduler.json`, `obsC-daily-flush-sweep.json`,
`obsD-per-org-isolation.json`, `load-concurrency-burst.json`,
`rollback-rehearsal-and-negative-control.json`.
