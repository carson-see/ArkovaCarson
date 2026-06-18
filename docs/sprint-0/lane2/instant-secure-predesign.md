# Instant-Secure — Pre-Design (Lane-2 product side) → S6 flag flip

> **Lane:** L2 — Product & Growth. **Deliverable:** L2-D (Instant-Secure pre-design, Lane-2 product/UX/flag side). **Sprint:** PI-1 Sprint 0 (Foundation & Hardening). **Date:** 2026-06-18.
> **Owner persona:** Architect + Senior Full-stack. **Status:** DRAFT. **Tier:** T0 (design-only — no running-surface change, no code lands this sprint).
> **Critical-path slot (PI-1 Master §6):** `L1 chain RPC (S4) → L1 T3 soak crash/double-charge/reorg (S5) → **L2 UX + flag flip (S6)** → GA polish (S7)`. **Gated by** L2's `DOUBLE_BILLING_RISK` alarm (VIS-01, S3).
> **Objective O3 framing:** Instant Secure GA must be **proven on an isolated T3 soak (crash / double-charge / reorg), OR remain flag-OFF with evidence.** This pre-design's job is to make S6 *code, not scope*, and to make the O3 decision a clean go/no-go for Carson — not to ship the path or assert it is live.

### Scope boundary (read first)

This document designs **only the product / UX / feature-flag side** of user-initiated Instant Secure: the upload-time choice, the credit pre-check, the success/failure states, the fail-CLOSED behavior, and the gating flag. **The chain-side atomic debit+anchor RPC is Lane-1's (S4)** — `debit_and_enqueue_anchor`, migration **0341**, currently on the Train D foundation branch and **NOT yet on `main`** (HANDOFF.md 2026-06-15, lines 65–66). It is treated here as an **INCOMING dependency**, never as existing prod state. Reorg → proof-invalidation is Lane-1 (S3/S5) and is referenced as a dependency only — **no chain/proof internals are designed here.**

### Claims-review note (what is asserted vs. NOT asserted)

- **NOT asserted:** that `debit_and_enqueue_anchor` (0341) is on `main` or in prod; that `ENABLE_INSTANT_SECURE` exists (it is **proposed** here); that any Instant-Secure user-initiated path is live; that the `DOUBLE_BILLING_RISK` alarm is deployed (it is the parallel S0-5.1 spec's Sprint-1 output). All of these are flagged INCOMING / PROPOSED.
- **Asserted (verified by reading the worktree this session):** the surfaces this design reuses exist on the checked-out tree — `checkPaymentGuard` (`services/worker/src/billing/paymentGuard.ts`), `deduct_org_credit` + `org_credit_deductions` (`supabase/migrations/0326_scrum1649_deduct_org_credit_idempotency.sql`), the FAST_TRACK_ANCHOR rule-action path (`services/worker/src/jobs/rule-action-dispatcher.ts`), the flag registry (`services/worker/src/middleware/flagRegistry.ts`), the upload entry (`src/components/anchor/FileUpload.tsx`), `useCredits()` (`src/hooks/useCredits.ts`), and the copy registry (`src/lib/copy.ts`).
- **Prod-state caveat (CLAUDE.md §"assert prod state directly"):** HANDOFF.md 2026-06-16 records prod `org_credit_deductions` as empty (0 rows) and `enableOrgCreditEnforcement` default false. This pre-design does **not** re-query prod; any S6 build must re-verify prod flag/ledger state in-session before flipping anything.

---

## 1. Product definition — Instant Secure vs. nightly batch

Arkova secures (anchors) a document by writing its fingerprint to the production network. There are two service levels for *when* that happens:

| | **Nightly batch (default)** | **Instant Secure (this design)** |
|---|---|---|
| **When** | Swept by the 3am batch drain (`processBatchAnchors`, `services/worker/src/jobs/batch-anchor.js`; manual force path `POST /api/queue/run` → `processBatchAnchors({ force: true, orgId })` in `services/worker/src/api/queue-resolution.ts`). | Immediately on submit. |
| **Economics** | Cheap: ~10k docs share one network receipt (Merkle batch). Covered by the subscription; **no per-document fee**. | Funded per-document by the **monthly credit allotment** first, then **paid credits ($1.25 each)**. |
| **Funding primitive** | Subscription / payment guard only (`checkPaymentGuard`). | Payment guard **+ credit debit** (`deduct_org_credit` today; atomic `debit_and_enqueue_anchor` once 0341 lands). |
| **Risk class** | Standard worker path. | **Money path → fail-CLOSED.** A bug double-charges a customer or charges-without-securing. |
| **Status copy** | `PENDING` → "Your record is being secured. This typically completes within a few minutes." (`copy.ts ANCHOR_STATUS_DESCRIPTIONS`) | Same status vocabulary; the difference is latency + the credit cost shown up front. |

**Precedent already in the codebase — do not invent a parallel path.** A machine-initiated Instant Secure already exists: the rules engine's **`FAST_TRACK_ANCHOR`** action (`services/worker/src/jobs/rule-action-dispatcher.ts:540` — *"FAST_TRACK_ANCHOR (DS-06, instant secure)"*). When an org rule matches, the dispatcher debits org credit (keyed by the rule-execution id) and submits an `anchor.fast_track` job. **L2-D is the *user-initiated* sibling of that path** — the same money-safety primitives, surfaced as an explicit upload-time choice instead of a rule side-effect. The S6 work is to expose this safely in the UI behind the gate; the chain-side atomicity it should ride on is Lane-1's 0341 RPC.

**When a user chooses Instant Secure.** Time-sensitive documents where "secured within minutes, provable now" matters (e.g. a credential a recipient must verify today) — versus the default where "secured by tomorrow morning" is fine. The choice is per-submission, defaults to **batch** (the cheap path), and is only offered when the flag is ON **and** the org has sufficient credits (see §3).

---

## 2. Where it surfaces — entry points (real components)

The single-document secure flow funnels through `FileUpload` (`src/components/anchor/FileUpload.tsx`) into the secure dialog, whose copy lives in `SECURE_DIALOG_LABELS` (`src/lib/copy.ts:643`). Bulk/CSV flows go through `src/components/upload/BulkUploadWizard.tsx` / `CSVUploadWizard.tsx`. Credit state is already available client-side via `useCredits()` (`src/hooks/useCredits.ts`), which returns `{ balance, monthly_allocation, purchased, plan_name, cycle_start, cycle_end, is_low }` from the `get_user_credits` RPC, and is already rendered by `src/components/dashboard/CreditUsageWidget.tsx`.

**Surface plan (Sprint-1/S6 scope, not built here):**

- **Single doc:** add a service-level selector to the secure dialog (after fingerprinting, before "Secure Document"). Two options: **Secure tonight (included)** [default] and **Secure now (1 credit)**. The "Secure now" option is hidden entirely when the flag is OFF, so OFF-state UX is byte-identical to today.
- **Bulk:** Instant Secure for bulk is **deferred past S6** (cost + atomicity surface multiply across N docs). S6 ships single-document only; bulk stays batch-only. Flagged as an open question (§8, Q4).
- **Copy:** all new strings land in `src/lib/copy.ts` (terminology gate §1.3). Proposed keys under a new `INSTANT_SECURE_LABELS` block — see §3.4. **No banned terms** (no Wallet/Transaction/Hash/Bitcoin/Broadcast); use Secure / Secured / record / credit / Anchor Receipt.

---

## 3. UX flow — the instant-vs-batch choice

### 3.1 Happy path (flag ON, credits sufficient)

1. User drops a document → `FileUpload` fingerprints it **on-device** (`generateFingerprint`, unchanged; §1.6 client-side boundary intact — Instant Secure changes *scheduling + funding*, never the fingerprinting boundary).
2. Secure dialog shows the document + a **service-level selector**:
   - ◉ **Secure tonight — included** (default; the batch path, no credit cost)
   - ○ **Secure now — 1 credit** (shown only if flag ON; disabled with a reason if credits insufficient — see 3.3)
3. If the user picks **Secure now**, the dialog shows a one-line cost preview from `useCredits()`: *"Uses 1 credit. You have N remaining this cycle."*
4. User confirms → request goes to the Instant-Secure endpoint (S4 owns the chain-side RPC; S6 owns this thin product endpoint + UI).
5. **Server, in one atomic step (Lane-1 0341 `debit_and_enqueue_anchor`):** debit 1 credit **and** enqueue the immediate anchor in the same DB transaction. Either both happen or neither does.
6. On success: status → `PENDING` with the existing "being secured… completes within a few minutes" copy, and a credit-balance refresh (`useCredits().refresh()`). The user sees the Anchor Receipt / verification link when the network confirms, identical to the batch path's terminal state.

### 3.2 Fail-CLOSED principle (the load-bearing rule)

> **If atomicity or funding cannot be guaranteed, do NOT anchor AND do NOT charge.** Never charge-without-securing; never secure-without-charging; never double-charge on retry.

This mirrors the existing dispatcher contract ("AUTO_ANCHOR / FAST_TRACK_ANCHOR / unknown → fail-closed visible failure", `rule-action-dispatcher.ts:12`). The UI must surface a *visible* failure, never a silent success.

### 3.3 Failure / edge states (what the user sees)

| State | Trigger | UX | Money outcome |
|---|---|---|---|
| **Flag OFF** | `ENABLE_INSTANT_SECURE` resolves false (default) | "Secure now" option is **not rendered**. Only the batch path exists. | None. |
| **Insufficient credits** | `useCredits().balance < cost` (pre-check) | "Secure now" is **disabled** with helper text: *"Not enough credits. Add credits or secure tonight (included)."* + link to credit purchase. Batch remains one click. | None — never reaches the server debit. |
| **Pre-check race (balance changed)** | Client thought there were credits; server debit returns `insufficient_credits` | Inline error: *"Not enough credits to secure now. Your document was **not** secured and you were **not** charged. Secure tonight instead?"* | **No debit** (RPC checks balance under `FOR UPDATE`; see §5). |
| **Atomic enqueue fails / worker crash mid-call** | DB error, timeout, crash between request and commit | Inline error: *"Couldn't secure your document right now. You were **not** charged. Please try again or secure tonight."* Retry is **idempotent** (§5). | **No partial charge** — the debit+enqueue is one transaction (0341). |
| **Idempotent retry (already succeeded)** | User retries after a success that the client didn't see | Treated as success; **no second charge** (idempotency key, §5). Shows the existing PENDING/secured state. | **Charged exactly once.** |
| **Network anchoring disabled** | `ENABLE_PROD_NETWORK_ANCHORING` off (separate existing gate) | "Secure now" unavailable (same as batch real-anchoring being off). | None. |
| **Reorg after secure** | Network reorg invalidates an already-charged anchor | **Lane-1 owns** the proof-invalidation + refund decision (S3/S5). L2 surfaces the resulting status (e.g. a re-secure / refunded state) using existing lifecycle copy. **Not designed here.** | Per Lane-1 reorg policy (refund expected; see §5/§8 Q3). |

### 3.4 Proposed copy (lands in `src/lib/copy.ts` at S6 — terminology-gate clean)

```
export const INSTANT_SECURE_LABELS = {
  CHOICE_TITLE: 'When should we secure this?',
  OPTION_BATCH: 'Secure tonight — included',
  OPTION_BATCH_HINT: 'Secured with your nightly batch. No credits used.',
  OPTION_INSTANT: 'Secure now — 1 credit',
  OPTION_INSTANT_HINT: 'Secured immediately. Uses 1 credit from your plan.',
  COST_PREVIEW: 'Uses 1 credit. You have {n} remaining this cycle.',
  INSUFFICIENT: 'Not enough credits. Add credits or secure tonight (included).',
  NOT_CHARGED_FAILURE: 'Couldn’t secure your document right now. You were not charged. Please try again or secure tonight.',
  NOT_CHARGED_INSUFFICIENT: 'Not enough credits to secure now. Your document was not secured and you were not charged.',
} as const;
```
(Final wording is Sprint-1; the gate is `npm run lint:copy`. No banned terms; "credit" is allowed, "Anchor Receipt" is the receipt term.)

---

## 4. The feature flag — `ENABLE_INSTANT_SECURE` (PROPOSED)

**Name:** `ENABLE_INSTANT_SECURE` — proposed; does not exist today. **Default: OFF. Fail-closed.**

**Pattern (follow the existing registry, do not invent a new mechanism).** `services/worker/src/middleware/flagRegistry.ts` already supports two flag kinds:

- **Env-backed** (process-level controls, listed in `ENV_FLAG_GETTERS`, sourced from `config.ts` — e.g. `ENABLE_PROD_NETWORK_ANCHORING` `boolFlag(false)` at `config.ts:101`, `ENABLE_ORG_CREDIT_ENFORCEMENT` `boolFlag(false)` at `config.ts:110`).
- **DB-backed** (switchboard rollout controls, listed in `DB_FLAGS`, read from `switchboard_flags(flag_key, enabled)` with an **env-var fallback**).

**Recommendation: register `ENABLE_INSTANT_SECURE` as a DB-backed switchboard flag** (add to `DB_FLAGS`), for two reasons: (a) it is a *rollout* control, not a process control — Carson will want to flip it per the O3 decision without a redeploy; (b) the DB path already has the env fallback baked in, so an unset DB row degrades to the env var, and an unknown flag degrades to **false** (`getFlag` returns false for any unregistered/missing flag, `flagRegistry.ts:151-155`). That is the fail-closed behavior O3 requires.

### 4.1 How it gates the path

- **Worker:** the Instant-Secure product endpoint checks `flagRegistry.getFlag('ENABLE_INSTANT_SECURE')` first; OFF → reject with a clear "not available" code (the route simply doesn't perform a debit or enqueue). This is the authoritative gate — the server never charges when the flag is OFF.
- **Client:** the secure dialog hides the "Secure now" option when the flag is OFF. The client gate is **UX only** — the server gate is the real one (never trust the client for a money path).
- **Two existing flags compose with it (AND, not OR):** Instant Secure is only truly live when `ENABLE_INSTANT_SECURE` **and** `ENABLE_PROD_NETWORK_ANCHORING` are both on (you can't instantly secure to a network that's gated off). Credit *enforcement* (`ENABLE_ORG_CREDIT_ENFORCEMENT`) is a separate existing control — see §5/§8 Q1 for how it interacts (enforcement OFF means debits are no-ops, which is a non-charging state, not a double-charging state).

### 4.2 env ⊕ DB consistency (the fail-OPEN signal — handoff to S0-5.1)

A money-path flag is dangerous if `env` and `DB` disagree (one surface thinks Instant Secure is OFF, another thinks it's ON → inconsistent charging). The **fail-open detection** for exactly this class of disagreement is owned by the parallel **S0-5.1 internal-visibility spec** (the "fail-open flags" signal). **Handoff:** `ENABLE_INSTANT_SECURE` must be enrolled in that fail-open consistency check from day one — i.e., the visibility board should alarm if the resolved value of `ENABLE_INSTANT_SECURE` differs between env-fallback and DB, or if it is ON while a precondition (e.g. the alarm itself, or `ENABLE_PROD_NETWORK_ANCHORING`) is in a state that makes charging unsafe. This is a **produce → S0-5.1 / VIS-01** dependency.

---

## 5. Money-safety design (the part that has to be airtight)

Instant Secure is a money path. Three failure classes must be impossible: **(A) double-charge**, **(B) charge-without-secure**, **(C) secure-without-charge**. The design leans entirely on Lane-1's atomic RPC plus the existing idempotency ledger; L2 must not roll its own.

### 5.1 Idempotency (exists today — cite 0326)

`org_credit_deductions` (migration `0326_scrum1649_deduct_org_credit_idempotency.sql`) is the idempotency ledger: `UNIQUE (org_id, reference_id, reason)`. `deduct_org_credit(...)` locks the org balance `FOR UPDATE`, and if a row with the same `(org_id, reference_id, reason)` already exists it returns `{ idempotent: true, deducted: 0 }` (no second charge), or `idempotency_key_conflict` if the same key is reused with a *different* amount. **This is the anti-double-charge primitive.** For user-initiated Instant Secure, the **reference_id must be a deterministic per-submission id** (e.g. a client-minted submission UUID or the anchor's id), so a retry of the *same* submission collapses to the same ledger row → charged exactly once. **Open question Q2 (§8): who mints that reference id, client or server.**

### 5.2 Atomicity (INCOMING — Lane-1, 0341)

Today the FAST_TRACK path debits and *then* submits the job as **two steps** (`rule-action-dispatcher.ts`: `deductOrgCredit(...)` then `submitJob('anchor.fast_track')`), with compensation logic on failure ("retrying without credit compensation", line 588). Two steps means a crash *between* them is a charge-without-secure (B) requiring compensation. **Lane-1's `debit_and_enqueue_anchor` (0341) collapses debit + enqueue into one DB transaction** — the structural fix for (B) and (C). Per HANDOFF.md (2026-06-15, line 65), 0341 also hardens the ledger: `org_credit_deductions` becomes **append-only** (drops the `amount > 0` / `balance_after >= 0` CHECKs in favor of a signed-amount CHECK, adds BEFORE-UPDATE/DELETE triggers, and **REVOKEs DELETE from `service_role`**; refunds become positive rows rather than deletes). **L2-D's design assumes that semantics** — user-initiated Instant Secure calls `debit_and_enqueue_anchor`, not the old two-step path. Until 0341 is on `main` and soaked, the flag stays OFF (O3).

### 5.3 The GA gate — `DOUBLE_BILLING_RISK` alarm (handoff)

The S6 flag flip is **gated by** the `DOUBLE_BILLING_RISK` alarm designed in the parallel S0-5.1 visibility spec (PI-1 Master §6: *"Gated by L2's DOUBLE_BILLING_RISK alarm (VIS-01, S3)"*). Concretely: **`ENABLE_INSTANT_SECURE` must not be flipped ON in prod until the DOUBLE_BILLING_RISK alarm is deployed and green**, so that if a double-charge ever does occur it is detected immediately rather than discovered in a customer complaint. This is a hard precondition on the S6→GA transition, and a **consume ← S0-5.1** dependency.

### 5.4 Reorg (INCOMING — Lane-1, S3/S5; referenced only)

A network reorg can invalidate an anchor *after* the credit was charged. Whether that triggers an automatic refund (a positive `org_credit_deductions` row via `refund_org_credit`, now append-only under 0341) and/or a re-secure is **Lane-1's reorg/proof-invalidation policy (S3/S5)**. L2 only needs to **surface the resulting state** to the user with existing lifecycle copy and refresh the credit balance. **Not designed here.** Q3 (§8) records the product question: what does the user see, and is the credit auto-returned.

### 5.5 Fail-CLOSED state machine (sketch for Sprint-1 / the TLA+ check)

This is the product-side state contract S6 must implement (and is a candidate for a TLA PreCheck machine, given it is a money path — TLA+ is mandated for anchor-lifecycle changes per CLAUDE.md §"anchor lifecycle"). The chain-internal transitions belong to Lane-1's `machines/bitcoinAnchor.machine.ts`; this sketch is the **funding/scheduling envelope** around it.

```
                         ┌─────────────────────────────────────────────┐
                         │ IDLE (document fingerprinted, dialog open)   │
                         └───────────────┬─────────────────────────────┘
                                         │ user picks a service level
                  ┌──────────────────────┴───────────────────────┐
                  │ chose BATCH (default)        chose INSTANT      │
                  ▼                                                ▼
        ┌──────────────────┐                        ┌─────────────────────────────┐
        │ ENQUEUE_BATCH    │                        │ PRECHECK_CREDITS (client)   │
        │ (no credit cost) │                        │ useCredits(): balance>=cost?│
        └─────────┬────────┘                        └───────┬─────────────┬───────┘
                  │                                          │ no          │ yes
                  ▼                                          ▼             ▼
            [existing PENDING                     ┌────────────────┐  ┌──────────────────────────┐
             → batch → SECURED]                   │ BLOCKED_NO_     │  │ FLAG_CHECK (server)      │
                                                  │ CREDITS         │  │ getFlag(ENABLE_INSTANT_  │
                                                  │ (not charged,   │  │ SECURE) && PROD_ANCHORING│
                                                  │  not secured)   │  └──────┬─────────────┬─────┘
                                                  └────────────────┘    OFF→reject     ON │
                                                                            │             ▼
                                                                            │   ┌───────────────────────────┐
                                                                            │   │ ATOMIC_DEBIT_AND_ENQUEUE  │
                                                                            │   │ debit_and_enqueue_anchor  │
                                                                            │   │ (Lane-1 0341, 1 txn)      │
                                                                            │   └───┬───────────────┬───────┘
                                                                            │  fail/crash         success
                                                                            │       │                │
                                                                            ▼       ▼                ▼
                                                                  ┌──────────────────────┐  ┌──────────────────┐
                                                                  │ FAILED_NOT_CHARGED   │  │ INSTANT_PENDING  │
                                                                  │ (no debit, no anchor)│  │ (charged once,   │
                                                                  │ retry == same        │  │  anchor enqueued)│
                                                                  │ reference_id (idemp.)│  └────────┬─────────┘
                                                                  └──────────────────────┘           │
                                                                                                      ▼
                                                                                          [→ SECURED, Anchor Receipt;
                                                                                           reorg handling = Lane-1]
```

**Invariants the machine must preserve (the O3 soak must demonstrate these):**
- **I1 (no double-charge):** two requests with the same `reference_id` debit at most once. (Demonstrated by the crash/retry leg of the T3 soak.)
- **I2 (no charge-without-secure):** if `ATOMIC_DEBIT_AND_ENQUEUE` does not commit, no debit row exists. (Atomic txn, 0341.)
- **I3 (no secure-without-charge):** an immediate anchor is never enqueued without its debit row in the same txn. (Atomic txn, 0341.)
- **I4 (flag-off ⇒ inert):** with `ENABLE_INSTANT_SECURE` off, no debit and no immediate enqueue can occur via this path.

---

## 6. Cross-lane dependency map + S4→S5→S6→S7 sequencing

### 6.1 Sequence (PI-1 Master §6)

```
 S3  ──────────────  S4  ──────────────  S5  ──────────────  S6  ──────────────  S7
 L2: DOUBLE_BILLING  L1: chain-side       L1: T3 soak —        L2: Instant-Secure   GA polish
 _RISK alarm         atomic RPC           crash / double-      UX + flag flip       (this lane,
 (VIS-01) + reorg    (debit_and_enqueue   charge / reorg       (this design built)  follow-on)
 policy starts (L1)  _anchor, 0341)       (isolated, O3)            │
        │                  │                   │                    │
        └──── gates ───────┼─── proves ────────┘                    │
                           └──── depends on ────────────────────────┘
```

- **S4 (Lane-1):** lands `debit_and_enqueue_anchor` (0341) on `main` (after Train D rebases onto the post-#1154 main per the HANDOFF no-restart plan). **L2 cannot start S6 until this is on `main`.**
- **S5 (Lane-1):** the **isolated T3 soak** that proves crash / double-charge / reorg safety. **This soak IS the O3 evidence.** L2 consumes its result, does not run it.
- **S6 (Lane-2 — what this pre-design feeds):** build the UX selector + the thin product endpoint + the `ENABLE_INSTANT_SECURE` flag wiring + the copy. **Flag flip ON is gated on**: (a) 0341 on `main`, (b) S5 soak green, (c) `DOUBLE_BILLING_RISK` alarm deployed + green.
- **S7 (Lane-2):** GA polish — bulk Instant Secure (deferred from S6, §8 Q4), credit-purchase funnel tie-in, copy finalization, dashboards.

### 6.2 What Lane-2 needs from Lane-1, and when

| # | Need from Lane-1 | When | Why |
|---|---|---|---|
| D1 | `debit_and_enqueue_anchor` RPC (0341) on `main` with a stable signature (params, return shape, error codes) | before S6 build | The S6 product endpoint calls it; the UX failure states (§3.3) map 1:1 to its error codes. **L2 needs the error-code contract published** to wire `NOT_CHARGED_*` copy. |
| D2 | Confirmed `org_credit_deductions` append-only semantics + refund-as-positive-row (0341) | before S6 build | Determines the refund/reorg UX and whether L2 ever calls `refund_org_credit`. |
| D3 | S5 T3 soak result (crash / double-charge / reorg) — the O3 evidence | before flag flip (S6→GA) | O3 gate. |
| D4 | Reorg → proof-invalidation + refund policy (S3/S5) | before S7 | L2 surfaces the resulting state + balance; needs to know if refund is automatic. |

### 6.3 What Lane-2 produces (for other lanes)

| # | Produce → | Consumer | Content |
|---|---|---|---|
| P1 | `ENABLE_INSTANT_SECURE` enrolled in the fail-open flag-consistency check | S0-5.1 / VIS-01 | env⊕DB disagreement on this flag must alarm (§4.2). |
| P2 | `DOUBLE_BILLING_RISK` is a hard S6→GA precondition | S0-5.1 / VIS-01 | the alarm must be live + green before the flip (§5.3). |
| P3 | This pre-design (UX + flag + fail-closed contract) | Sprint-1 S6 team | so S6 codes, not scopes. |

---

## 7. Sprint-1+ entry list (what Lane-2 scopes for S6) + the O3 GA decision

### 7.1 S6 build backlog (Lane-2, derived from this design)

1. **Register `ENABLE_INSTANT_SECURE`** (DB-backed switchboard flag; add to `DB_FLAGS` in `flagRegistry.ts`; default OFF; env fallback). + tests for fail-closed (unknown/unset ⇒ false).
2. **Thin product endpoint** (worker) that: checks the flag, checks `ENABLE_PROD_NETWORK_ANCHORING`, runs `checkPaymentGuard`, then calls Lane-1's `debit_and_enqueue_anchor` (D1) — and maps its error codes to the §3.3 failure states. No bespoke debit logic.
3. **UX: service-level selector** in the secure dialog (`SECURE_DIALOG_LABELS` area), credit pre-check via `useCredits()`, the cost preview, and all `INSTANT_SECURE_LABELS` copy (§3.4) in `src/lib/copy.ts`. Hidden when flag OFF.
4. **Fail-closed state machine** (§5.5) implemented + (recommended) a TLA PreCheck machine for the funding envelope; invariants I1–I4 as assertions.
5. **Tests-first:** unit (flag off ⇒ no debit; insufficient ⇒ no debit; retry ⇒ single charge), E2E (`e2e/`) for the upload→instant→secured happy path and the not-charged failure path. Terminology gate (`lint:copy`) on the new copy.
6. **Enroll the flag in the fail-open visibility check** (P1) + confirm the `DOUBLE_BILLING_RISK` alarm dependency (P2).

### 7.2 The O3 GA decision (framed for Carson)

> **Decision:** flip `ENABLE_INSTANT_SECURE` ON in prod (GA), **or** keep it OFF with evidence.
> **Flip ON only if ALL are true:**
> 1. `debit_and_enqueue_anchor` (0341) is on `main` and in prod (verified in-session, not inferred).
> 2. The S5 isolated **T3 soak passed** crash / double-charge / reorg (the O3 evidence artifact — exact head SHA, isolated project ref, soak start/end).
> 3. The `DOUBLE_BILLING_RISK` alarm is **deployed and green**.
> 4. Reorg→refund policy (D4) is decided and the UX surfaces it.
> **Otherwise:** stays **OFF**, and that OFF-state is itself the acceptable launch posture per O3 (GA-on-soak **OR** flag-OFF-with-evidence). Shipping S6 *code* with the flag OFF is a complete, non-blocking Sprint outcome — the path exists, dark, ready to flip when the evidence lands.

This is a **T2/T3 prod change** (billing + flag flip on a money path) → **Carson owns the flip**, with the soak evidence + alarm status attached. No agent flips it.

---

## 8. Open questions / decisions for Carson

- **Q1 — `ENABLE_ORG_CREDIT_ENFORCEMENT` interaction.** Enforcement defaults OFF (`config.ts:110`); HANDOFF says prod `org_credit_deductions` is empty. If Instant Secure is built while enforcement is OFF, debits are effectively no-ops — a *non-charging* state (safe: no double-charge, but also "free instant" which may not be intended). **Should S6's flag flip also require `ENABLE_ORG_CREDIT_ENFORCEMENT` ON, so Instant Secure actually charges?** (Recommended: yes — GA requires enforcement ON, else we give away instant anchoring.)
- **Q2 — `reference_id` minting.** Client-minted submission UUID (idempotent across client retries, but trust boundary) vs. server-minted (simpler trust, but a network retry before the client learns the id needs care). Recommendation: server-minted id returned on first call + an `Idempotency-Key` header echoed by the client on retry. **Carson/Lane-1 alignment needed — this couples to 0341's RPC signature (D1).**
- **Q3 — Reorg refund UX.** When a reorg invalidates a charged instant anchor, is the credit auto-refunded (positive `org_credit_deductions` row) and the doc auto-re-queued to batch, or does the user choose? **Lane-1 owns the mechanism (S3/S5); the product behavior is Carson's call.**
- **Q4 — Bulk Instant Secure.** S6 ships single-document only; bulk stays batch. Is bulk Instant Secure an S7 follow-on, or out of PI-1 entirely? (Cost + atomicity multiply across N docs; per-row partial-failure UX is non-trivial.)
- **Q5 — Cost per Instant Secure.** This design assumes **1 credit / document**. Confirm against the fee model (paid credits = $1.25 each). If instant carries a premium multiplier, the cost-preview copy (§3.4) changes.
- **Q6 — Flag kind.** Recommended DB-backed switchboard flag (flip without redeploy). Confirm Carson wants the rollout-control ergonomics vs. an env-only process flag.

---

## 9. NOT in scope / deferred

- **No chain/proof internals.** `debit_and_enqueue_anchor` (0341), the broadcast path, Merkle batching, and reorg/proof-invalidation are **Lane-1's** (S4/S5). This doc references them as dependencies and designs only the product envelope.
- **No code this sprint.** T0, design-only. The `INSTANT_SECURE_LABELS` block, the flag registration, the endpoint, the selector, and the state machine are **Sprint-1/S6 build items** (§7.1), not landed here.
- **Flag stays OFF.** `ENABLE_INSTANT_SECURE` is proposed at default OFF and is not created/flipped by this work. Any flip is a Carson-gated T2/T3 prod change with O3 evidence attached.
- **No prod/staging/Supabase/soak mutation.** No queries run against prod this session; all prod-state references are from HANDOFF.md and must be re-verified in-session at build time.
- **Bulk Instant Secure** deferred past S6 (§8 Q4).
- **Migration ledger / database.types.ts / Lane-1 + Lane-3 code:** untouched (read-to-cite only).

---

### Source map (paths cited, read this session)

- `services/worker/src/billing/paymentGuard.ts` — `checkPaymentGuard` order (beta → admin → stripe → x402).
- `supabase/migrations/0326_scrum1649_deduct_org_credit_idempotency.sql` — `org_credit_deductions` (UNIQUE org/ref/reason, `FOR UPDATE`), `deduct_org_credit` / `refund_org_credit`.
- `services/worker/src/jobs/rule-action-dispatcher.ts` — existing FAST_TRACK_ANCHOR ("DS-06, instant secure") fail-closed two-step debit→submitJob path (the precedent + the atomicity gap 0341 closes).
- `services/worker/src/middleware/flagRegistry.ts` — env vs DB flag pattern; `getFlag` returns false for unknown (fail-closed).
- `services/worker/src/config.ts` — `enableProdNetworkAnchoring` (:101), `enableOrgCreditEnforcement` (:110) flag definitions.
- `services/worker/src/api/queue-resolution.ts` + `jobs/batch-anchor.js` — the nightly/manual batch path (`processBatchAnchors`).
- `src/components/anchor/FileUpload.tsx`, `src/components/upload/BulkUploadWizard.tsx`, `src/lib/copy.ts` (`SECURE_DIALOG_LABELS` :643, `ANCHOR_STATUS_*` :14) — upload entry + copy surfaces + terminology.
- `src/hooks/useCredits.ts` (`get_user_credits` → balance/allocation/purchased) + `src/components/dashboard/CreditUsageWidget.tsx` — credit pre-check UI.
- `docs/sprint-0/lane2/00-ceremonies.md` — L2-D scope/AC/DoR/DoD + pre-mortem. **HANDOFF.md** (2026-06-15 lines 65–66; 2026-06-16 line 24) — Train D 0341 state, prod ledger empty, `enableOrgCreditEnforcement` default false. PI-1 Master §6 — critical-path sequencing.

_Status: DRAFT — Lane-2 product side only. Implementation deferred to Sprint 1+ (S6). No prod state asserted; INCOMING/PROPOSED items flagged. Tier T0._
