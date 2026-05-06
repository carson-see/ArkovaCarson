# PR #700 prod 0295 verification — 2026-05-06

## Scope

- PR: [#700](https://github.com/carson-see/ArkovaCarson/pull/700)
- Jira: [SCRUM-1668](https://arkova.atlassian.net/browse/SCRUM-1668)
- Prod Supabase project: `vzwyaatejekddvltxyye`
- Migration applied: `0295_pr700_rls_baseline_reconciliation`
- Applied via: Supabase Management API `POST /v1/projects/vzwyaatejekddvltxyye/database/migrations`
- Authorization: Carson explicitly authorized Codex to apply `0295` in the PR #700 continuation thread on 2026-05-06.

## Ledger Drift Blocker

After the 2026-05-06 Arkova migration-rule clarification, this migration is
**not Done** because prod recorded the applied migration under timestamp version
`20260506113532` instead of numeric version `0295`.

The schema effects below are real and verified, but the ledger is not reconciled
to the required numeric convention. Stop before merging #700 or deploying the
prod worker until Carson/operator explicitly reconciles the prod Supabase
migration ledger. Do not run `migration repair`, prod `db push --linked`, or any
other ledger mutation from Codex without explicit sign-off.

## Preflight

Read-only Management API migration list before apply:

```json
{
  "count": 293,
  "has_0295": false,
  "matching": []
}
```

Read-only SQL preflight at `2026-05-06T11:35:03.362181+00:00`:

```json
{
  "ledger_0295_rows": 0,
  "memberships_select_org_members_exists": true,
  "audit_insert_policies": ["audit_events_insert_own"],
  "audit_dml_grants_to_browser_roles": [],
  "get_anchor_tx_stats_exec_grants": [],
  "matview_browser_grants": []
}
```

## Apply

The migration was applied with name `0295_pr700_rls_baseline_reconciliation` and query body from [`supabase/migrations/0295_pr700_rls_baseline_reconciliation.sql`](../../supabase/migrations/0295_pr700_rls_baseline_reconciliation.sql).

Management API response:

```text
apply_migration_http_status=200
[]
```

## Postflight

Management API migration list after apply:

```json
{
  "count": 294,
  "matching": [
    {
      "version": "20260506113532",
      "name": "0295_pr700_rls_baseline_reconciliation"
    }
  ]
}
```

Read-only SQL postflight at `2026-05-06T11:36:07.542572+00:00`:

```json
{
  "ledger_0295_rows": 1,
  "ledger_0295_rows_detail": [
    {
      "version": "20260506113532",
      "name": "0295_pr700_rls_baseline_reconciliation"
    }
  ],
  "memberships_select_org_members_exists": false,
  "audit_insert_policies": [],
  "audit_dml_grants_to_browser_roles": [],
  "get_anchor_tx_stats_has_body_guard": true,
  "get_anchor_tx_stats_exec_grants": [],
  "matview_browser_grants": []
}
```

Explicit RPC privilege check at `2026-05-06T11:36:31.929149+00:00`:

```json
{
  "anon_can_execute_get_anchor_tx_stats": false,
  "authenticated_can_execute_get_anchor_tx_stats": false,
  "service_role_can_execute_get_anchor_tx_stats": true
}
```

## Drift Rerun

Migration Drift rerun: [run 25429502352 / job 74603343923](https://github.com/carson-see/ArkovaCarson/actions/runs/25429502352/job/74603343923).

Result:

```text
All local migrations are applied in prod.
```

This result came from the older drift gate, which accepted matching migration
names even when prod used a timestamp ledger version. PR #700 now adds a stricter
PR-owned numeric migration check so this exact `0295` state is surfaced as a
blocking ledger drift finding.

## Remaining #700 Gates

- Prod migration ledger reconciliation for `0295` is required before Done.
- Real #700 worker/staging T2 behavior validation is still owed. Shared staging remains coordinated with active #695/#697 work unless explicitly released or an isolated environment is approved.
- Review approval is still required before merge.
- Do not merge #700 without explicit user approval.
