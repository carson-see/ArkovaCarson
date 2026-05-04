# Staging Rig — Operations Reference

> **Authoritative reference** for the `arkova-staging` rig. CLAUDE.md §1.11 points here. Every session should read this before touching `scripts/staging/*` or running a soak.

## Live state (as of 2026-05-04)

| Field | Value |
|---|---|
| Supabase project ref | `ujtlwnoqfhtitcmsnrpq` |
| Project name | `arkova-staging` |
| Organization | `byhkazrpmivhcsuqjtva` (carson-see's Org) |
| Region | `us-east-2` (matches prod for soak fidelity) |
| URL | https://ujtlwnoqfhtitcmsnrpq.supabase.co |
| Database host | `db.ujtlwnoqfhtitcmsnrpq.supabase.co` |
| Postgres version | 17.6.1.113 |
| Cost | $10/month (Supabase Pro project; pause-when-idle if soaked rarely) |
| Cloud Run worker | `arkova-worker-staging` (region `us-central1`, `--no-traffic` `--min-instances=0`) |

## Why a standalone project (not a Supabase preview branch)

Two failure modes killed the preview-branch approach on 2026-05-04:

1. **Lettered-suffix migration builder bug.** Supabase preview-branch builder regex is `^(\d{14}|\d{1,4})_` and silently skips `0055b_seed_alignment_idempotent.sql`. Migration 0056 then runs without its prerequisites and the branch hits `MIGRATIONS_FAILED` with `column a.issued_at does not exist`. Both prior orphan branches (`08b02c0f`, `5b225c3f`) died this way and were deleted.
2. **Cost clock on idle preview branches.** $0.01344/hr per branch — $9.66/mo each — and they don't pause when idle the way a standalone project does.

A standalone Supabase project applies migrations via `npx supabase db push --linked`, which uses the Supabase CLI parser (not the preview-branch builder) and recognizes lettered suffixes natively. So 0055b applies cleanly, no fix-forward gymnastics required.

## Authorization model

* The project itself: created via Supabase MCP `create_project` after `get_cost` + `confirm_cost`. Carson authorized the $10/mo on 2026-05-04.
* CLI access: requires `supabase login` (Carson interactive) before `supabase link --project-ref ujtlwnoqfhtitcmsnrpq`.
* Service role + anon keys: pull via Supabase MCP `get_publishable_keys`. Never check service role key into the repo.
* Cloud Run worker: `arkova-worker-staging` deploy needs `gcloud auth login` (Carson interactive) + `gcloud config set project arkova1`.

## How to populate / re-populate the schema

From a CLI session with Supabase auth:

```bash
supabase login
supabase link --project-ref ujtlwnoqfhtitcmsnrpq
supabase db push --linked
```

Then apply migrations exempt from the drift check (those marked in `.github/workflows/migration-drift.yml` `exempt_regex`) via Supabase MCP `apply_migration` against `project_id=ujtlwnoqfhtitcmsnrpq`.

`db push --linked` will apply every file in `supabase/migrations/*.sql` in version order, including:
* `0055b_seed_alignment_idempotent.sql` — the file that bit the preview branches.
* All four-digit prefixes through current main HEAD.

## How to run a T2 soak (CLAUDE.md §1.12)

1. **Acquire the lease** — only one soak runs at a time:
   ```bash
   STAGING_SUPABASE_URL="https://ujtlwnoqfhtitcmsnrpq.supabase.co" \
   STAGING_SUPABASE_SERVICE_ROLE_KEY="<service_role>" \
   ./scripts/staging/claim.sh acquire <pr-number> "<short reason>"
   ```
2. **Seed** — `npx tsx scripts/staging/seed.ts` against the staging URL.
3. **Run the load harness** — `npx tsx scripts/staging/load-harness.ts` for ≥4h.
4. **Rollback rehearsal** — for any new migration in the PR, apply its `-- ROLLBACK:` block and confirm the worker still passes /health, then re-apply.
5. **Capture evidence** — fill PR body's `## Staging Soak Evidence` block with: Tier, Staging branch (= project ref), Worker revision, Soak start/end, E2E result, Migration applied, Rollback rehearsed.
6. **Release the lease** — `./scripts/staging/claim.sh release <pr-number>`.
7. **Mark PR ready** — `gh pr ready <N>` (only after the evidence block is complete).

## Cost discipline

* The project is $10/month. If no soak has run for >7 days, pause it via the Supabase dashboard. Resume costs nothing per the Supabase Pro pricing model.
* Do NOT spin up additional preview branches on top of `ujtlwnoqfhtitcmsnrpq`. Use the project itself; sequence soaks via `claim.sh`.

## Future sessions: read this BEFORE picking up rig work

If you find yourself about to:
* `Supabase MCP create_branch` against prod project_ref → STOP. The standing rig is a standalone project, not a preview branch.
* Hardcode `vzwyaatejekddvltxyye` (prod) anywhere in `scripts/staging/*` → STOP. Staging is `ujtlwnoqfhtitcmsnrpq`.
* Apply a migration via Supabase MCP `apply_migration` to staging → only do this for files in `migration-drift.yml` `exempt_regex` (those that haven't yet been promoted to prod). All other migrations apply via `db push --linked`.
