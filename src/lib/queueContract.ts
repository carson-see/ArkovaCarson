/**
 * QUEUE-01 / SCRUM-2347 — Queue / Instant-Secure UX contract (TYPES).
 *
 * Frozen, single-source-of-truth type surface for the queue-first vs.
 * instant-secure document-securing experience. The credit-ledger work, the
 * batch/instant processor, and the consumer secure-queue UI all consume THIS
 * module so the state vocabulary cannot drift between layers.
 *
 * Scope (Tier T0 — spec + types + copy only):
 *  - canonical queue lifecycle states + their helper guard;
 *  - the credit-debit touchpoint states (spent / pending / refunded), mapped
 *    1:1 to the `debit_and_enqueue` + nightly reconciler model;
 *  - the securing-path union and the LAUNCH posture (queue-first only; instant
 *    is HIDDEN/absent until a server capability turns it on);
 *  - the three distinct "queue" surfaces that must never collide in copy.
 *
 * This module deliberately contains NO runtime behaviour beyond the frozen
 * constant arrays + one pure type-guard. It imports nothing and touches no DB,
 * network, or React — it is the contract, not the implementation.
 *
 * Terminology (CLAUDE.md §1.3): user-visible strings live in `src/lib/copy.ts`.
 * The identifiers here are internal code names and intentionally use neutral
 * vocabulary (no Wallet / Hash / Transaction / Broadcast). "Anchored" is the
 * terminal lifecycle code-name; the user-facing label is "Secured".
 */

// =============================================================================
// QUEUE LIFECYCLE
// =============================================================================

/**
 * The canonical, ordered lifecycle a document passes through from the moment a
 * user adds it to the secure queue until it is permanently secured (or stops).
 *
 *  pending      — accepted client-side; fingerprinted on-device; not yet enqueued
 *                 server-side (e.g. metadata/extraction still resolving).
 *  queued       — durably enqueued for securing. NO credit is consumed here
 *                 (queueing is free; the charge happens at securing).
 *  processing   — picked up by the processor (nightly batch drain, or instant
 *                 path when enabled); work in flight.
 *  materialized — the network receipt has been produced for this item's batch
 *                 (Merkle leaf assigned) but on-network confirmation is pending.
 *  anchored     — permanently secured + confirmed on the production network.
 *                 User-facing terminal-success label is "Secured".
 *  failed       — a terminal/again-retryable error stopped securing. Money rule:
 *                 a failed item is never charged-without-securing.
 *  skipped      — intentionally not secured (e.g. duplicate fingerprint routed to
 *                 the org duplicate-review surface, or user-cancelled). Not an error.
 *
 * Order is load-bearing: it is the progression the timeline/stepper renders and
 * the order the contract doc freezes.
 */
export const QUEUE_LIFECYCLE_STATES = [
  'pending',
  'queued',
  'processing',
  'materialized',
  'anchored',
  'failed',
  'skipped',
] as const;

export type QueueLifecycleState = (typeof QUEUE_LIFECYCLE_STATES)[number];

/** The terminal lifecycle states — no further automatic transition occurs. */
export const TERMINAL_QUEUE_STATES = ['anchored', 'failed', 'skipped'] as const;
export type TerminalQueueState = (typeof TERMINAL_QUEUE_STATES)[number];

/** Runtime type-guard: true when `value` is a known queue lifecycle state. */
export function isQueueLifecycleState(value: unknown): value is QueueLifecycleState {
  return (
    typeof value === 'string' &&
    (QUEUE_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

// =============================================================================
// CREDIT-DEBIT TOUCHPOINTS
// =============================================================================

/**
 * The user-visible state of a credit charge tied to a securing action. Mapped
 * 1:1 to the credit-ledger model (`debit_and_enqueue` + the nightly reconciler;
 * `org_credit_deductions` is append-only — refunds are positive reversing rows,
 * never deletes):
 *
 *  spent     — a committed debit row exists for this item; the credit is gone
 *              (the atomic debit_and_enqueue committed).
 *  pending   — a debit is in flight / provisional and not yet reconciled by the
 *              nightly reconciler (e.g. instant secure submitted, awaiting the
 *              reconciler's confirm pass).
 *  refunded  — a reversing (positive) ledger row returned the credit (e.g. a
 *              reorg invalidated an already-charged anchor, or securing failed
 *              after a provisional debit). Append-only; the original debit row
 *              is preserved.
 *
 * There is no "double charge" state by construction: idempotency is keyed on a
 * deterministic per-submission reference id, so a retry collapses to the same
 * ledger row.
 */
export const CREDIT_DEBIT_STATES = ['spent', 'pending', 'refunded'] as const;
export type CreditDebitState = (typeof CREDIT_DEBIT_STATES)[number];

/**
 * WHEN a credit is charged. The contract freezes this to securing, NOT queueing
 * — adding a document to the queue is always free (PRD AC: "Queueing does not
 * consume credits"). Instant secure charges at the atomic debit_and_enqueue
 * step; batch securing charges (if at all) when the batch materializes.
 */
export const CREDIT_DEBIT_TIMING = 'on_securing' as const;
export type CreditDebitTiming = typeof CREDIT_DEBIT_TIMING;

// =============================================================================
// SECURING PATHS + LAUNCH POSTURE
// =============================================================================

/**
 * The two ways a queued document gets secured:
 *  queue   — "Add to Queue": default, free, swept by the batch processor.
 *  instant — "Secure Instantly": immediate, credit-funded, atomic debit+enqueue.
 *
 * Both are named so the UI can label them, but exposure is governed by
 * {@link INSTANT_SECURE_DEFAULT_EXPOSED} and the per-caller capability.
 */
export const SECURING_PATHS = ['queue', 'instant'] as const;
export type SecuringPath = (typeof SECURING_PATHS)[number];

/**
 * LAUNCH POSTURE — instant-secure is HIDDEN by default.
 *
 * `false` means: at launch the only exposed securing path is the queue. The
 * "Secure Instantly" control is ABSENT (not rendered, not greyed-out) unless a
 * trusted server capability says otherwise. Per the AC, "Secure Instantly is
 * hidden if backend processor/credit gate is disabled," and the capability is
 * read from the worker (`/api/billing/status`), never defaulted client-side.
 *
 * The contract specifies the *gating*, not a visible control. Flipping instant
 * secure on is a server/flag decision (Carson-gated), out of scope for T0.
 */
export const INSTANT_SECURE_DEFAULT_EXPOSED = false as const;

/**
 * The capability snapshot a trusted surface (the worker) hands the client to
 * decide whether the instant-secure control may be rendered. The client MUST
 * treat `canSecureInstantly` as authoritative and MUST NOT infer it from a
 * client-side default. `creditBalance` drives the disabled/cost-preview copy
 * once the control is exposed.
 *
 * NOTE: this is the *assumed* shape the contract requires; the additive
 * `canSecureInstantly` field is an entitlement assumption listed for the
 * backend (it is not yet returned by `/api/billing/status` — see the spec doc).
 */
export interface SecuringCapability {
  /** Authoritative server gate. When false, the instant control is not rendered. */
  readonly canSecureInstantly: boolean;
  /** Remaining credits this cycle; drives cost-preview / insufficient copy. */
  readonly creditBalance: number;
  /** Credits one instant-secure consumes (contract assumes 1; confirm vs fee model). */
  readonly instantSecureCost: number;
}

/**
 * Which paths a given caller may actually see, derived from the capability.
 * Pure helper so every surface computes exposure identically. The queue path is
 * always exposed; the instant path is exposed only when the launch posture and
 * the server capability BOTH allow it.
 */
export function exposedSecuringPaths(
  cap: Pick<SecuringCapability, 'canSecureInstantly'>,
): readonly SecuringPath[] {
  const instantExposed = INSTANT_SECURE_DEFAULT_EXPOSED || cap.canSecureInstantly;
  return instantExposed ? (['queue', 'instant'] as const) : (['queue'] as const);
}

// =============================================================================
// QUEUE SURFACES (disambiguation — never two pages titled "Review queue")
// =============================================================================

/**
 * The three DISTINCT "queue" concepts in the product. They must carry distinct
 * page titles in copy (Carson's premortem on SCRUM-2347): shipping two surfaces
 * both titled "Review queue" makes a self-serve user think their document was
 * processed when it is merely queued.
 *
 *  consumer_secure_queue — NEW. The individual/consumer-facing list of documents
 *                          waiting to be secured (backed by the secure-queue;
 *                          the consumer analogue of `review_queue_items`). Solo
 *                          users see ONLY this; they are never routed to the org
 *                          duplicate-review surface.
 *  org_duplicate_review  — EXISTING. The org dedup queue at `/organization/queue`
 *                          (`AnchorQueuePage`, `PENDING_RESOLUTION` anchors). Its
 *                          hardcoded `<h1>Review queue</h1>` is the collision the
 *                          contract retires (route through copy).
 *  org_approvals         — EXISTING. The org fraud/approvals review queue
 *                          (`ReviewQueue` / `ReviewQueuePage`).
 */
export const QUEUE_SURFACES = [
  'consumer_secure_queue',
  'org_duplicate_review',
  'org_approvals',
] as const;
export type QueueSurface = (typeof QUEUE_SURFACES)[number];

// =============================================================================
// VIEW-MODEL CONTRACT (the typed shape the UI/processor exchange)
// =============================================================================

/**
 * The frozen view-model for a single item on the consumer secure queue. This is
 * the typed contract the credit-ledger + processor work produces and the queue
 * UI consumes — one shape, one vocabulary.
 */
export interface QueueItemContract {
  /** Public, non-enumerable id safe to expose (never the raw anchors.id). */
  readonly publicId: string;
  /** Where this item is in the canonical lifecycle. */
  readonly state: QueueLifecycleState;
  /** Which path is/was used to secure it. */
  readonly path: SecuringPath;
  /**
   * Credit-charge state, present only when a charge is involved (instant path).
   * `null` for the free queue/batch path — queueing never consumes a credit.
   */
  readonly creditState: CreditDebitState | null;
  /** ISO-8601 (UTC) instant the item entered its current state. */
  readonly stateSince: string;
}

/**
 * The whole UX contract, bundled so a consumer can import a single typed object
 * describing the launch posture + vocabularies.
 */
export interface QueueUxContract {
  readonly lifecycleStates: typeof QUEUE_LIFECYCLE_STATES;
  readonly creditDebitStates: typeof CREDIT_DEBIT_STATES;
  readonly securingPaths: typeof SECURING_PATHS;
  readonly queueSurfaces: typeof QUEUE_SURFACES;
  readonly creditDebitTiming: CreditDebitTiming;
  readonly instantSecureDefaultExposed: typeof INSTANT_SECURE_DEFAULT_EXPOSED;
}

/** The single frozen contract object (handy for docs/tests/assertions). */
export const QUEUE_UX_CONTRACT: QueueUxContract = {
  lifecycleStates: QUEUE_LIFECYCLE_STATES,
  creditDebitStates: CREDIT_DEBIT_STATES,
  securingPaths: SECURING_PATHS,
  queueSurfaces: QUEUE_SURFACES,
  creditDebitTiming: CREDIT_DEBIT_TIMING,
  instantSecureDefaultExposed: INSTANT_SECURE_DEFAULT_EXPOSED,
} as const;
