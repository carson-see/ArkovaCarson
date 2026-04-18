# ADR — Migration Drift Prevention (SCRUM-908 PROD-DRIFT-01)

**Status:** Accepted
**Date:** 2026-04-19
**Jira:** [SCRUM-908](https://arkova.atlassian.net/browse/SCRUM-908)

## Context

Throughout April 2026, three production incidents shared the same root
cause: code in `main` depended on a migration that had not been applied
to production. The bugs' symptoms differed — 503 / 401 / 500 / stuck
loading skeleton — but the class was identical: *schema assumptions
diverged from production state, and nothing flagged it*.

Manual operator discipline (run `supabase db push` after each sprint)
was insufficient. Drift accumulated for 11 migrations over two weeks
before the 2026-04-19 UAT session caught it by reading
`supabase_migrations.schema_migrations` directly.

## Decision

Adopt **Option A — read-only CI diff check**. A GitHub Action runs on
every push to `main` and every PR that touches
`supabase/migrations/**`. It queries the Supabase Management API
`list_migrations` endpoint and compares to the local migration file
list. Any local migration missing in prod fails the check.

The check has **zero write permission**. It cannot apply or modify
anything. Operators apply missing migrations via existing tools
(Supabase MCP, `supabase db push`, operator runbooks).

## Why not Option B (auto-apply)?

A CI job with a service-role key that auto-applies missing migrations
sounds appealing but fails the blast-radius test:

- A migration with a CHECK violation, ENUM-value addition inside a
  transaction (known bad pattern in this codebase — see migration 0068a
  note in `CLAUDE.md`), or data-backfill failure would mark prod as
  partially-migrated. Rolling back would need manual intervention.
- Service-role keys in CI dramatically expand the attack surface for a
  GitHub compromise (forks, leaked workflow logs, compromised
  dependencies).
- Re-evaluate Option B only after Option A has been stable for 30+ days
  AND the team has a preview-branch apply strategy that can catch the
  failure classes above.

## Why not Option C (deploy gate)?

A Vercel/Cloud Run deploy gate would block code from promoting until
migrations match. It has a lower failure-mode risk than Option B but:

- Adds deploy-time latency to every normal release, not just
  drifted ones.
- Couples two independent systems (infra + DB state), making incidents
  harder to debug.
- Option A already catches drift at PR / merge time — earlier in the
  lifecycle, where it's cheapest to fix.

Keep Option C as a fallback if Option A fires frequently and the team
needs hard enforcement at the deploy layer.

## Consequences

**Positive**
- Drift is caught at PR/merge time, not at incident time.
- Zero write surface — no new credentials in CI, no new rollback paths.
- Self-documenting: the workflow file lists every exempt migration with
  a reason and a link to the ticket that removes the exemption.

**Negative / trade-offs**
- Requires a read-only Supabase access token in CI secrets. Compromise
  of this token gives an attacker a list of applied migrations
  (low-value data).
- When the check fires, someone has to manually apply the migration
  before the PR can merge. This is by design — the whole point is to
  surface drift so it gets applied.
- Exempt list can grow if not curated. Runbook dictates that every
  exempt entry has a corresponding ticket to remove the exemption.

## Exempt migrations (as of 2026-04-19)

**Intentional deferrals** (tracked, scheduled for removal):
- `0190_rls_subquery_caching` — RLS policy refactor; review against
  current prod policy set before applying
- `0191_brin_indexes_timeseries` — non-concurrent BRIN index build on
  `anchors` (2.8M rows); locks table; apply in maintenance window

**Repository artefacts / naming drift** (applied in prod under different
names, kept in the exempt list until the repo cleanup lands):
- `0033` / `0078` / `0162` — numbered gaps that never existed as files
- `.* 2` — macOS "Duplicate" `" 2.sql"` files that shadow canonical
  migrations already applied under the base name (e.g.
  `0186_treasury_cache 2.sql` vs prod's applied
  `0186_treasury_cache`). Repo cleanup tracked separately.
- `0186_.*` / `0212_.*` / `0213_.*` / `0214_.*` / `0215_.*` / `0216_.*`
  / `0216b_.*` — applied in prod under `2026041X` version strings
  (migrations pushed before the current naming convention stabilized);
  filenames exist locally but `prod.schema_migrations.name` doesn't
  match 1:1

Both categories tracked in SCRUM-908 follow-up.

## References

- Workflow: `.github/workflows/migration-drift.yml`
- Runbook: `docs/runbooks/migration-drift-playbook.md`
- Motivating incidents: `docs/bugs/bug_log.md` BUG-2026-04-18-004,
  BUG-2026-04-18-005, BUG-2026-04-19-001
- Jira: SCRUM-906 (NCA-FU2), SCRUM-907 (NCA-FU3),
  [SCRUM-908 PROD-DRIFT-01](https://arkova.atlassian.net/browse/SCRUM-908)
