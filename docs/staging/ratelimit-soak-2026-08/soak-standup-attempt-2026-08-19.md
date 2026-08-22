# PR #2269 rate-limit-cluster T2 soak — standup attempt, 2026-08-19 — STOPPED before deploy

**PR:** [#2269](https://github.com/carson-see/ArkovaCarson/pull/2269) — `rc/rate-limit-cluster-2026-08`
**Head SHA:** `fadc04c927ee4c41966d87bf86c969931b02c97e`
**Base SHA:** `92ed61cb689b46c13ebadbdad6e96ddfde3f481f` (`main`)
**Declared tier:** T2 (worker behavior + public API surface; no migrations)
**Authorization:** Founder directive authorizing new-soak standup (per session instruction, 2026-08-19)
**Outcome:** **Did not deploy. Did not start a soak clock. Did not provision anything.** Shared staging is structurally unusable — see evidence below. Machine-readable capture: [`diagnostic-2026-08-19.json`](./diagnostic-2026-08-19.json).

## What this PR needed

Per CLAUDE.md §1.12 (T2) and the PR's own "Soak requirements" section, a 12h soak against this exact head exercising: cross-instance Upstash counting across ≥2 Cloud Run instances, once-per-request counting under double-mount, env-namespaced keyspaces (staging traffic must not touch prod's Upstash budget or verify-cache/idempotency keys), and a scheduled Upstash-blackhole window to observe the new per-instance circuit breaker (open at 5 consecutive failures, half-open probe at 30s, fail-open headers throughout).

None of that could start, because the worker never got a place to run against a live database.

## Why: the standing shared staging rig does not exist

CLAUDE.md §1.11 and `docs/reference/STAGING_RIG.md` describe `arkova-staging` (Supabase project ref `ujtlwnoqfhtitcmsnrpq`) as the standing, standalone Supabase project backing `arkova-worker-staging`. Per §1.11A, before starting any T2/T3 soak the required step is `scripts/ci/staging-honesty-preflight.ts` against that exact ref. Running it is where this attempt stopped:

```
$ npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref ujtlwnoqfhtitcmsnrpq --format json
::error::Failed to query schema_migrations: TypeError: fetch failed
(exit 1)
```

That is not a `soak_artifact` / `fixture_seeded` / `clean_mirror` classification — the script can't reach the database layer at all. Following that thread:

1. **Supabase MCP `list_projects`** (the only org this account belongs to, `byhkazrpmivhcsuqjtva`) returns exactly three projects: `ehqqearcitrgloibtjqx` (arkova-connector-sidecar-2026-08), `vzwyaatejekddvltxyye` (prod), `gnkuaywlpmsaezwvlvhk` (arkova-fullsoak-2026-08). **`ujtlwnoqfhtitcmsnrpq` is not among them.**
2. **Supabase MCP `get_project('ujtlwnoqfhtitcmsnrpq')`** returns `MCP error -32600: You do not have permission to perform this action`. We successfully enumerate and describe the other three projects in the same org as the org owner, so this reads as "doesn't exist," not "access restricted."
3. **DNS**: `ujtlwnoqfhtitcmsnrpq.supabase.co` is `NXDOMAIN`. Control check: `supabase.co` itself resolves fine, and unrelated external hosts (`google.com`, `api.github.com`) resolved and returned HTTP 200 in the same session — this isn't a sandbox/network-egress restriction, this specific subdomain genuinely does not exist.
4. **Live proof from the worker itself**: the shared `arkova-worker-staging` Cloud Run service (main URL, IAM-protected, hit with a gcloud identity token — not a PR tag route) is currently reporting:
   ```
   HTTP 503
   {"status":"degraded","version":"0.1.0","git_sha":"0cbdd9a6da61b54ad4886cb3f8afeef87d846ab9",
    "uptime":44,"network":"mainnet","checks":{"database":"error","anchoring":"ok","kms":"ok"}}
   ```
   `uptime: 44` means this was a fresh cold start for this single health check, and it *still* couldn't reach its database. This is a live, current condition of the shared rig, not an artifact of anything this session did.

## Not the anticipated failure mode

The task briefing flagged a known trap: "the shared service template drifts onto dead rig secrets — verify its secret bindings point at `ujtlwnoqfhtitcmsnrpq` before deploying, fix bindings if drifted." I checked (`gcloud run services describe arkova-worker-staging --region=us-central1 --project=arkova1`) — **the bindings are correct.** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the service's revision template point at the `supabase-url-staging` / `supabase-service-role-key-staging` secrets, which is the right naming, not some other rig's secret. `MEMPOOL_API_URL` is correctly unset. Upstash secrets (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) are wired.

The problem is one layer deeper: those correctly-named secrets hold connection details for a Supabase project that itself no longer exists. There is no binding to fix — the target is gone.

## Scope of the problem

This is not specific to PR #2269. The shared `arkova-worker-staging` service currently carries ~45 other PR-tagged revisions on the same service (`pr-1459`, `pr-1443`, `pr-1439`, `pr-1326`, …, going back to `pr-810`) that all point at the same `supabase-url-staging` / `supabase-service-role-key-staging` secrets. Every one of them is presumably in the same degraded state right now. **This blocks every T1/T2/T3 shared-staging soak in the repo, not just this PR.** No entry in `HANDOFF.md` `## Now` or in `memory/` explains when or why `ujtlwnoqfhtitcmsnrpq` disappeared — `git log` shows it was stood up 2026-05-04 (`352cf4e87`) and there is no later commit recording its teardown.

## What was and wasn't done

**Done:**
- Read `CLAUDE.md`, `docs/reference/STAGING_RIG.md`; ran `scripts/agent/ack-claude-bootstrap.sh` (acknowledged).
- Confirmed PR #2269 head/base SHA and CI status (`gh pr view 2269`) — CI is green except the (expected, no-soak-yet) Staging Soak Evidence Gate and an unrelated `gitleaks` scan failure; PR is already `isDraft: true`, not marked ready.
- Ran the §1.11A-mandated `staging-honesty-preflight.ts` against `ujtlwnoqfhtitcmsnrpq` — failed at the network layer (see above).
- Confirmed via `gcloud run services list --project=arkova1 --region=us-central1` that `arkova-worker-fullsoak-2026-08-staging` is a **separate** Cloud Run service from `arkova-worker-staging` — so a (hypothetical, not-executed) deploy to the latter would not have touched the fullsoak rig.
- Captured the full diagnostic trail as evidence (this doc + `diagnostic-2026-08-19.json`).

**Deliberately NOT done, per the task's own stop condition ("if shared staging is structurally unusable, report exactly why and stop — do NOT provision a new Supabase project without explicit approval"):**
- No image built or deployed to `arkova-worker-staging` or any other service.
- No new Supabase project provisioned.
- No writes of any kind to `arkova-worker-fullsoak-2026-08-staging`, its backing project (`gnkuaywlpmsaezwvlvhk`), or prod (`vzwyaatejekddvltxyye`).
- No soak clock started, no min-instances change, no blackhole-window scheduled (there is nothing to schedule it against).
- PR #2269 left exactly as found: draft, `needs-carson-merge` label, no Ready transition attempted.

## Recommendation

Needs an operator decision, not a Claude decision, because it's a cost action either way:

1. **Rebuild `arkova-staging`** per `docs/reference/STAGING_RIG.md`'s from-scratch replay procedure (new project, same ref-naming convention, re-run the migration replay + baseline fixture seed, repoint the `*-staging` Secret Manager entries at the new project's URL/key), then re-run this soak standup; or
2. **Confirm the deletion was intentional** (e.g. an undocumented cost sweep) and formally retire the shared-rig model in `CLAUDE.md` §1.11 / `STAGING_RIG.md` in favor of per-soak isolated rigs (`scripts/staging/provision-isolated-rig.sh`), each with its own approved Supabase project — which is the isolated-service path the task allowed, but which still requires the same "explicit approval, cost" gate the task itself invoked.

Either path needs Carson's sign-off before any new Supabase project gets created. This session did not create one.

---
_Written 2026-08-19T16:21Z. No prod, migration, or schema state was asserted or changed by this investigation._
