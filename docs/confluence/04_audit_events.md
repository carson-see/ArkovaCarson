# Audit Events

## Overview

The `audit_events` table provides an immutable, append-only audit trail for all significant actions in Arkova. This enables compliance, debugging, and security forensics.

## Design Principles

1. **Append-Only** - No UPDATE or DELETE operations allowed
2. **Comprehensive** - All significant actions logged
3. **Tenant-Scoped** - Events include org_id for filtering
4. **Actor Attribution** - Events track who performed the action

## Immutability Enforcement

The table uses triggers to reject modifications:

```sql
CREATE OR REPLACE FUNCTION reject_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are immutable. % operations are not allowed.', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reject_audit_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();

CREATE TRIGGER reject_audit_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_modification();
```

Even service_role cannot modify audit events (triggers run regardless of role).

## Event Categories

| Category | Description |
|----------|-------------|
| `AUTH` | Authentication events (login, logout, password change) |
| `ANCHOR` | Anchor lifecycle events (created, secured, revoked) |
| `PROFILE` | Profile changes |
| `ORG` | Organization changes |
| `ADMIN` | Administrative actions |
| `SYSTEM` | System events (migrations, maintenance) |

## Event Types

### AUTH Events
- `auth.login` - User logged in
- `auth.logout` - User logged out
- `auth.password_change` - Password changed
- `auth.password_reset` - Password reset requested

### ANCHOR Events
- `anchor.created` - New anchor created
- `anchor.secured` - Anchor confirmed on-chain
- `anchor.revoked` - Anchor revoked
- `anchor.deleted` - Anchor soft-deleted

### PROFILE Events
- `profile.created` - Profile created (after auth signup)
- `profile.updated` - Profile information changed
- `profile.role_assigned` - Role first assigned

### ORG Events
- `org.created` - Organization created
- `org.updated` - Organization details changed
- `org.member_added` - User added to organization
- `org.member_removed` - User removed from organization
- `ORG_VERIFIED_VIA_SUBSCRIPTION` - Organization verification_status set to VERIFIED on Stripe checkout completion (Session 23, PR #235)
- `ANCHOR_REVOKED` - Anchor revoked via `revoke_anchor` RPC. Details include: reason, filename, fingerprint, previous_status (Session 23 UAT verified)

### ADMIN Events
- `admin.user_suspended` - User account suspended
- `admin.user_reinstated` - User account reinstated
- `admin.legal_hold_set` - Legal hold applied to anchor
- `admin.legal_hold_removed` - Legal hold removed

## Schema

```sql
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_category text NOT NULL,
  actor_id uuid NULL,
  actor_email text NULL,
  actor_ip inet NULL,
  actor_user_agent text NULL,
  target_type text NULL,
  target_id uuid NULL,
  org_id uuid NULL,
  details text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## RLS Policies

Users can only read their own audit events:

```sql
CREATE POLICY audit_events_select_own ON audit_events
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid());
```

## Querying Audit Events

### Get user's recent events
```sql
SELECT * FROM audit_events
WHERE actor_id = auth.uid()
ORDER BY created_at DESC
LIMIT 100;
```

### Get anchor history (service role)
```sql
SELECT * FROM audit_events
WHERE target_type = 'anchor'
  AND target_id = 'anchor-uuid-here'
ORDER BY created_at;
```

### Get org activity (service role)
```sql
SELECT * FROM audit_events
WHERE org_id = 'org-uuid-here'
ORDER BY created_at DESC;
```

## Creating Audit Events

### From Application Code (TypeScript)
```typescript
import { supabase } from './supabase';

await supabase.from('audit_events').insert({
  event_type: 'anchor.created',
  event_category: 'ANCHOR',
  // actor_id set automatically via RLS
  target_type: 'anchor',
  target_id: anchorId,
  org_id: userOrgId,
  details: `Created anchor for ${filename}`,
});
```

### From Database Triggers (Deployed)

The immutability triggers (`reject_audit_update`, `reject_audit_delete`) are deployed via migration 0006. They use `reject_audit_modification()` which raises an exception on any UPDATE or DELETE attempt, regardless of role.

Migration 0017 also deploys `auto_create_anchoring_job()` — a trigger on `anchors` INSERT that demonstrates the trigger-based event tracking pattern (writes to `anchoring_jobs`, not `audit_events`).

Audit events themselves are created through application code (`src/lib/auditLog.ts`), not database triggers:

```typescript
// Example: Anchor creation audit (from ConfirmAnchorModal)
await supabase.from('audit_events').insert({
  event_type: 'anchor.created',
  event_category: 'ANCHOR',
  target_type: 'anchor',
  target_id: anchorId,
  org_id: userOrgId,
  details: `Created anchor for ${filename}`,
});
```

## Retention

Audit events are retained indefinitely by default. For compliance:

1. Events are timestamped with UTC timestamps
2. No automatic deletion
3. Legal hold on related anchors preserves event chain

## Export

For compliance reporting, export events:

```bash
# Export all events for an organization (admin only)
psql -c "COPY (SELECT * FROM audit_events WHERE org_id = 'uuid') TO STDOUT CSV HEADER"
```
