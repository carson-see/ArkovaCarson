# Round-3 release prerequisite verification

Checked 2026-09-27, approximately 22:18–22:21 UTC. Read-only production checks; no deployment, migration application, secret access, traffic change or soak.

## Production Drive compatibility count

Project `vzwyaatejekddvltxyye` was identified through project discovery and the repository production migration-drift configuration. Information-schema inspection confirmed `public.organization_rules.trigger_config` is JSONB and `enabled` is boolean.

```sql
SELECT count(*) FILTER (WHERE enabled) AS enabled_folder_rules_missing_type,
       count(*) FILTER (WHERE NOT enabled) AS disabled_folder_rules_missing_type,
       count(*) AS all_folder_rules_missing_type
FROM public.organization_rules
WHERE trigger_config ? 'folder_id' AND NOT (trigger_config ? 'type');
```

Result: enabled **0**, disabled **0**, total **0**. No rows/configuration/customer identifiers were retrieved. No data correction is required for this exact legacy shape at this snapshot. Repeat before release because the database is mutable; this is not a census of every possible malformed configuration.

## Production recipient secret metadata

```bash
gcloud secrets versions describe 1 --secret=recipient-identifier-pepper \
  --project=arkova1 --format='value(state)'
```

Result: **ENABLED**. No secret payload was accessed. This proves the version exists and is enabled, not that a candidate runtime identity can access it. Repeat the metadata check and verify the approved service identity separately before execution. Never rotate this stable pepper or copy/compare its value to a public database setting.

## Review package and operating instructions

- Restored the actual historical `0494-agent-key-delete-lock-evidence.md` receipt and rechecked its migration and concurrency-harness hashes. Redacted the disposable local connection URL. Its old static policy scanner PASS did not cover the separate restrictive-MFA census; 0495 owns that correction.
- Runbook now names the full 0488 → 0489 → 0491 → 0492 → 0493 → 0494 → 0495 sequence, excludes another owner's 0490, and links the exact repository apply/reconciliation procedure. All retained migration prerequisites apply during rollback too.
- Baseline ComputeID stays false, matching the workflow. Positive ComputeID acceptance remains required in a separately authorized flag-on qualification; durable activation requires a reviewed authoritative workflow/configuration change. A baseline health pass cannot close that commitment.

Local round-3 source fixes, native verification, final combined tests and independent/external re-review are separate receipts and are not implied by these prerequisite checks. The release is not ready to soak merely because these two metadata checks passed.
