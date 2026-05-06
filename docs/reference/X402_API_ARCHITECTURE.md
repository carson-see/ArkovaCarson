# Arkova x402 + Verification API Architecture

> **Version:** 2026-03-26 | **Status:** Code complete, pending infrastructure provisioning

---

## Overview

Arkova's Verification API uses the **x402 payment protocol** to enable pay-per-call access to credential verification, compliance checks, and AI-powered search — all settled in USDC on Base L2. Users can choose between:

1. **API key + subscription** — Monthly plan with included credits
2. **x402 pay-per-call** — No account needed, pay per request with USDC

Both paths hit the same endpoints. The x402 gate is transparent: if a valid API key is present, the payment gate is bypassed.

---

## How x402 Works with Arkova

## API/MCP Launch Scope

API/MCP read-only launch surfaces use scoped API keys, not x402. The launch MCP surface is read-only by default, and REST v2 agent endpoints require scoped API keys. x402 enforcement remains mandatory for the paid API surfaces listed below.

| Endpoint | Payment scope | Runtime gate | Price source | Launch evidence |
|---|---|---|---|---|
| `/api/v1/verify` | Authenticated/non-GET verification calls | `x402PaymentGate('/api/v1/verify')` | `X402_PRICING['/api/v1/verify']` | Unpaid 402, paid settlement, replay, disabled flag tests |
| `/api/v1/verify/entity` | Entity verification | `x402PaymentGate('/api/v1/verify/entity')` | `X402_PRICING['/api/v1/verify/entity']` | Unpaid 402, paid settlement, replay, disabled flag tests |
| `/api/v1/compliance/check` | Compliance check | `x402PaymentGate('/api/v1/compliance/check')` | `X402_PRICING['/api/v1/compliance/check']` | Unpaid 402, paid settlement, replay, disabled flag tests |
| `/api/v1/regulatory/lookup` | Regulatory lookup | `x402PaymentGate('/api/v1/regulatory/lookup')` | `X402_PRICING['/api/v1/regulatory/lookup']` | Unpaid 402, paid settlement, replay, disabled flag tests |
| `/api/v1/cle` | CLE verification/records | `x402PaymentGate('/api/v1/cle')` | `X402_PRICING['/api/v1/cle']` | Unpaid 402, paid settlement, replay, disabled flag tests |
| `/api/v1/nessie/query` | Nessie RAG query | `x402PaymentGate('/api/v1/nessie/query')` | `X402_PRICING['/api/v1/nessie/query']` | Unpaid 402, paid settlement, replay, disabled flag tests |

Runtime prerequisites:

* `ENABLE_X402_PAYMENTS` switchboard flag controls whether payment-required responses are enforced.
* `X402_FACILITATOR_URL` points the worker at the facilitator.
* `ARKOVA_USDC_ADDRESS` is required; if missing while x402 is enabled, unauthenticated requests fail closed with 401.
* `X402_NETWORK` identifies Base Sepolia or Base mainnet.
* `BASE_RPC_URL` is required for on-chain verification when RPC validation is enabled.

### The Flow (Happy Path)

```
Agent/Client                    Arkova Worker                   Base L2
    |                               |                              |
    |  POST /api/v1/verify          |                              |
    |  (no API key, no payment)     |                              |
    |------------------------------>|                              |
    |                               |                              |
    |  402 Payment Required         |                              |
    |  { price: $0.002,             |                              |
    |    network: eip155:84532,     |                              |
    |    payTo: 0xARKOVA...,        |                              |
    |    token: USDC }              |                              |
    |<------------------------------|                              |
    |                               |                              |
    |  Transfer USDC on Base L2     |                              |
    |------------------------------------------------------------->|
    |                               |                              |
    |  POST /api/v1/verify          |                              |
    |  X-Payment: { txHash, ... }   |                              |
    |------------------------------>|                              |
    |                               |  eth_getTransactionReceipt   |
    |                               |----------------------------->|
    |                               |  Verify: confirmed, amount,  |
    |                               |  recipient match             |
    |                               |<-----------------------------|
    |                               |                              |
    |  200 OK (verification result) |                              |
    |<------------------------------|                              |
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Base L2** (not Ethereum mainnet) | Lower fees (~$0.001 vs ~$2), faster finality (~2s) |
| **USDC** (not ETH or USDT) | Stable price, Coinbase-backed, native Base support |
| **Self-hosted facilitator** | Privacy: no third-party sees payment data |
| **Post-execution recording** | Payment only charged if request succeeds (4xx = no charge) |
| **Cache + DB replay prevention** | In-memory cache (fast) + DB UNIQUE constraint (durable) |
| **1% amount tolerance** | Accounts for rounding in 6-decimal USDC |

---

## Endpoint Pricing

| Endpoint | Price (USDC) | Description |
|----------|-------------|-------------|
| `POST /api/v1/verify` | $0.002 | Single credential verification |
| `POST /api/v1/verify/entity` | $0.005 | Cross-record entity search |
| `POST /api/v1/compliance/check` | $0.010 | Regulatory compliance check |
| `POST /api/v1/regulatory/lookup` | $0.002 | Public regulatory record search |
| `POST /api/v1/cle` | $0.005 | CLE credit verification |
| `POST /api/v1/nessie/query` | $0.010 | AI-powered RAG query |

Anchoring uses dynamic pricing: base fee + estimated Bitcoin network fee.

---

## Security Controls

| Control | Implementation |
|---------|---------------|
| **RISK-2: On-chain validation** | TX receipt verified via BASE RPC — checks status, USDC Transfer event, amount, recipient |
| **RISK-3: Post-execution recording** | Payment logged AFTER handler success. 5xx = `refund_required` status |
| **RISK-4: Replay prevention** | In-memory cache (24h TTL, 10K entries) + DB UNIQUE on `tx_hash` |
| **Timestamp validation** | Payment proofs older than 5 minutes rejected |
| **Per-payer rate limit** | 1,000 req/min per wallet address |

---

## Architecture Components

### 1. Payment Gate Middleware (`x402PaymentGate.ts`)

Express middleware mounted on paid endpoints. Decision tree:

1. If `ENABLE_X402_PAYMENTS` flag is off → pass through (free access)
2. If valid API key present → bypass payment (subscription model)
3. If `X-Payment` header present → validate on-chain, proceed if valid
4. Otherwise → return 402 with payment requirements

### 2. Self-Hosted Facilitator (`edge/src/x402-facilitator.ts`)

Cloudflare Worker at `edge.arkova.ai/x402/verify`. Validates USDC transfers independently:

- Fetches TX receipt via JSON-RPC
- Decodes USDC Transfer event logs
- Verifies amount and recipient
- Returns signed attestation

### 3. Payment Logger (`x402PaymentLogger.ts`)

Records payments in both `x402_payments` and `billing_events` tables with idempotency keys to prevent double-recording.

### 4. Database Schema

```sql
-- Core payment records (service_role only, RLS enforced)
x402_payments (tx_hash UNIQUE, network, amount_usd, payer_address, ...)

-- Unified billing (Stripe + x402 + AI credits)
billing_events (event_type: 'x402_payment' | 'x402_refund' | ...)
unified_credits (subscription + x402 + AI credits ledger)
payment_ledger (view: union of all payment types)
```

---

## Deployment Plan

### Prerequisites

| Item | Status | Action Required |
|------|--------|-----------------|
| x402 middleware code | DONE | Tested, gated by feature flag |
| Self-hosted facilitator code | DONE | Edge worker written |
| Database schema (migrations 0078, 0100) | DONE | Applied to production |
| Payment analytics | DONE | Financial reports + ledger view |
| 29 unit + RLS tests | DONE | All passing |

### Steps to Go Live

#### Step 1: Provision USDC Wallet
- Create a Base L2 wallet for Arkova
- Fund with small amount of ETH for gas (if needed for any admin ops)
- Record the address as `ARKOVA_USDC_ADDRESS`

#### Step 2: Configure RPC Access
- Sign up for Base RPC provider (Alchemy, Infura, or Coinbase Cloud)
- Get RPC URL for Base Sepolia (testnet) and Base mainnet
- Set `BASE_RPC_URL` env var on Cloud Run worker

#### Step 3: Deploy Facilitator
```bash
cd services/edge
wrangler deploy
# Sets up edge.arkova.ai/x402/verify
```
- Set `BASE_RPC_URL` secret in Cloudflare Workers dashboard
- Set `USDC_CONTRACT_ADDRESS` if using mainnet USDC

#### Step 4: Configure Worker
Set these env vars on Cloud Run:
```
ARKOVA_USDC_ADDRESS=0x...     # From Step 1
X402_FACILITATOR_URL=https://edge.arkova.ai/x402/verify
X402_NETWORK=eip155:84532     # Base Sepolia (change to eip155:8453 for mainnet)
BASE_RPC_URL=https://...      # From Step 2
```

#### Step 5: Enable Flag
```sql
UPDATE switchboard_flags
SET is_enabled = true
WHERE flag_name = 'ENABLE_X402_PAYMENTS';
```

#### Step 6: Verify
1. Call `POST /api/v1/verify` without API key → expect 402
2. Make USDC payment on Base Sepolia
3. Retry with `X-Payment` header containing TX hash → expect 200
4. Check `x402_payments` table for recorded payment
5. Verify replay prevention: retry same TX hash → expect 409

### Testnet vs Mainnet

| Config | Testnet (current) | Mainnet |
|--------|-------------------|---------|
| `X402_NETWORK` | `eip155:84532` | `eip155:8453` |
| USDC Contract | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| RPC URL | Base Sepolia RPC | Base mainnet RPC |
| Faucet | bridge.base.org/deposit (Sepolia) | N/A |

---

## Verification API Summary

The Verification API (P4.5) is **100% complete** — 13/13 stories, 34 endpoints:

| Category | Endpoints | Auth |
|----------|-----------|------|
| Credential verification | `/verify`, `/verify/batch`, `/verify/search` | API key or x402 |
| Merkle proof | `/verify/:id/proof` | Public (no auth) |
| Entity verification | `/verify/entity` | x402 |
| Compliance | `/compliance/check` | x402 |
| Regulatory | `/regulatory/lookup` | x402 |
| CLE | `/cle/*` | x402 |
| AI extraction | `/ai/extract`, `/ai/extract-batch` | JWT |
| AI search | `/ai/search`, `/ai/embed` | JWT |
| AI fraud | `/ai/integrity`, `/ai/review`, `/ai/fraud/visual` | JWT |
| AI reports | `/ai/reports` | JWT |
| Nessie RAG | `/nessie/query` | x402 |
| Key management | `/keys` | JWT |
| Usage stats | `/usage` | API key |
| Webhooks | `/webhooks/*` | JWT |
| Attestations | `/attestations/*` | Mixed |
| Anchor submission | `/anchor` | API key |
| API docs | `/docs`, `/docs/spec.json` | Public |

**OpenAPI spec:** Available at `/api/docs/spec.json` (auto-generated).

---

## What's Left for Full API Go-Live

| Task | Effort | Blocker? |
|------|--------|----------|
| USDC wallet provisioning | 30 min | Yes — no payments without it |
| Base RPC setup | 15 min | Yes — can't validate on-chain |
| Edge worker deploy (`wrangler deploy`) | 10 min | Yes — facilitator needed |
| Set 4 env vars on Cloud Run | 5 min | Yes — config only |
| Enable `ENABLE_X402_PAYMENTS` flag | 1 min | No — can test first |
| Custom domain (`api.arkova.io`) | 30 min | No — works on current domain |
| Developer portal / onboarding UI | 2-4 hrs | No — API works without it |
| SDKs (TypeScript done, Python done) | Done | N/A |

**Total time to x402 go-live: ~1 hour of infrastructure work.**

---

_Document version: 2026-03-26_
