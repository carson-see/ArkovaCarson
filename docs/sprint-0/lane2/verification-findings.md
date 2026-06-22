# Lane-2 Sprint-0 — Candidate-Finding Verification

> Read-only code-review pass. Each finding confirmed/refuted against the actual code at worktree tip (`12b6058c`).
> No code changed; no git/network/Supabase/MCP operations run. Evidence is `file:line` from `/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/wt-lane2-s0`.

## Verdict summary

| Finding | Verdict | Key evidence (`file:line`) | Severity | Fix location |
|---|---|---|---|---|
| **F1** API-key expiry ignored | **PARTIAL** | `supabase/migrations/0299_validate_api_key_rpc.sql:82`; `0302:65`; `0303:65`; edge unmitigated `services/edge/src/mcp-server.ts:781-808`; worker MITIGATED `services/worker/src/middleware/apiKeyAuth.ts:189`, `services/worker/src/api/v2/auth.ts:59` | High (edge path only) | Add `AND (ak.expires_at IS NULL OR ak.expires_at > now())` to the RPC lookup in `0299`/`0302`/`0303` (write a compensating `NNNN` migration) |
| **F2** secret-rotation reminder is dead | **CONFIRMED** | hardcode `services/worker/src/jobs/secret-rotation-reminder.ts:20-38`; orphaned entrypoint `:126`; no cron wiring (`services/worker/src/routes/cron.ts` has zero refs) | Med | Source real `lastRotatedAt` in `getSecretInventory()`; wire `runSecretRotationCheck()` into `services/worker/src/routes/cron.ts` |
| **F3** paid credit-pack grants no credits | **CONFIRMED** | router `services/worker/src/stripe/handlers.ts:858-861`; subscription-only handler `:192-254` (throws `:252`); pack checkout `services/worker/src/api/v1/credits.ts:138-147`; dev-only grant `:114-134` | High | Add a credit-pack branch to `handleCheckoutComplete()` (`services/worker/src/stripe/handlers.ts:192`) keyed on `metadata.pack_id`/`credits`, or a dedicated handler |
| **F4** `check_unified_credits` fail-open | **CONFIRMED** | `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql:1425-1428` (`RETURN QUERY SELECT 50, 0, 50, true;`) | High | Change the `IF NOT FOUND` default to fail-closed (`0,0,0,false`) in a compensating migration |
| **F5** 3-way ledger split | **CONFIRMED** | tables `…baseline…:7873` (`credits`), `:8473` (`org_credits`), `:9467` (`unified_credits`); reads/writes diverge — see detail | High | Architectural: converge on one ledger; out of Lane-2 patch scope — Jira story |
| **F6** API-credit pack pricing | **CONFIRMED** | `services/worker/src/api/v1/credits.ts:30-34` ($0.010→$0.003/credit); header `:1-8` (PAY-01) | Low (info) | N/A — confirms PAY-01 ≠ $1.25 anchoring credit |
| **F7** platform-admin RBAC drift | **CONFIRMED** | frontend hardcoded `src/lib/platform.ts:9-14`; worker DB-flag `services/worker/src/utils/platformAdmin.ts:22-31` | Med | Make frontend `isPlatformAdmin()` read `profiles.is_platform_admin` (`src/lib/platform.ts:12`) |

---

## F1 — `validate_api_key` ignores `expires_at` — **PARTIAL**

**SQL confirmed.** All three revisions of the RPC filter only on `key_hash` + `is_active`; none reference `expires_at`:

- `supabase/migrations/0299_validate_api_key_rpc.sql:82` — `WHERE ak.key_hash = v_hash AND ak.is_active = true`
- `supabase/migrations/0302_validate_api_key_rpc_hardening.sql:65` — same predicate
- `supabase/migrations/0303_validate_api_key_rpc_hardening.sql:65` — same predicate (current head per numbering)

**Upstream mitigation exists — but only on the worker path, NOT the edge path.** This is why the verdict is PARTIAL, not CONFIRMED:

- **Edge MCP server (UNMITIGATED):** `services/edge/src/mcp-server.ts:781-808` POSTs to `/rpc/validate_api_key` and trusts whatever the RPC returns (`if (data) return {...}`). No `expires_at` check anywhere in `validateApiKey()` or `validateAuth()` (`:754-813`). This is the real exposure: an expired-but-active key still authenticates to the MCP edge endpoint.
- **Worker REST API (MITIGATED):** the worker does NOT call the RPC. It queries `api_keys` directly and explicitly rejects expired keys:
  - `services/worker/src/middleware/apiKeyAuth.ts:167` selects `expires_at`; `:189` `if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date())` → 401 `api_key_expired`.
  - `services/worker/src/api/v2/auth.ts:44` + `:59` — identical guard.
  - Tests assert this: `services/worker/src/middleware/apiKeyAuth.test.ts:238` uses `expires_at: '2020-01-01...'`.

**Impact:** an expired API key continues to authenticate against the edge MCP surface (`edge.arkova.ai/mcp`) until someone flips `is_active=false`; the worker's own `/api/v1` + `/api/v2` surfaces are unaffected.
**Severity:** High (scoped to the edge MCP path).
**Fix location:** add `AND (ak.expires_at IS NULL OR ak.expires_at > now())` to the lookup in the RPC body (compensating `NNNN` migration; do not edit `0299`/`0302`/`0303`). Optionally also have `mcp-server.ts validateApiKey()` defense-check expiry, but the DB fix covers both callers.

---

## F2 — secret-rotation reminder never fires / not wired — **CONFIRMED**

**Hardcode confirmed.** `services/worker/src/jobs/secret-rotation-reminder.ts:20-38` — `getSecretInventory()` returns 15 secrets, each with `lastRotatedAt: new Date()` (current time at call). `checkRotationStatus()` (`:40-65`) computes `ageDays` from that value, so `ageDays` is always ~0 → never `>= ROTATION_WARNING_AGE_DAYS` (83) → `expiringSoon`/`overdue` always empty.

**No cron wiring confirmed.** `runSecretRotationCheck()` (`:126`) is the only intended entrypoint, and it has zero callers in production code:
- repo-wide grep for `runSecretRotationCheck` / `secret-rotation` / `secretRotation` outside its own file → no hits.
- `services/worker/src/routes/cron.ts` contains no rotation reference (its only `secret` matches are the unrelated `x-cron-secret` header auth at `:174,:179`).

**Impact:** the secret-rotation alerting feature is entirely dead — it will never warn on an overdue secret even if wired, and it is not wired to run anyway.
**Severity:** Med (operational/security-hygiene gap, not a live exploit).
**Fix location:** (1) source real rotation dates in `getSecretInventory()` (`secret-rotation-reminder.ts:20`); (2) register `runSecretRotationCheck()` on a cron route in `services/worker/src/routes/cron.ts`.

---

## F3 — paid credit-pack checkout grants no credits in prod — **CONFIRMED**

**Webhook routing.** `services/worker/src/stripe/handlers.ts:858-861` routes every `checkout.session.completed` to `handleCheckoutComplete()` — there is no separate branch for one-time payments.

**`handleCheckoutComplete()` is subscription-only.** `:192-254`:
- reads `session.metadata.{user_id, price_id, plan_id}` (`:197,:202,:211-212`);
- resolves a `plan` row (`:214-254`) and **throws** `Could not resolve plan from checkout session` (`:252`) when it can't (unless exactly one plan has a `stripe_price_id`, in which case it wrongly grants a subscription via the single-plan fallback `:246-249`);
- on success it only upserts `subscriptions` (`:259-270`), sets `profiles.subscription_tier` (`:277-288`), and verifies the org (`:309-355`). **No code reads `metadata.pack_id` / `metadata.credits` and no credit-grant call exists anywhere in the handler.**

**Credit-pack checkout sends pack metadata, not plan metadata.** `services/worker/src/api/v1/credits.ts:138-147` creates `createCheckoutSession({ mode: 'payment', priceId: 'price_credits_<pack>', metadata: { pack_id, credits, org_id } })` — no `plan_id`/`price_id`, and `price_credits_<pack>` won't match any `plans.stripe_price_id`. So a completed pack session lands in `handleCheckoutComplete()` and throws/no-ops without granting credits.

**Dev-mode is the only path that grants.** `credits.ts:114-134` grants directly via `deduct_unified_credits` (negative amount = grant) and is gated `config.nodeEnv !== 'production'` (`:114`). Production has no equivalent grant on webhook receipt.

**Impact:** in production, a customer who buys a credit pack is charged by Stripe but never receives credits (revenue captured, entitlement not delivered) — and the webhook may error-loop on the unresolved plan.
**Severity:** High (revenue/entitlement correctness).
**Fix location:** add a credit-pack branch — either in `handleCheckoutComplete()` (`services/worker/src/stripe/handlers.ts:192`) gated on `session.mode === 'payment'` / `metadata.pack_id`, or a dedicated handler in the router switch (`:858`). Should call the same grant RPC the dev path uses.

---

## F4 — `check_unified_credits` fail-open default — **CONFIRMED**

`supabase/migrations/00000000000000_baseline_at_main_HEAD.sql:1413-1447`. When no `unified_credits` row matches the org/user (`:1425 IF NOT FOUND`), the function returns:

```sql
-- line 1426
RETURN QUERY SELECT 50, 0, 50, true;
```

i.e. `monthly_allocation=50, used_this_month=0, remaining=50, has_credits=true` — exactly the fail-OPEN default the finding describes. The worker payment gate consumes this (`services/worker/src/middleware/paymentTierRouter.ts:72`, `services/worker/src/api/v1/credits.ts:58`).

**Impact:** any org/user with no `unified_credits` row is treated as having 50 spendable credits and `has_credits=true`, so credit gating passes for un-provisioned principals.
**Severity:** High (money-safety / entitlement bypass).
**Fix location:** change the `IF NOT FOUND` branch (`…baseline…:1425-1428`) to fail closed (`SELECT 0, 0, 0, false`) via a compensating migration. Note `unified_credits.monthly_allocation` also *defaults to 50* at the column level (`:9471`), so lazy-init semantics should be reviewed alongside the fix.

---

## F5 — credit ledger split across 3 tables — **CONFIRMED**

All three tables exist with **different schemas**, and reads/writes never touch the same table:

| Table | Def | Balance model | Touched by |
|---|---|---|---|
| `credits` | `…baseline…:7873-7885` | `balance`, `monthly_allocation`, `purchased`, `cycle_start/end` | **Frontend read** via `get_user_credits` (`…baseline…:4142`, `SELECT/INSERT credits` `:4157,:4179`); hook `src/hooks/useCredits.ts:35-36` |
| `unified_credits` | `…baseline…:9467-9478` | `monthly_allocation`, `used_this_month`, `carry_over`, `billing_cycle_start` (no `balance`/`purchased`) | **Worker read** `check_unified_credits` (`…baseline…:1413`); **write** `deduct_unified_credits` (`…baseline…:1988`) from `paymentTierRouter.ts:72`, `credits.ts:58,116` |
| `org_credits` | `…baseline…:8473-8485` | `balance`, `monthly_allocation`, `purchased`, `cycle_start/end` (keyed by `org_id` only) | **Worker write** `deduct_org_credit` (`…baseline…:1948`) via `services/worker/src/utils/orgCredits.ts:71` |

Three distinct balance representations, three RPCs, three consumer layers (frontend display vs. worker payment gate vs. worker anchor deduction) — a deduction on `org_credits`/`unified_credits` is invisible to the `credits` balance the frontend shows, and vice-versa. The divergence in the finding is real.

**Impact:** balances shown to users (`credits.balance`) can disagree with what actually gates anchoring (`unified_credits` / `org_credits`); no single source of truth for "credits remaining" — launch-critical per the fee/credit-ledger-integrity note.
**Severity:** High (data integrity, launch-critical).
**Fix location:** architectural — converge consumers on one ledger (or define an authoritative one + sync). Out of scope for a Lane-2 inline patch; should be a dedicated Jira story. NEEDS-PROD-CHECK only for *which* table currently holds live balances, not for the divergence itself (the divergence is proven from code).

---

## F6 — `CREDIT_PACKS` price API/verification credits at ~$0.003–$0.01 — **CONFIRMED**

`services/worker/src/api/v1/credits.ts:30-34`:

```ts
{ id: 'pack_1k',   credits: 1_000,     price_usd: 10   },  // $0.010 / credit
{ id: 'pack_10k',  credits: 10_000,    price_usd: 80   },  // $0.008 / credit
{ id: 'pack_100k', credits: 100_000,   price_usd: 500  },  // $0.005 / credit
{ id: 'pack_1m',   credits: 1_000_000, price_usd: 3000 },  // $0.003 / credit
```

Range $0.003–$0.010/credit, matching the finding. File header (`:1-8`) labels these "API Credit System — Prepaid Credit Packs (PAY-01 / SCRUM-442)" — i.e. API/verification credits, a different concept from the $1.25 instant-anchoring credit in the fee model.

**Impact:** none directly — this confirms the two "credit" concepts are distinct and must not be conflated in design/copy.
**Severity:** Low (informational).
**Fix location:** N/A.

---

## F7 — platform-admin RBAC drift (frontend email list vs. worker DB flag) — **CONFIRMED**

- **Frontend (hardcoded list):** `src/lib/platform.ts:9` — `export const PLATFORM_ADMIN_EMAILS = ['carson@arkova.ai', 'sarah@arkova.ai']`; `:12-14` `isPlatformAdmin(email)` returns `PLATFORM_ADMIN_EMAILS.includes(email)`.
- **Worker (DB flag):** `services/worker/src/utils/platformAdmin.ts:22-31` — `isPlatformAdmin(userId)` reads `profiles.is_platform_admin` and fails secure on null (`:30 return profile?.is_platform_admin === true`). The header (`:7,:19`) explicitly notes the hardcoded email fallback was *removed* server-side.

The two layers use different, independently-maintained sources of truth. A DB-promoted admin (worker grants access) is not recognized by the frontend; the frontend's two hardcoded emails are not necessarily flagged in `profiles`. Note the frontend list also uses `@arkova.ai` while the user identity is `@arkova.io` — a domain mismatch worth flagging during the fix.

**Impact:** admin authorization is inconsistent between UI and API — UI may hide/show admin affordances out of step with what the worker actually enforces; promotions require both a DB update *and* a code deploy to be coherent.
**Severity:** Med (RBAC consistency; worker is the enforcing layer so not a direct privilege escalation, but a correctness/maintenance hazard).
**Fix location:** `src/lib/platform.ts:12` — replace the hardcoded check with a `profiles.is_platform_admin` read (e.g. a Supabase query/hook), retiring `PLATFORM_ADMIN_EMAILS` (`:9`). Verify the `.ai`/`.io` domain too.

---

_Read-only verification only. No source files were modified; no git, gh, npm, test, Supabase, MCP, or network commands were run. The sole file written is this report._
