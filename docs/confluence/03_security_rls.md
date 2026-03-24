# Security & Row Level Security (RLS)
_Last updated: 2026-03-24 | Story: P1-TS-03 through P6-TS-06, migration 0107 (org RLS recursion fix)_

## Overview

Arkova enforces tenant isolation and least-privilege access at the database level using Postgres Row Level Security (RLS). Every table has RLS enabled and forced. This document catalogues every RLS policy, trigger guard, and grant across all 20 tables.

## Security Principles

1. **RLS Mandatory** — All tables have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`
2. **Least Privilege** — Public grants revoked on core tables (migration 0007); access only via `authenticated` role
3. **Role Immutability** — User roles cannot be changed after initial assignment (trigger `check_role_immutability`)
4. **Tenant Isolation** — Organizations isolated at database level via `get_user_org_id()` helper
5. **Append-Only Audit** — `audit_events` and `billing_events` cannot be modified or deleted (trigger `reject_audit_modification`)
6. **Service Role Separation** — `service_role` bypasses RLS for worker/admin operations; never exposed to client

## Helper Functions

Used by multiple RLS policies. Originally `SECURITY INVOKER` (migration 0009), upgraded to `SECURITY DEFINER` with `SET search_path = public` in migration 0038 to prevent RLS recursion.

| Function | Returns | Security | Defined In | Purpose |
|----------|---------|----------|------------|---------|
| `get_user_org_id()` | `uuid` | DEFINER (0038) | 0009, 0038 | Returns `profiles.org_id` for `auth.uid()` |
| `is_org_admin()` | `boolean` | DEFINER (0038) | 0009, 0038 | Returns true if caller has `ORG_ADMIN` role |
| `is_org_admin_of(uuid)` | `boolean` | DEFINER (0107) | 0087, 0107 | Returns true if caller is admin/owner of given org |
| `get_user_org_ids()` | `SETOF uuid` | DEFINER (0107) | 0087, 0107 | Returns all org_ids for caller via org_members |
| `get_flag(text)` | `boolean` | DEFINER | 0021, 0102 | Safe switchboard flag lookup with default (param renamed p_flag_key in 0102) |

> **Session 16 Fix (0107):** `is_org_admin_of()` and `get_user_org_ids()` were originally `SECURITY INVOKER` in migration 0087. This caused circular RLS when called from `organizations` policies that check `org_members` (which has its own self-referencing RLS). Migration 0107 changes both to `SECURITY DEFINER SET search_path = public`. This was the root cause of org settings silently failing to save.

## Access Control by Table

### profiles

**RLS enabled:** migration 0007 | **Policies:** migrations 0008, 0035

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `profiles_select_own` | SELECT | `auth.uid() = id` | 0008 |
| `profiles_select_org_members` | SELECT | `org_id IS NOT NULL AND org_id = get_user_org_id()` | 0035 |
| `profiles_update_own` | UPDATE | `auth.uid() = id` (USING + WITH CHECK) | 0008 |

No INSERT/DELETE policies. Profile creation handled by auth hooks/system.

**Trigger:** `protect_privileged_profile_fields()` (migrations 0008, 0035) — blocks authenticated users from modifying: `org_id`, `requires_manual_review`, `manual_review_reason`, `manual_review_completed_at`, `manual_review_completed_by`, `public_id`. Service role bypasses.

**Grants (0007):** `SELECT, INSERT, UPDATE` to authenticated; `ALL` to service_role.

### organizations

**RLS enabled:** migration 0007 | **Policies:** migration 0009

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `organizations_select_own` | SELECT | `id = get_user_org_id()` | 0009 |
| `organizations_update_admin` | UPDATE | `id = get_user_org_id() AND is_org_admin()` (USING + WITH CHECK) | 0009 |

No INSERT/DELETE policies. Organization creation handled by `update_profile_onboarding()` (SECURITY DEFINER).

**Grants (0007):** `SELECT, INSERT, UPDATE, DELETE` to authenticated; `ALL` to service_role.

### anchors

**RLS enabled:** migration 0007 | **Policies:** migration 0010

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `anchors_select_own` | SELECT | `user_id = auth.uid()` | 0010 |
| `anchors_select_org` | SELECT | `org_id = get_user_org_id() AND is_org_admin()` | 0010 |
| `anchors_insert_own` | INSERT | `user_id = auth.uid() AND status = 'PENDING' AND (org_id IS NULL OR org_id = get_user_org_id())` | 0010 |
| `anchors_update_own` | UPDATE | `user_id = auth.uid()` (USING + WITH CHECK) | 0010 |

No DELETE policy. Soft delete only via `deleted_at`.

**Trigger:** `protect_anchor_status_transition()` (migration 0010) — blocks authenticated users from: changing `user_id`, setting `status` to SECURED, modifying `chain_tx_id`/`chain_block_height`/`chain_timestamp`, modifying `legal_hold`. Service role bypasses.

**Grants (0007):** `SELECT, INSERT, UPDATE` to authenticated; `ALL` to service_role.

### audit_events

**RLS enabled:** migration 0007 | **Policies:** migration 0011

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `audit_events_select_own` | SELECT | `actor_id = auth.uid()` | 0011 |
| `audit_events_insert_own` | INSERT | `actor_id IS NULL OR actor_id = auth.uid()` | 0011 |

No UPDATE/DELETE policies. Blocked by `reject_audit_modification` trigger (migration 0006).

**Grants (0007):** `SELECT, INSERT` to authenticated; `ALL` to service_role.

### invitations

**RLS enabled:** migration 0013 | **Policies:** migration 0013

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `Org admins can view invitations` | SELECT | `org_id` matches caller's org where caller `role = 'ORG_ADMIN'` | 0013 |
| `Org admins can create invitations` | INSERT | Same condition | 0013 |

No UPDATE/DELETE policies. Managed by `invite_member()` SECURITY DEFINER function.

**Note:** No explicit GRANT statements in migration 0013. Table may rely on schema default privileges.

### plans

**RLS enabled:** migration 0016 | **Policies:** migration 0016

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `plans_read_active` | SELECT | `is_active = true` | 0016 |

No INSERT/UPDATE/DELETE policies. Plan management is service_role only.

**Grants (0016):** `SELECT` to authenticated; `ALL` to service_role.

### subscriptions

**RLS enabled:** migration 0016 | **Policies:** migration 0016

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `subscriptions_read_own` | SELECT | `user_id = auth.uid() OR org_id = get_user_org_id()` | 0016 |

No INSERT/UPDATE/DELETE policies. Subscription management is service_role only (via Stripe webhooks).

**Grants (0016):** `SELECT` to authenticated; `ALL` to service_role.

### entitlements

**RLS enabled:** migration 0016 | **Policies:** migration 0016

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `entitlements_read_own` | SELECT | `user_id = auth.uid() OR org_id = get_user_org_id()` | 0016 |

No INSERT/UPDATE/DELETE policies. Managed by service_role.

**Grants (0016):** `SELECT` to authenticated; `ALL` to service_role.

### billing_events

**RLS enabled:** migration 0016 | **Policies:** migration 0016

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `billing_events_read_own` | SELECT | `user_id = auth.uid() OR org_id = get_user_org_id()` | 0016 |

No INSERT/UPDATE/DELETE policies. Append-only: UPDATE and DELETE blocked by `reject_audit_modification` trigger (migration 0016 reuses the trigger from 0006).

**Grants (0016):** `SELECT` to authenticated; `ALL` to service_role.

### anchoring_jobs

**RLS enabled:** migration 0017 | **Policies:** none for authenticated

No RLS policies for authenticated users. This table is worker-only.

Access is via SECURITY DEFINER functions:
- `claim_anchoring_job(text, integer)` — atomic job claim with lock timeout
- `complete_anchoring_job(uuid, boolean, text)` — mark job completed/failed

Both functions have `SET search_path = public`.

**Grants (0017):** `ALL` to service_role; `EXECUTE` on both functions to service_role only.

### anchor_proofs

**RLS enabled:** migration 0017 | **Policies:** migration 0017

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `anchor_proofs_read_own` | SELECT | `anchor_id IN (SELECT id FROM anchors WHERE user_id = auth.uid() OR org_id = get_user_org_id())` | 0017 |

No INSERT/UPDATE/DELETE policies. Proof creation is service_role only (worker writes after chain confirmation).

**Grants (0017):** `SELECT` to authenticated; `ALL` to service_role.

### webhook_endpoints

**RLS enabled:** migration 0018 | **Policies:** migration 0018

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `webhook_endpoints_read_org` | SELECT | `org_id = get_user_org_id() AND is_org_admin()` | 0018 |
| `webhook_endpoints_insert_org` | INSERT | `org_id = get_user_org_id() AND is_org_admin()` | 0018 |
| `webhook_endpoints_update_org` | UPDATE | Same (USING + WITH CHECK) | 0018 |
| `webhook_endpoints_delete_org` | DELETE | `org_id = get_user_org_id() AND is_org_admin()` | 0018 |

Full CRUD restricted to ORG_ADMIN of the owning organization.

**Constraint:** `webhook_endpoints_url_valid CHECK (url ~ '^https://')` — HTTPS-only URLs.

**Grants (0018):** `SELECT, INSERT, UPDATE, DELETE` to authenticated; `ALL` to service_role.

### webhook_delivery_logs

**RLS enabled:** migration 0018 | **Policies:** migration 0018

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `webhook_delivery_logs_read_org` | SELECT | `endpoint_id IN (SELECT id FROM webhook_endpoints WHERE org_id = get_user_org_id()) AND is_org_admin()` | 0018 |

No INSERT/UPDATE/DELETE policies. Delivery logging is service_role only (worker writes on delivery attempt).

**Grants (0018):** `SELECT` to authenticated; `ALL` to service_role.

### reports

**RLS enabled:** migration 0019 | **Policies:** migration 0019

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `reports_read_own` | SELECT | `user_id = auth.uid() OR org_id = get_user_org_id()` | 0019 |
| `reports_insert_own` | INSERT | `user_id = auth.uid() AND (org_id IS NULL OR org_id = get_user_org_id())` | 0019 |

No UPDATE/DELETE policies. Report status updates are service_role only.

**Grants (0019):** `SELECT, INSERT` to authenticated; `ALL` to service_role.

### report_artifacts

**RLS enabled:** migration 0019 | **Policies:** migration 0019

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `report_artifacts_read_own` | SELECT | `report_id IN (SELECT id FROM reports WHERE user_id = auth.uid() OR org_id = get_user_org_id())` | 0019 |

No INSERT/UPDATE/DELETE policies. Artifact creation is service_role only.

**Grants (0019):** `SELECT` to authenticated; `ALL` to service_role.

### switchboard_flags

**RLS enabled:** migration 0021 | **Policies:** migration 0021

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `switchboard_flags_read` | SELECT | `true` (all authenticated users can read) | 0021 |

No INSERT/UPDATE/DELETE policies for authenticated. Flag modifications are service_role only.

**Trigger:** `log_switchboard_flag_change()` auto-logs value changes to `switchboard_flag_history`.

**Grants (0021):** `SELECT` to authenticated; `ALL` to service_role; `EXECUTE` on `get_flag(text)` to both.

### switchboard_flag_history

**RLS enabled:** migration 0021 | **Policies:** migration 0021

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `switchboard_flag_history_read` | SELECT | `true` (all authenticated users can read) | 0021 |

No INSERT/UPDATE/DELETE policies. History is auto-populated by trigger.

**Grants (0021):** `SELECT` to authenticated; `ALL` to service_role.

### memberships

**RLS enabled:** migration 0022 | **Policies:** migration 0022

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `memberships_select_own` | SELECT | `user_id = auth.uid()` | 0022 |
| `memberships_select_org` | SELECT | `org_id = get_user_org_id() AND is_org_admin()` | 0022 |

No INSERT/UPDATE/DELETE policies. Membership management is service_role only.

**Note:** No explicit GRANT statements in migration 0022. Table may rely on schema default privileges.

### credential_templates

**RLS enabled:** migration 0040 | **Policies:** migration 0040

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `credential_templates_select` | SELECT | `org_id` matches caller's `profiles.org_id` | 0040 |
| `credential_templates_insert` | INSERT | `org_id` matches caller's org AND caller `role = 'ORG_ADMIN'` AND `created_by` matches | 0040 |
| `credential_templates_update` | UPDATE | Same ORG_ADMIN check (USING + WITH CHECK) | 0040 |
| `credential_templates_delete` | DELETE | Same ORG_ADMIN check | 0040 |

**Note:** SELECT allows any org member to read templates; INSERT/UPDATE/DELETE restricted to ORG_ADMIN. No explicit GRANT statements in migration 0040.

### verification_events

**RLS enabled:** migration 0042 | **Policies:** migration 0042

| Policy | Operation | Condition | Migration |
|--------|-----------|-----------|-----------|
| `verification_events_org_admin_select` | SELECT | `org_id IS NOT NULL AND org_id` matches caller's org AND caller is `ORG_ADMIN` | 0042 |

No INSERT policy for authenticated. Events are inserted by the worker via service_role (SECURITY DEFINER RPC in migration 0045).

**Note:** No explicit GRANT statements in migration 0042.

## Role Immutability

Once a user's role is set (not NULL), it cannot be changed. Enforced by trigger `check_role_immutability` (migration 0005):

```sql
-- If OLD.role IS NOT NULL AND (NEW.role IS NULL OR NEW.role != OLD.role):
--   RAISE EXCEPTION 'Role cannot be changed once set'
-- If OLD.role IS NULL AND NEW.role IS NOT NULL:
--   NEW.role_set_at = now()
```

## Service Role

The `service_role` bypasses RLS for administrative operations:

- Seeding data
- Setting `anchor.status = 'SECURED'` (worker only)
- Creating anchoring jobs, proofs, billing events
- Modifying switchboard flags
- Webhook delivery logging

**Never expose service role key to the client.**

## SECURITY DEFINER Functions

All SECURITY DEFINER functions must include `SET search_path = public` per Constitution 1.4.

| Function | search_path | Migration | Note |
|----------|-------------|-----------|------|
| `get_user_org_id()` | Yes (0038) | 0009, 0038 | Fixed in 0038 |
| `is_org_admin()` | Yes (0038) | 0009, 0038 | Fixed in 0038 |
| `update_profile_onboarding()` | Yes | 0015 | |
| `claim_anchoring_job()` | Yes | 0017 | |
| `complete_anchoring_job()` | Yes | 0017 | |
| `get_flag()` | Yes | 0021 | |
| `invite_member()` | **No** | 0013 | Fixed in 0025 |
| `revoke_anchor()` | **Fixed** | 0012, 0024 | Fixed in 0024 |
| `bulk_create_anchors()` | **Fixed** | 0014, 0026 | Fixed in 0026 |
| `log_verification_event()` | Yes | 0045 | |

## Grant Summary

Grants are defined per-migration, not centrally. The base grants (migration 0007) cover the four core tables. Later migrations define their own grants.

### Core Tables (migration 0007)

```sql
REVOKE ALL ON organizations, profiles, anchors, audit_events FROM public;
GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON anchors TO authenticated;
GRANT SELECT, INSERT ON audit_events TO authenticated;
```

### Billing Tables (migration 0016)

```sql
GRANT SELECT ON plans, subscriptions, entitlements, billing_events TO authenticated;
GRANT ALL ON plans, subscriptions, entitlements, billing_events TO service_role;
```

### Worker Tables (migration 0017)

```sql
GRANT SELECT ON anchor_proofs TO authenticated;
GRANT ALL ON anchoring_jobs, anchor_proofs TO service_role;
```

### Webhook Tables (migration 0018)

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoints TO authenticated;
GRANT SELECT ON webhook_delivery_logs TO authenticated;
GRANT ALL ON webhook_endpoints, webhook_delivery_logs TO service_role;
```

### Report Tables (migration 0019)

```sql
GRANT SELECT, INSERT ON reports TO authenticated;
GRANT SELECT ON report_artifacts TO authenticated;
GRANT ALL ON reports, report_artifacts TO service_role;
```

### Switchboard Tables (migration 0021)

```sql
GRANT SELECT ON switchboard_flags, switchboard_flag_history TO authenticated;
GRANT ALL ON switchboard_flags, switchboard_flag_history TO service_role;
GRANT EXECUTE ON FUNCTION get_flag(text) TO authenticated, service_role;
```

### Tables Without Explicit Grants

The following tables were created after migration 0007 without explicit GRANT statements. They rely on schema default privileges:

- `invitations` (migration 0013)
- `memberships` (migration 0022)
- `credential_templates` (migration 0040)
- `verification_events` (migration 0042)

## Secrets Handling

1. **Never commit secrets** — `.env` files gitignored
2. **Use .env.example** — Placeholder values only
3. **CI blocks secrets** — TruffleHog and Gitleaks scanning
4. **Service key isolation** — Only used server-side (worker)

## Testing RLS

RLS tests in `tests/rls/` use helpers from `src/tests/rls/helpers.ts`:

```typescript
import { withUser, withAuth } from '../tests/rls/helpers';

it('blocks cross-tenant access', async () => {
  await withUser(userFromOrgA, async (client) => {
    const { data } = await client.from('anchors').select();
    expect(data).toEqual([]);
  });
});
```

Run tests:
```bash
npm run test:rls
```

## Implementation Status

| Table | RLS Enabled | FORCE RLS | Policies | Grants | Status |
|-------|-------------|-----------|----------|--------|--------|
| profiles | 0007 | 0007 | 0008, 0035 | 0007 | Complete |
| organizations | 0007 | 0007 | 0009 | 0007 | Complete |
| anchors | 0007 | 0007 | 0010 | 0007 | Complete |
| audit_events | 0007 | 0007 | 0011 | 0007 | Complete |
| invitations | 0013 | 0013 | 0013 | **Missing** | Partial |
| plans | 0016 | 0016 | 0016 | 0016 | Complete |
| subscriptions | 0016 | 0016 | 0016 | 0016 | Complete |
| entitlements | 0016 | 0016 | 0016 | 0016 | Complete |
| billing_events | 0016 | 0016 | 0016 | 0016 | Complete |
| anchoring_jobs | 0017 | 0017 | None (svc only) | 0017 | Complete |
| anchor_proofs | 0017 | 0017 | 0017 | 0017 | Complete |
| webhook_endpoints | 0018 | 0018 | 0018 | 0018 | Complete |
| webhook_delivery_logs | 0018 | 0018 | 0018 | 0018 | Complete |
| reports | 0019 | 0019 | 0019 | 0019 | Complete |
| report_artifacts | 0019 | 0019 | 0019 | 0019 | Complete |
| switchboard_flags | 0021 | 0021 | 0021 | 0021 | Complete |
| switchboard_flag_history | 0021 | 0021 | 0021 | 0021 | Complete |
| memberships | 0022 | 0022 | 0022 | **Missing** | Partial |
| credential_templates | 0040 | 0040 | 0040 | **Missing** | Partial |
| verification_events | 0042 | 0042 | 0042 | **Missing** | Partial |

**"Missing" grants** means no explicit `GRANT ... TO authenticated` in the migration. These tables rely on PostgreSQL schema default privileges, which may vary between local dev and production Supabase environments. Consider adding explicit grants in a future migration.

## Related Documentation

- [02_data_model.md](./02_data_model.md) — Table definitions and relationships
- [04_audit_events.md](./04_audit_events.md) — Audit trail design
- [12_identity_access.md](./12_identity_access.md) — Authentication and onboarding

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit session 3 | Full rewrite: expanded from 4 tables to all 20. Added policy details from migrations 0013-0042. Documented grants, triggers, SECURITY DEFINER functions, and implementation status. |
