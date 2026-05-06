# Migration Audit — 2026-05-06

Status: in progress. This note captures the verified state from the
`/Volumes/Extreme/Arkova/arkova-mvpcopy-main` audit base at
`91a6d40a6910ce1cbe353344bcc0799ac795a251`.

## Executive Summary

The repo, GitHub `main`, and production Supabase are not fully aligned under
Arkova's strict migration rules.

The current GitHub migration drift workflow passes for `main` because it has a
historical exception list. Under the stricter rule that production ledger rows
must match the numeric repo migration number, there is active drift that must be
resolved before adding or applying new migrations.

## Verified Sync State

- External SSD `main` checkout is clean and matches GitHub `origin/main`.
- `/Users/carson/Arkova/arkova-mvpcopy-main` is on active branch
  `codex/api-mcp-readiness-evidence` with untracked PR #723 evidence files.
- Jira/Confluence could not be verified from this session: Jira MCP search
  fails at transport deserialization and direct Confluence fetch returns 401.

## Stop-Class Findings

### 1. Production Has Migrations That Are Not On `main`

Production Supabase ledger currently contains:

```text
0295            pr700_rls_baseline_reconciliation
20260506121949  0294_refund_org_credit
```

Those files are not present on GitHub `main`.

Ownership:

- `0295_pr700_rls_baseline_reconciliation.sql` is owned by another active
  session / PR #700. As of the latest refresh, production shows this as a
  numeric `0295` ledger row, not a timestamp row.
- `0294_refund_org_credit.sql` is owned by PR #721.

Action: do not run `migration repair`, do not run prod `db push`, and do not
apply more migrations until Carson/operator reconciles this ledger state.

### 2. Open PRs Collide On Migration Number `0294`

Open PRs currently own conflicting migration numbers:

```text
PR #721  0294_refund_org_credit.sql
PR #719  0294_org_queue_scheduler.sql
```

Action: one PR must renumber after coordination. Since production already has a
ledger row named `0294_refund_org_credit`, PR #719 is the likely one that must
move, but this needs owner/operator sign-off.

### 3. `main` Skips Migration Number `0291`

GitHub `main` currently has:

```text
0290_suborg_suspension_audit_and_service_role_fix.sql
0292_microsoft_graph_webhook_nonces.sql
0293_msgraph_nonce_payload_hash_and_compound_rpc.sql
```

There is no `0291_*.sql` on `main`.

Ownership note: another session is already handling the older `0292` / `0293`
header mismatch. Do not edit those files here unless ownership changes.

## Production Schema Findings

### RLS Coverage

No production public tables were found with RLS disabled, FORCE RLS disabled, or
zero policies.

### SCRUM-1285 Effects Are Not Fully Applied

Production still has these app-level overloaded functions:

```text
invite_member(text, user_role, uuid)
invite_member(uuid, text, text, uuid)
get_public_records_page(integer, integer, text, text, text)
get_public_records_page(integer, integer, text, text, text, text)
drain_submitted_to_secured_for_tx(4 args)
drain_submitted_to_secured_for_tx(6 args)
```

The SCRUM-1285 screenshot specifically mentioned dropping old overloads for
`invite_member` and `get_public_records_page`; those effects are not present.

Production `webhook_dead_letter_queue` has zero foreign key constraints. The
SCRUM-1285 screenshot mentioned adding FKs to `organizations(id)` and
`webhook_endpoints(id) ON DELETE CASCADE`; those effects are not present.

### Security Definer Search Path

Production has 22 `SECURITY DEFINER` functions whose `search_path` is not
exactly `public`. Most are `public, pg_temp` or `public, auth`; one is
`pg_catalog`.

Under the written rule "SET search_path = public", these are violations. They
may be historical or intentional, but they need an explicit decision rather
than silent acceptance.

### Security Invoker Views

Public views without `security_invoker=true`:

```text
hypopg_hidden_indexes
hypopg_list_indexes
v_slow_queries
```

The `hypopg_*` views appear extension-owned; `v_slow_queries` needs an explicit
decision or exception.

## Local Migration File Findings

Current `main` has 288 migration files.

Historical non-strict filenames:

```text
0055b_seed_alignment_idempotent.sql
0068a_add_submitted_enum.sql
0068b_submitted_status_and_confirmations.sql
0088b_cle_templates.sql
```

Historical duplicate prefixes still present:

```text
0055, 0068, 0088, 0174, 0175, 0176, 0180, 0236,
0258, 0262, 0265, 0273, 0274, 0278
```

These align with the user's warning that the older ledger is messy. They should
be treated as grandfathered/history unless Carson decides to run a larger
baseline reconciliation.

## Fixes Made In This Audit Branch

- `0290_suborg_suspension_audit_and_service_role_fix.sql`: changed the rollback
  heading from `-- ROLLBACK` to the required `-- ROLLBACK:` form.

## Do Not Touch Here

- `0295_pr700_rls_baseline_reconciliation.sql`: owned by another session.
- `0292_microsoft_graph_webhook_nonces.sql` and
  `0293_msgraph_nonce_payload_hash_and_compound_rpc.sql`: header mismatch owned
  by another session.
- `0294_refund_org_credit.sql`: PR #721 owned.
- `0294_org_queue_scheduler.sql`: PR #719 owned.
