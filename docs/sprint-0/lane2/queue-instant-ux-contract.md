# Queue / Instant-Secure UX Contract — QUEUE-01 / SCRUM-2347 (FROZEN)

> **Lane:** L2 — Product & Growth (Front-end + Architect). **Story:** SCRUM-2347 `[QUEUE-01] Queue/instant UX contract`. **Epic:** SCRUM-2328 `[MVP-D-QUEUE]`.
> **Sprint:** PI-0 Sprint 1. **Tier:** **T0** (spec + copy + types only — no schema/worker/component change; no Train A/B/C surface mutated).
> **Date:** 2026-06-23. **Status:** FROZEN contract, ready for review.
> **PRD:** `QUEUE-01` (Google Doc `1Wk0V84jclV3DFstwgbkVhGRuApIHZ15QGki5sDp632s`). Builds on the Lane-2 Instant-Secure pre-design (`docs/sprint-0/lane2/instant-secure-predesign.md`).

> **Note (CLAUDE.md §4):** this is an **internal engineering note**. The source-of-truth doc is the Confluence page (Switchboard + Data Model pages) — flagged for the RTE to mirror. Markdown in `docs/` is not the canonical doc.

---

## 0. What this contract freezes (and what it deliberately does not)

**Freezes** (so the credit-ledger + processor work in SCRUM-2328 has one typed, named vocabulary):
- the canonical **queue lifecycle states** and their user-visible labels;
- the **credit-debit touchpoint states** (spent / pending / refunded), mapped 1:1 to the `debit_and_enqueue` + reconciler model;
- the **launch posture**: queue-first is the only exposed securing path; **Secure Instantly is HIDDEN** (absent, not greyed) until a server capability turns it on;
- the **three distinct "queue" surfaces** so we never ship two pages both titled "Review queue".

**Does NOT** (out of T0 scope, named here as boundaries):
- build the secure-queue page, the service-level selector, or the instant endpoint (that is the SCRUM-2328 build, the Lane-2 S6 slice);
- create or flip any feature flag / `ENABLE_INSTANT_SECURE` (Carson-gated T2/T3 prod change);
- design the chain-side `debit_and_enqueue_anchor` RPC, batching, or reorg/proof-invalidation (Lane-1 / Train D, migration 0341 — INCOMING, not on `main`);
- mutate prod/staging, the migration ledger, or `database.types.ts`.

The typed surface lives in [`src/lib/queueContract.ts`](../../../src/lib/queueContract.ts); the copy lives in [`src/lib/copy.ts`](../../../src/lib/copy.ts); the TDD guard is [`src/lib/queueContract.test.ts`](../../../src/lib/queueContract.test.ts).

---

## 1. Acceptance criteria → where each is satisfied

| AC (SCRUM-2347) | Satisfied by |
|---|---|
| Copy + states for **Add to Queue** vs **Secure Instantly** are approved | `SECURING_CHOICE_LABELS` / `SECURING_CHOICE_HINTS` + `QUEUE_LIFECYCLE_LABELS` in `copy.ts`; §2 + §4 here. |
| Secure Instantly is **hidden** if backend processor/credit gate is disabled | `INSTANT_SECURE_DEFAULT_EXPOSED = false` + `exposedSecuringPaths()` in `queueContract.ts`; §4 here. **Absent, not greyed.** |
| Individuals, org members, org admins, sub-org admins see correct options | §5 audience matrix; capability read server-side, never a client default. |
| Queueing does **not** consume credits | `CREDIT_DEBIT_TIMING = 'on_securing'`; `queued`/`pending` lifecycle copy says "no credits"; §3 here. |

**DoD:** UX contract documented + reviewed (this doc + Confluence mirror); backend entitlement assumptions listed (§6); evidence tier **T0**; no Train A/B/C surface mutated (only additive `copy.ts` keys + two new `src/lib/` files).

---

## 2. Canonical queue lifecycle

A document moves through this **ordered** lifecycle from "added to the queue" to "permanently secured" (or a terminal stop). The union is `QueueLifecycleState` in `queueContract.ts`; the order is load-bearing (it is the stepper/timeline order).

| Code state (`QueueLifecycleState`) | User-visible label (`QUEUE_LIFECYCLE_LABELS`) | Shown when | Credits |
|---|---|---|---|
| `pending` | **Pending** | Accepted + fingerprinted on-device; not yet durably enqueued server-side (e.g. metadata/extraction resolving). | none |
| `queued` | **In Queue** | Durably enqueued for securing, waiting for the processor (batch drain, or instant when enabled). | **none — queueing is free** |
| `processing` | **Securing** | Picked up by the processor; securing in flight. | charged here *iff* instant path |
| `materialized` | **Awaiting Confirmation** | Network receipt produced for this item's batch (Merkle leaf assigned); on-network confirmation pending. | already charged or n/a |
| `anchored` | **Secured** | Permanently secured + confirmed on the production network. Terminal success; user sees the Anchor Receipt / verification link. | settled |
| `failed` | **Needs Attention** | A retryable/terminal error stopped securing. **You were not charged.** Retry is idempotent. | none / refunded |
| `skipped` | **Skipped** | Intentionally not secured — duplicate fingerprint routed to org duplicate-review, or user-cancelled. Not an error. | none |

**Mapping to the existing anchor enum.** This lifecycle is the *queue/scheduling envelope* around the existing chain status (`ANCHOR_STATUS_LABELS`: PENDING / SUBMITTED / SECURED / …). `anchored` ≙ chain `SECURED`; `materialized` ≙ chain `SUBMITTED` (receipt exists, awaiting confirmation). The contract uses neutral code-names internally and the approved §1.3 labels in the UI ("Secured", never "anchored to Bitcoin").

`isQueueLifecycleState(value)` is the runtime guard for narrowing untrusted strings; `TERMINAL_QUEUE_STATES = [anchored, failed, skipped]`.

---

## 3. Credit-debit touchpoints (maps 1:1 to `debit_and_enqueue` + reconciler)

The funding model (memory: subscription + nightly batch drain; monthly credit allotment for instant; paid credits $1.25 each) means **the charge is for *instant* securing, and it happens at securing — never at queueing.** `CREDIT_DEBIT_TIMING = 'on_securing'`.

| Credit state (`CreditDebitState`) | Label (`CREDIT_DEBIT_LABELS`) | Ledger meaning (`org_credit_deductions`, append-only) |
|---|---|---|
| `spent` | **Credit used** | A committed debit row exists — the atomic `debit_and_enqueue` committed; 1 credit consumed. |
| `pending` | **Credit pending** | A provisional debit awaiting the **nightly reconciler**'s confirm pass (instant submitted, not yet reconciled). |
| `refunded` | **Credit refunded** | A **reversing (positive) row** returned the credit (reorg invalidated a charged anchor, or securing failed after a provisional debit). Append-only — the original debit row is preserved; never a delete. |

**Money invariants the contract assumes (proven by Lane-1's T3 soak, not here):**
- **No double-charge** — idempotency keyed on a deterministic per-submission reference id; a retry collapses to the same ledger row. There is *no* "double charge" state by construction.
- **No charge-without-secure** — debit + enqueue commit in one transaction (`debit_and_enqueue`, 0341). If it doesn't commit, no debit row exists → the item is `failed`, never silently charged.
- **No secure-without-charge** — an instant anchor is never enqueued without its debit row in the same transaction.
- **Refunds are append-only reversing entries** — `org_credit_deductions` drops the delete path; refunds are positive rows (per Train D 0341 hardening).

On the **queue (batch) path**, `QueueItemContract.creditState` is `null` — there is no charge to show.

---

## 4. Launch posture — instant-secure is HIDDEN

`INSTANT_SECURE_DEFAULT_EXPOSED = false`. **At launch the queue is the only exposed securing path.**

- The **"Secure Instantly" control is ABSENT** — not rendered, not greyed-out — unless a trusted **server capability** says otherwise. OFF-state UX is byte-identical to a queue-only product.
- The capability is **read from the worker** (`/api/billing/status`, see §6), and the client treats it as authoritative. The client **never** defaults it on (never trust the client for a money path).
- `exposedSecuringPaths(cap)` is the single helper every surface uses: it returns `['queue']` unless the launch posture **and** `cap.canSecureInstantly` both allow instant, in which case `['queue', 'instant']`.
- The contract specifies the **gating**, not a visible control. Flipping instant-secure on is a server/flag decision (Carson-gated, with the O3 soak evidence + double-billing alarm per the pre-design), **out of T0 scope**.

**Default UX:** the secure flow shows **Add to Queue** as the single primary action. When (and only when) the capability is granted, a second option **Secure Instantly** appears with a one-line cost preview (`SECURE_QUEUE_LABELS.COST_PREVIEW`), disabled with `INSUFFICIENT_CREDITS` helper text when the balance is too low (the batch/queue path stays one click and free).

---

## 5. Audience matrix — who sees what

Securing-path exposure is **identical across audiences** and is governed by the **server capability**, not the role. The queue is always available; instant appears only when the capability is granted. Role only affects which *other* queue surfaces (org duplicate-review / approvals) are reachable.

| Audience | Add to Queue (consumer secure queue) | Secure Instantly | Org duplicate-review (`/organization/queue`) | Org approvals |
|---|---|---|---|---|
| Individual (solo / self-serve) | ✅ default | only if capability granted | **never routed here** (premortem) | — |
| Org member | ✅ default | only if capability granted | view per org policy | — |
| Org admin | ✅ default | only if capability granted | ✅ | ✅ |
| Sub-org admin | ✅ default | only if capability granted | ✅ (own sub-org) | ✅ (own sub-org) |

**Solo users are never routed to the org dedup queue** — it shows "You're all caught up", which would make a self-serve user think their document was processed when it is merely queued. (Carson premortem on SCRUM-2347, ref 81100802.)

---

## 6. Backend entitlement assumptions (for the SCRUM-2328 build)

These are **assumptions this contract depends on**, listed for the backend/credit-ledger owners. None are asserted as existing prod state.

1. **Capability source.** The instant-secure capability (`canSecureInstantly`) is an **additive** field the worker returns. Today `/api/billing/status` returns `{ status, plan, usage, billing }` (`services/worker/src/routes/billing.ts` `handleBillingStatus`) and does **not** carry an instant-secure flag. The build must add a server-derived capability (composing `ENABLE_INSTANT_SECURE` ⊕ `ENABLE_PROD_NETWORK_ANCHORING` ⊕ credit-enforcement ⊕ sufficient balance) and the client must read it — never default it on. `SecuringCapability` in `queueContract.ts` is the assumed shape (`canSecureInstantly`, `creditBalance`, `instantSecureCost`).
2. **Charge timing.** Charge at securing, not at queueing. Queueing writes no `org_credit_deductions` row.
3. **Atomic debit+enqueue.** Instant securing rides Lane-1's `debit_and_enqueue_anchor` (migration 0341, Train D — INCOMING, not on `main`). Until it lands + soaks, instant stays hidden.
4. **Append-only ledger.** `org_credit_deductions` is append-only under 0341; refunds are positive reversing rows; `service_role` DELETE revoked.
5. **Idempotency.** Deterministic per-submission `reference_id` so retries charge exactly once (`org_credit_deductions` UNIQUE `(org_id, reference_id, reason)`, per 0326).
6. **Cost.** Contract assumes **1 credit / instant secure**; confirm against the fee model (paid credits $1.25 each). If a premium multiplier applies, `instantSecureCost` + `COST_PREVIEW` copy change.

---

## 7. Three-queue disambiguation (premortem fix)

There are **three distinct "queue" concepts**; conflating them ships two pages both titled "Review queue". `QueueSurface` + `QUEUE_SURFACE_TITLES` give each a distinct title.

| Surface (`QueueSurface`) | Title (`QUEUE_SURFACE_TITLES`) | Reality |
|---|---|---|
| `consumer_secure_queue` | **Pending Documents** | **NEW.** The individual/consumer list of documents waiting to be secured (consumer analogue of `review_queue_items`). Solo users see only this. |
| `org_duplicate_review` | **Duplicate Review** | **EXISTING.** Org dedup queue at `/organization/queue` (`src/pages/AnchorQueuePage.tsx`, `PENDING_RESOLUTION` anchors). Its hardcoded `<h1>Review queue</h1>` (`AnchorQueuePage.tsx:322`) is the collision to retire. |
| `org_approvals` | **Approvals** | **EXISTING.** Org fraud/approvals review queue (`src/components/organization/ReviewQueue.tsx`, `src/pages/ReviewQueuePage.tsx`). |

**Follow-on (build, not T0):** replace the hardcoded `AnchorQueuePage.tsx:322` `<h1>Review queue</h1>` with `QUEUE_SURFACE_TITLES.org_duplicate_review`, and (optional) add a copy-lint that rejects two surfaces sharing a page title. The contract test already asserts the three titles are mutually distinct and that `consumer_secure_queue` is not titled "Review queue".

---

## 8. The typed contract (for the credit-ledger + processor consumers)

`QueueItemContract` is the frozen view-model the processor produces and the queue UI consumes:

```ts
interface QueueItemContract {
  publicId: string;                       // public, non-enumerable id (never anchors.id)
  state: QueueLifecycleState;             // pending | queued | processing | materialized | anchored | failed | skipped
  path: SecuringPath;                     // queue | instant
  creditState: CreditDebitState | null;   // spent | pending | refunded — null for the free queue path
  stateSince: string;                     // ISO-8601 (UTC)
}
```

`QUEUE_UX_CONTRACT` bundles the frozen constant arrays + the launch posture for docs/tests.

---

## 9. Tests / gates

- **TDD:** `src/lib/queueContract.test.ts` (13 assertions) — written failing first, then green. Asserts: the lifecycle union order; an **exhaustive** 1:1 label + description map (a compile-time `never`-switch proves totality, so adding a state without a label fails `tsc`); the credit-debit states map 1:1; `CREDIT_DEBIT_TIMING === 'on_securing'`; `INSTANT_SECURE_DEFAULT_EXPOSED === false`; the three surface titles are distinct + non-colliding; `SECURE_QUEUE_LABELS` exists.
- **`lint:copy`** green — all new strings are §1.3-clean (no Wallet/Hash/Transaction/Bitcoin/Broadcast; "credit" + "Secured" + "Anchor Receipt" are the approved terms). `copy.ts` is excluded from the scan as the vocabulary file, but the keys are consumed from `src/lib/`, which **is** scanned.
- **`typecheck` + `lint` + `test`** green (repo-wide; the only pre-existing red is an unrelated worktree-local `tsx` resolution issue in `scripts/staging/load-harness-env.test.ts`, not touched here).

---

## 10. Source map (read this session)

- `src/lib/copy.ts` (`ANCHOR_STATUS_LABELS` / `ANCHORING_STATUS_LABELS` / `TREASURY_LABELS.ANCHOR_STATUS_*`) — existing status vocabulary the new labels align with.
- `src/lib/queueContract.ts` / `.test.ts` — the new typed contract + TDD guard.
- `services/worker/src/routes/billing.ts` (`handleBillingStatus`, `GET /api/billing/status`) — capability source (additive field assumption).
- `src/pages/AnchorQueuePage.tsx:322` — the hardcoded `<h1>Review queue</h1>` collision; `src/components/organization/ReviewQueue.tsx`, `src/pages/ReviewQueuePage.tsx`, `review_queue_items` (`database.types.ts:4935`).
- `docs/sprint-0/lane2/instant-secure-predesign.md` — Lane-2 Instant-Secure pre-design (flag, fail-closed money path, S4→S7 sequencing) this contract's launch posture follows.

_Status: FROZEN — Lane-2 product/UX contract. Implementation deferred to the SCRUM-2328 build. No prod state asserted; INCOMING/PROPOSED items flagged. Tier T0._
