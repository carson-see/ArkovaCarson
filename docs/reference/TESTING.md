# Testing Reference
_Last updated: 2026-04-08 | Session 32_

> Full details: [docs/confluence/18_testing_quality_standards.md](../confluence/18_testing_quality_standards.md)

## TDD Enforcement

TDD is **not optional**. Enforced at two gates:

1. **Pre-commit hook** — blocks `git commit` if production files changed without test files
2. **CI gate** (`tdd-enforcement` job) — blocks merge to main/develop

Setup for new developers:
```bash
git config core.hooksPath .githooks
```

Emergency skip (visible in git log):
```bash
SKIP_TDD_CHECK=1 git commit -m "fix: emergency hotfix"
```

---

## Custom ESLint Rules (`eslint-plugin-arkova`)

Three rules enforce test quality. Run automatically via `npm run lint`.

| Rule | Severity | What It Catches |
|------|----------|----------------|
| `arkova/no-unscoped-service-test` | warn | Tests mock `supabase.from()` but never assert `user_id`/`org_id` scoping |
| `arkova/require-error-code-assertion` | warn | Error tests check "it failed" without asserting the specific error code/status |
| `arkova/no-mock-echo` | warn | Tests assert the exact literal values they put into the mock (proves nothing) |

Suppress with `// eslint-disable-next-line arkova/rule-name` (must justify in comment).

---

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
| admin@umich-demo.arkova.io | Demo1234! | ORG_ADMIN | UMich Registrar |
| registrar@umich-demo.arkova.io | Demo1234! | ORG_MEMBER | UMich Registrar |
| admin@midwest-medical.arkova.io | Demo1234! | ORG_ADMIN | Midwest Medical Board |
| individual@demo.arkova.io | Demo1234! | INDIVIDUAL | None |

## Coverage Thresholds

80% on critical paths: `fileHasher.ts`, `validators.ts`, `proofPackage.ts`, `chain/`, `webhooks/`, `stripe/`.

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
