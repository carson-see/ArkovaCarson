# Testing Reference
_Extracted from CLAUDE.md Sections 11 — 2026-03-17_

## RLS Tests
```typescript
import { withUser, withAuth } from '../tests/rls/helpers';

it('blocks cross-tenant access', async () => {
  await withUser(userFromOrgA, async (client) => {
    const { data } = await client.from('anchors').select();
    expect(data).toEqual([]);
  });
});
```

## Worker Tests
```typescript
const mockPayment: IPaymentProvider = { createCheckout: vi.fn() };
const mockChain: IAnchorPublisher = {
  publishAnchor: vi.fn().mockResolvedValue({ txId: 'mock_tx' })
};
```

## Gherkin -> Test Mapping
- `Given` -> test setup / `beforeEach`
- `When` -> the action
- `Then` / `And` -> `expect()` assertions

## Demo Users (Seed Data)

| Email | Password | Role | Org |
|-------|----------|------|-----|
| admin_demo@arkova.local | demo_password_123 | ORG_ADMIN | Arkova |
| user_demo@arkova.local | demo_password_123 | INDIVIDUAL | None |
| beta_admin@betacorp.local | demo_password_123 | ORG_ADMIN | Beta Corp |

## Verification API Frozen Response Schema

```json
{
  "verified": true,
  "status": "ACTIVE | REVOKED | SUPERSEDED | EXPIRED",
  "issuer_name": "string",
  "recipient_identifier": "string (hashed, never raw PII)",
  "credential_type": "string",
  "issued_date": "string | null",
  "expiry_date": "string | null",
  "anchor_timestamp": "string",
  "bitcoin_block": "number | null",
  "network_receipt_id": "string | null",
  "merkle_proof_hash": "string | null",
  "record_uri": "https://app.arkova.io/verify/{public_id}",
  "jurisdiction": "string (omitted when null, not returned as null)"
}
```
