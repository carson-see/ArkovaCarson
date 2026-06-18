# Lane 1 — Visibility Signal Inventory (input + review for Lane 2's S0-5.1 spec)

> **Sprint-0 Lane-1 SUPPORT deliverable.** Lane 2 OWNS the internal-visibility dashboard spec (Story S0-5.1); Lane 1's **Bitcoin Dev** is a named reviewer (AC: "DBA + Bitcoin Dev review"). This is (a) the chain/proof-side signal inventory Lane 2 folds into VIS-01, and (b) the threshold source for my own S0-5.2 drift/parity gate (bidirectional handoff). Status: DRAFT — full spec authorship remains Lane 2's.

The spec must surface three signals **admin-only, read-only** (implementation = Sprint 1 VIS-01/KEY-EXPIRY). Lane 1 owns the chain/proof slice of each:

## 1. DOUBLE_BILLING_RISK (money-safety, R-9)

| Signal | Source | Note |
|---|---|---|
| Charge-without-anchor / anchor-without-charge | `org_credit_deductions` (append-only ledger; Train D QUEUE-03/04 SCRUM-2349/2350) ⨯ `anchors` | The atomic `debit_and_enqueue_anchor` RPC is the guard; the dashboard counts mismatches. |
| Duplicate broadcast / double fee-spend | `isDuplicateTxError` paths in `utxo-provider.ts` | A retry that re-broadcasts must not double-charge fees. |
| Instant-Secure double-charge | Train D queue/credit RPC | DOUBLE_BILLING_RISK alarm (VIS-01, S3) gates Instant Secure GA. |

## 2. Fail-open flag states (R-5)

| Signal | Source | Note |
|---|---|---|
| `ENABLE_PROD_NETWORK_ANCHORING`, `ENABLE_AI_FRAUD`, `ENABLE_SEMANTIC_SEARCH` env⊕DB divergence | `flagRegistry.ts` (env list) vs `switchboard_flags` (DB) | 2026-05-30 finding: flags OFF in DB but ON in Cloud Run env → a transient Supabase read trips the env fallback and silently re-enables. **Divergence = the fail-open signal.** |
| `BITCOIN_UTXO_PROVIDER` fallback rate | `emitRpcFallback` counter (SCRUM-1254) | **100% fallback = the chain fail-open signal** (mempool.space SPOF). See chain-resilience pre-design. |

## 3. Key / secret expiries (KEY-EXPIRY, Q1.4)

| Secret | Clock | Owner |
|---|---|---|
| **CE trial API key** | **~Sept 2026** (hard PI-1 clock) | L3 — T-30 alarm is the headline |
| `PROOF_SIGNING_KEY_ID` / `PROOF_SIGNING_KMS_KEY` (Ed25519) | rotation policy | L1 |
| WIF treasury signer / GetBlock RPC creds | rotation policy | L1 (Secret-Manager hardening) |
| `API_KEY_HMAC_SECRET` | rotation policy | L2 |

## Lane-1 review note (Bitcoin Dev, for the S0-5.1 AC)

- **Reuse, don't reinvent collection:** chain signals already exist in `emitRpcFallback` + `db-health-monitor` (SCRUM-1254) + (incoming) the S0-5.2 drift gate. The spec should *read* these, not add new collection paths.
- **Admin-only + read-only** (treasury/USD aggregates are platform-admin per the 2026-04-21 decision); no PII; Sentry scrubbing applies.
- **Threshold handoff to S0-5.2:** the three signals above are exactly the asserted-vs-running dimensions my drift/parity gate checks — flag env⊕DB divergence, provider drift (100% fallback), and CSP allowlist drift. The VIS-01 thresholds and the drift-gate thresholds should share one definition.
- **Ready to formally review** Lane 2's S0-5.1 spec when published; this inventory is the Lane-1 contribution to it.
