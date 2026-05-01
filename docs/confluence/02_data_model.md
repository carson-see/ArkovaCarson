# 02 Data Model

This page tracks customer-facing schema contracts that need reviewer visibility when migrations change persistent data shapes.

## Webhook Public Identifiers

SCRUM-1445 adds stable public identifiers for outbound webhook infrastructure. The internal UUID columns remain in place for v1 compatibility, but new customer-facing routes should prefer the public IDs.

| Table | Column | Format | Generation |
|---|---|---|---|
| `webhook_endpoints` | `public_id` | `WHK-{org_prefix}-{unique_8}` | `BEFORE INSERT` trigger `public.set_webhook_endpoint_public_id()`; backfilled for existing rows. |
| `webhook_delivery_logs` | `public_id` | `DLV-{unique_12}` | Column default using `gen_random_uuid()`; backfilled for existing rows. |

Both columns are `NOT NULL` and uniquely indexed after backfill. The worker TypeScript database types include the new fields in `Row`, `Insert`, and `Update` shapes.

## Rollback Notes

If SCRUM-1445 must be rolled back before the v2 webhook route cutover, drop the endpoint trigger/function, remove the delivery-log default, then drop both public-id columns as documented in `supabase/migrations/0284_webhooks_public_id.sql`.
