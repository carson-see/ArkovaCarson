# Production Switchboard

## Overview

The Arkova Switchboard provides server-side feature flags for controlling production behavior. All flags are enforced at the database level, with an audit trail for all changes.

## Available Flags

| Flag ID | Default | Description | Dangerous |
|---------|---------|-------------|-----------|
| `ENABLE_PROD_NETWORK_ANCHORING` | `false` | Enable production network anchoring (real network fees) | Yes |
| `ENABLE_OUTBOUND_WEBHOOKS` | `false` | Enable outbound webhook delivery | No |
| `ENABLE_NEW_CHECKOUTS` | `true` | Allow new checkout sessions | No |
| `ENABLE_REPORTS` | `true` | Enable report generation | No |
| `MAINTENANCE_MODE` | `false` | Put the app in maintenance mode | Yes |

## Database Schema

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

### `switchboard_flag_history` Table

Audit trail for all flag changes:

```sql
CREATE TABLE switchboard_flag_history (
  id uuid PRIMARY KEY,
  flag_id text NOT NULL REFERENCES switchboard_flags(id),
  old_value boolean,
  new_value boolean NOT NULL,
  changed_by uuid REFERENCES profiles(id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
```

## Usage

### Server-Side (Worker)

```typescript
// Check a flag before performing an action
const { data: enabled } = await db.rpc('get_flag', {
  p_flag_id: 'ENABLE_PROD_NETWORK_ANCHORING'
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
```

### Audit Trail

All flag changes are automatically logged:

```sql
-- View flag history
SELECT * FROM switchboard_flag_history
WHERE flag_id = 'ENABLE_PROD_NETWORK_ANCHORING'
ORDER BY changed_at DESC;
```

## Testing

### CI Tests

```typescript
describe('Switchboard', () => {
  it('blocks anchoring when flag is disabled', async () => {
    // Set flag to false
    await serviceDb.from('switchboard_flags')
      .update({ value: false })
      .eq('id', 'ENABLE_PROD_NETWORK_ANCHORING');

    // Attempt anchoring
    const result = await worker.processAnchor(anchorId);

    // Should use mock/testnet
    expect(result.network).toBe('test');
  });

  it('blocks webhooks when flag is disabled', async () => {
    // Set flag to false
    await serviceDb.from('switchboard_flags')
      .update({ value: false })
      .eq('id', 'ENABLE_OUTBOUND_WEBHOOKS');

    // Dispatch event
    await dispatchWebhookEvent(orgId, 'anchor.secured', eventId, data);

    // Check no delivery attempted
    const logs = await db.from('webhook_delivery_logs').select();
    expect(logs.data).toHaveLength(0);
  });
});
```

## Security

1. **RLS Protection**: Only service_role can modify flags
2. **Audit Trail**: All changes are logged with user ID
3. **Dangerous Flags**: Marked flags require extra caution
4. **Default Values**: Fail-safe defaults (production features off)

## Related Documentation

- [10_anchoring_worker.md](./10_anchoring_worker.md) - Anchoring worker
- [09_webhooks.md](./09_webhooks.md) - Outbound webhooks
- [08_payments_entitlements.md](./08_payments_entitlements.md) - Billing
