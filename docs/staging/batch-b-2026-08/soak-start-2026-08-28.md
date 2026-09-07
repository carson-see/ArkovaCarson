# Batch B — T2 soak clocks started 2026-08-28

Five PRs, all **T2**, tiers computed by running `requiredTierFor()` from
`scripts/ci/check-staging-evidence.ts` directly against each PR's real changed-file list
(`gh pr view <n> --json files`), not asserted:

| PR | tier | `requiredTierFor()` reason |
|---|---|---|
| #2434 | T2 | `services/edge/src/mcp-server.ts` — edge worker |
| #2435 | T2 | `services/worker/src/api/v1/webhooks/ats.ts` — public API surface |
| #2437 | T2 | `services/worker/src/api/_org-auth.ts` — public API surface |
| #2439 | T2 | `services/worker/src/api/_org-auth.ts` — public API surface |
| #2441 | T2 | `services/worker/src/api/v1/router.ts` — public API surface |

`isFrontendOnlyChange()` is `false` for all five, so none qualifies for the frontend-targeted
T2 evidence path; each needs the full worker-artifact evidence set.

## Rig

Standing rig, shared with Batch A by tag. Supabase `fizyjojbebyalirtjjht`
(`arkova-staging-2026-08`, `ACTIVE_HEALTHY`, region `us-east-2`), Cloud Run
`arkova-worker-staging` in `arkova1` / `us-central1`. None of the five touches
`supabase/migrations/`, RLS, schema, cron or queue semantics, so under §1.11A they can
truthfully share one clean database state.

**Preflight:** `scripts/ci/staging-honesty-preflight.ts --project-ref fizyjojbebyalirtjjht
--prod-project-ref vzwyaatejekddvltxyye` reported

    environment_type = clean_mirror
    timestamp        = 2026-08-28T13:06:57.031Z
    8 of 8 checks passing (staging_only_rows, duplicate_names, duplicate_versions,
    known_artifacts, submitted_anchors=1, prod_divergence, org_topology=2 orgs / 0 seed,
    prod_facts)

Stored at `preflight-probe-20260828T130657Z.json`. That timestamp is **before** every clock
start below, which is what the gate requires.

Existing tags on the shared service were verified untouched after all Batch B work:
`pr-2264`, `pr-2398`, `pr-2400`, `train-migration-t3` each still serve their own `git_sha`.
The four isolated services (`arkova-worker-ferpa2314-staging`, `arkova-worker-wave2-2026-08-staging`,
`arkova-worker-sec-2336-staging`, `arkova-worker-sec-2355-staging`) were not touched at all.

## Fixture seeded for these soaks

Data only — no DDL, no migration rows, so the preflight classification is unaffected:

* users `batchb-member-b1@seed-fixture.invalid` (ORG_MEMBER, org b1) and
  `batchb-admin-b2@seed-fixture.invalid` (ORG_ADMIN, org b2), alongside the existing
  ORG_ADMIN of org b1 — three identities across two orgs
* API keys `batchB-full-b1`, `batchB-narrow-b1` (scope `verify` only), `batchB-full-b2`
* anchors `ARK-DOC-BBQ001/2` (PENDING_RESOLUTION, org b1), `ARK-DOC-BBQ003` (org b2),
  `ARK-BBSEC-000001/2`, `ARK-BBREV-000001`, `ARK-BBPEN-000001`, `ARK-BBSTALL-000001`
* ATS integrations for org b1 and org b2 with distinct webhook secrets
* attestations `ARK-ATT-BBORG1` / `ARK-ATT-BBORG2` sharing one subject identifier across the
  two orgs, so the ATS org-scoped search assertion is only satisfiable by real scoping
* `private.api_key_settings` and `switchboard_flags.ENABLE_MCP_SERVER` seeded to match prod
  (see `rig-findings-2026-08-28.md`, F-BB-2 and F-BB-3)

## Clocks

The soak clock is the Cloud Run revision's `creationTimestamp` (worker uptime), not the driver
loop. Window ends are computed with `date -u -j -f` — without `-u` macOS parses the end as local
time and a 12h window silently overruns by four hours.

<!-- CLOCKS -->

> **SUPERSEDED — the 2026-08-28 clocks below were never claimable and are void.**
> The revisions were created 2026-08-28 13:22-14:00Z, but the sessions driving them died
> before any window completed, so the interval from `creationTimestamp` carried no continuous
> load. Anchoring on revision uptime would have claimed a window that had none. `launch.sh` was
> changed to anchor `CLOCK_START` at **driver start** (honouring a `LOAD_START` override); the
> original is kept at `launch.sh.bak`. Worker uptime remains unbroken and is the conservative
> half of the claim, but the **LOAD window below is what is claimed.**

## Clocks — RELAUNCH 2026-08-29 (authoritative)

All five relaunched only after their driver produced a cycle artifact with **0 deviations**.
A supervisor being alive is not evidence; the clean artifact is.

| PR | revision | LOAD start (UTC) | LOAD end (UTC) | cycle gap | first clean artifact |
|---|---|---|---|---|---|
| #2434 | `arkova-worker-staging-00354-wod` | 2026-08-29T14:23:30Z | 2026-08-30T02:23:30Z | 180 s | `cycle-20260829T142414Z.json` (27 checks / 0 dev) |
| #2435 | `arkova-worker-staging-00356-qip` | 2026-08-29T14:23:33Z | 2026-08-30T02:23:33Z | 180 s | pre-window `cycle-20260829T141741Z.json` (22 checks / 0 dev) |
| #2437 | `arkova-worker-staging-00358-yon` | 2026-08-29T14:23:37Z | 2026-08-30T02:23:37Z | 120 s | pre-window `cycle-20260829T142057Z.json` (20 checks / 0 dev) |
| #2439 | `arkova-worker-staging-00360-non` | 2026-08-29T14:23:41Z | 2026-08-30T02:23:41Z | 90 s | pre-window `cycle-20260829T141056Z.json` (24 checks / 0 dev) |
| #2441 | `arkova-worker-staging-00361-fab` | 2026-08-29T14:23:48Z | 2026-08-30T02:23:48Z | 120 s | pre-window `cycle-20260829T142232Z.json` (19 checks / 0 dev, admitted=100 first429=101) |

**Preflight for this window:** `preflight-20260829T141523Z.json` —
`environment_type=clean_mirror`, 8 of 8 checks passing, timestamp `2026-08-29T14:15:34.220Z`,
which is **before every clock start above**, as the gate requires.

Artifacts from before this window were moved to `evidence/pr-<n>/pre-window-20260829/` so the
close-capture roll-up counts only in-window cycles.

**Two disclosed coverage gaps found during relaunch** — see `rig-findings-2026-08-28.md`
F-BB-7 (BB-D1, the ATS attestation search filters a non-existent `org_id` column, pre-existing
on `origin/main`) and F-BB-8 (BB-D2, PR #2435's whole `checkr.ts` diff is unreachable and
`/webhooks/checkr` is 503 in production). Neither is a #2435 regression; both are pinned as
observed behaviour with a named discriminating signal rather than asserted green.

**Approved by:** Claude Opus 5, acting CTO under delegated technical authority (Carson, 2026-08-28).

## What each driver exercises

Per-cycle artifacts land in `evidence/pr-<n>/cycle-<ts>.json`, each carrying every probe, every
named check, and the deviation list. A driver exits 3 on a real deviation and 4 when the only
deviations match that PR's single named tolerated signal; the supervisor counts tolerated ones
and halts the window if they stop being isolated.

* **#2434** — mixed 6-member `oracle_batch_verify` batch containing a good anchor, an unknown id,
  a duplicate, a REVOKED anchor, a PENDING anchor and one member deliberately stalled past the
  10s Supabase timeout by a local fault proxy. Asserts per-member isolation, input ordering, the
  exact three-key failure row, envelope HMAC over the partial payload, an all-failed batch still
  being well-formed rather than `isError`, the 25-member schema cap still rejecting, and the edge
  auth boundary (no credential / bogus credential -> 401 + `WWW-Authenticate`). The stall is the
  only way to reach the branch this PR fixes.
* **#2435** — the ATS post-nonce catch-all (branch A1): a poisoned body throws after the nonce
  commits, and the driver asserts the 500, then reads `ats_webhook_nonces` to prove the row was
  released, then replays the identical bytes and requires another 500 rather than a swallowed
  `200 duplicate`. Plus replay protection non-regression on the success path, per-integration
  secret isolation (org B2's URL signed with org B1's secret -> 401), provider-segment binding,
  org-scoped attestation search across two orgs that share a candidate name, a PostgREST `.or()`
  injection probe, and the reachable Checkr surface.
* **#2437** — the full authorization matrix on `GET /api/queue/pending`: anonymous, ORG_MEMBER,
  ORG_ADMIN of each org, API-key-as-bearer, a wrong-key JWT, the limit clamp, and the published
  OpenAPI contract. The ORG_MEMBER probe additionally asserts no seeded filename and no
  `ARK-DOC-BBQ` appears anywhere in the body, and both admins assert they never see the other
  org's rows.
* **#2439** — the scope guard on all four PHI mounts: downscoped claim, `compliance:write`-only
  claim (intersection, not union), explicit empty claim vs absent claim, the API-key branch
  (sufficient JWT + insufficient key must still 403), and the two boundaries behind it that must
  keep holding — cross-org and ORG_MEMBER-on-admin-route — plus the missing-`x-org-id` 400 and a
  forged token.
* **#2441** — the changed behaviour as a measurement: an anonymous burst on the public verify
  surface must admit >= 100 before its first 429 while advertising `X-RateLimit-Limit: 100`, and
  exhausting it must leave the 60/min `/api` backstop, the 10/min adminRouter bucket and the
  1000/min keyed tier untouched. Also the case-insensitive carve-out, the public projection
  carrying no internal identifiers, and window recovery.

`negative-controls-2026-08-28.md` records the unfixed behaviour measured live on the same rig,
so each of these assertion sets is known to discriminate rather than to pass vacuously.
