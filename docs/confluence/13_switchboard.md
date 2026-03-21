# Production Switchboard
_Last updated: 2026-03-21 | Story: P7-TS-01 (migration 0021), p_flag_key fix (2026-03-20)_

## Overview

The Arkova Switchboard provides server-side feature flags for controlling production behavior. All flags are enforced at the database level, with an automatic audit trail for all changes.

## Available Flags

Five flags are seeded in migration 0021 and re-seeded by `seed.sql`:

| Flag ID | Default | Description | Dangerous |
|---------|---------|-------------|-----------|
| `ENABLE_PROD_NETWORK_ANCHORING` | `false` | Enable production network anchoring (real network fees) | Yes |
| `ENABLE_OUTBOUND_WEBHOOKS` | `false` | Enable outbound webhook delivery | No |
| `ENABLE_NEW_CHECKOUTS` | `true` | Allow new checkout sessions | No |
| `ENABLE_REPORTS` | `true` | Enable report generation | No |
| `MAINTENANCE_MODE` | `false` | Put the app in maintenance mode | Yes |

> **Note:** CLAUDE.md Constitution 1.9 references `ENABLE_VERIFICATION_API` for the Phase 1.5 Verification API. This flag is **not yet in the database** — it will be added when P4.5 work begins. Until then, the flag does not exist in `switchboard_flags`.

## Database Schema (migration 0021)

### `switchboard_flags` Table

```sql
CREATE TABLE switchboard_flags (
  id text PRIMARY KEY,
  value boolean NOT NULL,
  description text,
  default_value boolean NOT NULL,
  is_dangerous boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES profiles(id)
);
```

RLS: Enabled and forced. Read-only for all authenticated users:

```sql
-- Everyone can read flags
CREATE POLICY switchboard_flags_read ON switchboard_flags
  FOR SELECT TO authenticated USING (true);

-- Only service_role can modify (no INSERT/UPDATE/DELETE policies for authenticated)
```

Grants: `GRANT SELECT ON switchboard_flags TO authenticated;`

### `switchboard_flag_history` Table

Audit trail for all flag changes:

```sql
CREATE TABLE switchboard_flag_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id text NOT NULL REFERENCES switchboard_flags(id),
  old_value boolean,
  new_value boolean NOT NULL,
  changed_by uuid REFERENCES profiles(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
```

RLS: Enabled and forced. Read-only for all authenticated users:

```sql
CREATE POLICY switchboard_flag_history_read ON switchboard_flag_history
  FOR SELECT TO authenticated USING (true);
```

Grants: `GRANT SELECT ON switchboard_flag_history TO authenticated;`

## Database Functions (migration 0021)

### `get_flag(p_flag_key text) RETURNS boolean`

Retrieves a flag's current value. Returns the default value if the flag does not exist.

```sql
CREATE OR REPLACE FUNCTION get_flag(p_flag_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
```

- SECURITY DEFINER with `SET search_path = public` (Constitution 1.4 compliant)
- Granted to `authenticated` and `anon`

### `log_switchboard_flag_change()` Trigger Function

Automatically logs flag changes to the history table:

```sql
CREATE TRIGGER log_flag_change
  BEFORE UPDATE ON switchboard_flags
  FOR EACH ROW
  WHEN (OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION log_switchboard_flag_change();
```

The trigger:
- Fires only when `value` actually changes
- Records `old_value`, `new_value`, `changed_by` (from `NEW.updated_by`), and `changed_at`
- Also updates `updated_at = now()` on the flag row

## Usage

### Server-Side (Worker)

```typescript
// Check a flag before performing an action
const { data: enabled } = await db.rpc('get_flag', {
  p_flag_key: 'ENABLE_PROD_NETWORK_ANCHORING'
});

if (!enabled) {
  logger.info('Production anchoring disabled');
  return;
}
```

### Client-Side

```typescript
import { getFlag, isProdAnchoringEnabled } from '@/lib/switchboard';

// Direct flag check
const enabled = await getFlag('ENABLE_NEW_CHECKOUTS');

// Convenience helpers
const prodEnabled = await isProdAnchoringEnabled();
const webhooksEnabled = await isOutboundWebhooksEnabled();
```

## Flag Enforcement

### Production Anchoring

The `ENABLE_PROD_NETWORK_ANCHORING` flag controls whether anchors are submitted to the production network:

1. Worker checks flag before submitting to chain
2. If `false`, uses test environment (mock or testnet)
3. If `true`, uses production network (mainnet)

**Warning**: Enabling this flag incurs real network fees.

### Outbound Webhooks

The `ENABLE_OUTBOUND_WEBHOOKS` flag controls webhook delivery:

1. Worker checks flag before dispatching events
2. If `false`, webhooks are logged but not delivered
3. If `true`, webhooks are delivered to configured endpoints

### Checkouts

The `ENABLE_NEW_CHECKOUTS` flag controls Stripe checkout:

1. Frontend checks flag before showing upgrade UI
2. Worker checks flag before creating checkout sessions
3. If `false`, existing subscriptions continue but no new purchases

### Maintenance Mode

The `MAINTENANCE_MODE` flag puts the app in read-only mode:

1. All write operations are blocked
2. Users see a maintenance message
3. Background jobs continue processing

## Changing Flags

### Via Service Role

```sql
-- Update a flag (requires service_role)
UPDATE switchboard_flags
SET value = true, updated_by = '<user_id>'
WHERE id = 'ENABLE_OUTBOUND_WEBHOOKS';
-- Trigger automatically logs to switchboard_flag_history
```

### Audit Trail

All flag changes are automatically logged via the `log_flag_change` trigger:

```sql
-- View flag history
SELECT * FROM switchboard_flag_history
WHERE flag_id = 'ENABLE_PROD_NETWORK_ANCHORING'
ORDER BY changed_at DESC;
```

## Seed Data

The 5 flags are seeded in both migration 0021 (initial insert) and `seed.sql` (re-inserted after TRUNCATE CASCADE during `supabase db reset`). Verification query:

```sql
SELECT id, value, is_dangerous FROM switchboard_flags ORDER BY id;
-- Expected: 5 rows
```

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| `switchboard_flags` table | **Complete** | Migration 0021 |
| `switchboard_flag_history` table | **Complete** | Migration 0021 |
| `get_flag()` RPC | **Complete** | Migration 0021, SECURITY DEFINER |
| `log_switchboard_flag_change()` trigger | **Complete** | Migration 0021, auto-logs changes |
| RLS policies (read-only for authenticated) | **Complete** | Migration 0021 |
| 5 initial flags seeded | **Complete** | Migration 0021 + seed.sql |
| Client-side `switchboard.ts` helpers | **Complete** | `src/lib/switchboard.ts` |
| `ENABLE_VERIFICATION_API` flag | **Not Started** | Referenced in Constitution 1.9, not yet in DB. Deferred to P4.5. |
| Admin UI for flag management | **Not Started** | Flags currently managed via SQL only |

## Security

1. **RLS Protection**: Only service_role can modify flags — no INSERT/UPDATE/DELETE policies for authenticated role
2. **Audit Trail**: All changes automatically logged with user ID via trigger
3. **Dangerous Flags**: `is_dangerous = true` marks flags that have financial or availability impact
4. **Default Values**: Fail-safe defaults — production features off by default
5. **SECURITY DEFINER**: `get_flag()` function follows Constitution 1.4 (`SET search_path = public`)

## Related Documentation

- [10_anchoring_worker.md](./10_anchoring_worker.md) — Anchoring worker (uses `ENABLE_PROD_NETWORK_ANCHORING`)
- [09_webhooks.md](./09_webhooks.md) — Outbound webhooks (uses `ENABLE_OUTBOUND_WEBHOOKS`)
- [08_payments_entitlements.md](./08_payments_entitlements.md) — Billing (uses `ENABLE_NEW_CHECKOUTS`)

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit session 3 | Added `_Last updated_` line. Added migration references throughout. Documented `get_flag()` function signature and `log_switchboard_flag_change()` trigger details from migration 0021. Added RLS policy details and grant statements. Noted `ENABLE_VERIFICATION_API` is referenced in Constitution 1.9 but not yet in database. Added seed data section, implementation status table, and change log. |
