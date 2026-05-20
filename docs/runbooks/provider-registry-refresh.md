# Provider Registry Quarterly Refresh Runbook

> Version: 2026-05-20 | Classification: Internal | Jira: SCRUM-1933 / SCRUM-1949 | Recurring template: SCRUM-1978
> Confluence: https://arkova.atlassian.net/wiki/spaces/A/pages/57671690/Provider+Registry+Quarterly+Refresh+Runbook

This runbook controls the quarterly refresh for `cpe_provider_registry` and
`cle_provider_registry`. The process supports SOC 2 Type 2 CC8 evidence by
requiring an operator-owned change record, a database audit trail, and overdue
Slack detection.

## Cadence and Ownership

- Cadence: once per quarter, with the Jira recurring task due by the fifth
  business day after quarter close.
- Owner: Arkova operator or platform admin only.
- Required reviewer: second Arkova operator for production updates.
- Evidence locations: the quarterly Jira task, this Confluence runbook, the PR
  that changes registry seed data if applicable, and `audit_events` rows with
  `event_type = 'provider_registry.updated'`.

## Sources to Check

- CPE: NASBA sponsor registry and provider course pages.
- CLE: state bar CLE provider directories and provider course pages.
- CTID validation: after SCRUM-1926 adds `registry_ctid`, resolve every non-null
  value with `GET https://credentialengineregistry.org/resources/ce-{registry_ctid}`.
  A 404 or mismatched organization name is a manual-investigation finding.

## Quarterly Jira Task Template

Create a quarterly Jira task assigned to the operator with this checklist:

- Link this runbook.
- List CPE providers reviewed, source URL, prior status, new status, and
  `last_verified_date`.
- List CLE providers reviewed, source URL, prior status, new status, and
  `last_verified_date`.
- Record every `NOT_FOUND` provider with the source searched and reviewer.
- Record CTID validation results after SCRUM-1926 is available.
- Paste the audit query result count for `provider_registry.updated`.
- Paste the overdue Slack dry-run result from staging.
- Add operator and reviewer sign-off.

## Preflight

1. Confirm PR #841 or its equivalent has landed the provider registry tables.
2. Confirm migration `0315_provider_registry_refresh_controls.sql` has been
   reviewed. Do not run `supabase migration new`.
3. Confirm there is no migration ledger drift before any production application.
   If numeric local migrations and timestamp remote migrations disagree, stop
   and flag Carson.
4. Confirm `SLACK_OPS_WEBHOOK_URL` is configured in staging for alert testing.
5. Optional override: set `PROVIDER_REFRESH_OVERDUE_DAYS`; default is `95`.

## Update Procedure

Run registry updates in a transaction and stamp the operator UUID first. The
audit trigger reads `arkova.operator_id`; without it, the trigger falls back to
the request JWT subject or database role.

```sql
BEGIN;

SELECT set_config('arkova.operator_id', '<operator-profile-uuid>', true);

UPDATE public.cpe_provider_registry
SET nasba_status = 'confirmed',
    last_verified_date = CURRENT_DATE,
    notes = 'Verified against NASBA registry on <date>; source URL: <url>',
    updated_at = now()
WHERE lower(provider_name) = lower('<provider name>');

COMMIT;
```

Use `approval_status` instead of `nasba_status` for `cle_provider_registry`.
For providers that cannot be verified, set status to `not_found` or
`not_approved` only after the second operator confirms the source search.

## Verification

Audit trail:

```sql
SELECT created_at, actor_id, target_type, target_id, details
FROM public.audit_events
WHERE event_type = 'provider_registry.updated'
ORDER BY created_at DESC
LIMIT 20;
```

Expected evidence fields in `details`: `operator_id`, `provider_name`,
`fields_changed`, `old_values`, `new_values`, and `last_verified_date`.

Overdue alert:

```bash
curl -X POST "$WORKER_URL/jobs/provider-registry-refresh-overdue" \
  -H "X-Cron-Secret: $CRON_SECRET"
```

Expected result: JSON with `checked`, `overdue`, `thresholdDays`, and
`slackAlertSent`. If any active provider is older than the threshold, the ops
Slack payload includes one line per provider:

```text
Provider registry refresh overdue for <provider_name> - last verified <date>.
```

## Scheduler

Create a Cloud Scheduler job for overdue detection after staging validation:

| Job | Schedule | Target |
| --- | --- | --- |
| `provider-registry-refresh-overdue` | Weekly Monday 14:00 UTC | `POST /jobs/provider-registry-refresh-overdue` |

The quarterly Jira task remains the human control. The weekly Slack check is
the detective control for missed refreshes.

## Rollback

- Code rollback: revert the worker PR that added the overdue route/job.
- Database rollback: apply the rollback block from
  `0315_provider_registry_refresh_controls.sql`; this removes only the audit
  triggers and helper functions.
- Do not delete `audit_events` evidence rows produced before rollback.

## Done Criteria

- Confluence page published and linked from SCRUM-1933/SCRUM-1949.
- Quarterly Jira task template created.
- `provider_registry.updated` audit row verified after a staging registry
  update.
- Overdue Slack alert tested in staging.
- Migration ledger remains numeric and synchronized after human apply.
