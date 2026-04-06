# Agent Payment Tiers — Product Requirements
_Created: 2026-04-05 | Status: NOT STARTED_
_Epic: PAY (Agent Payment Infrastructure)_

---

## Overview

Three-tier payment architecture for agent-to-service micropayments:

1. **API Credit Prepayment** — agents buy credit packs, deduct per query (industry standard: OpenAI, Anthropic, Twilio)
2. **Stripe Usage-Based Billing** — metered billing for enterprise orgs deploying many agents
3. **x402 USDC on Base** — permissionless crypto payments for anonymous agents (existing, code-complete)

```
Agent hits /api/v1/verify
  |
  |-- Has API key with credit balance > 0?  --> Deduct credit, serve response
  |
  |-- Has API key linked to Stripe metered billing?  --> Report usage, serve response
  |
  |-- No API key?  --> Return 402, accept x402 USDC payment
```

## Stories

### PAY-01: API Credit System
**Priority:** P0 | **Effort:** Medium | **Depends on:** None

Add credit_balance to API keys. Purchase endpoint. Deduction in payment gate middleware.

**Acceptance Criteria:**
- [ ] `credit_balance` column on api_keys (or org-level credits table)
- [ ] `POST /api/v1/credits/purchase` — buy credit packs via Stripe Checkout
- [ ] Credit packs: 1K ($1.80), 10K ($16), 100K ($140), 1M ($1,200)
- [ ] `x402PaymentGate.ts` checks credit balance before falling through to x402
- [ ] `GET /api/v1/credits/balance` — check remaining credits
- [ ] Low-balance webhook when credits < 10% of last purchase
- [ ] Credits never expire

### PAY-02: Stripe Metered Billing
**Priority:** P1 | **Effort:** Medium | **Depends on:** PAY-01

Usage-based billing for enterprise accounts with monthly invoicing.

**Acceptance Criteria:**
- [ ] Stripe metered billing product created
- [ ] Usage reported via `stripe.subscriptionItems.createUsageRecord()` per API call
- [ ] Monthly invoice at end of billing cycle
- [ ] Usage dashboard shows daily/weekly/monthly consumption
- [ ] Enterprise tier: custom pricing via Stripe quotes

### PAY-03: Payment Tier Router
**Priority:** P0 | **Effort:** Small | **Depends on:** PAY-01

Modify x402PaymentGate to check credits first, then Stripe metered, then x402.

**Acceptance Criteria:**
- [ ] Three-tier fallthrough logic in middleware
- [ ] Credit deduction is atomic (no double-spend)
- [ ] Billing event logged for all three tiers
- [ ] Response includes `X-Payment-Method` header (credits/stripe/x402)

## Alternatives Evaluated

| Method | Score | Verdict |
|--------|-------|---------|
| API Credits | 9.5/10 | Implement (Tier 1) |
| Stripe Metered | 9.0/10 | Implement (Tier 2) |
| x402 USDC | 7.5/10 | Keep (Tier 3, existing) |
| Lightning L402 | 6.5/10 | Skip (liquidity management too complex) |
| Solana Pay | 6.0/10 | Skip (adds third chain) |
| Hedera | 5.0/10 | Skip (small ecosystem) |
| OAuth billing | 4.0/10 | Skip (overengineered) |
| Lit Protocol | 2.5/10 | Skip (poor DX) |

_Full research: agent payment research task output 2026-04-05_
