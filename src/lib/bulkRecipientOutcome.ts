/**
 * Bulk-import recipient outcome classification (SCRUM-5265 / S3).
 *
 * A `created_recipient_failed` / `skipped_recipient_failed` row always means
 * "the anchor committed, the recipient did not resolve" — but NOT always "the
 * recipient was not linked". In `services/worker/src/api/bulk-recipient.ts` the
 * `anchor_recipients` insert commits BEFORE `deliverBulkActivationOnce`, so the
 * activation reasons are thrown with the link already in place. Reporting all of
 * them as "not linked, so no invitation was sent" asserts two things we did not
 * measure (§1.5), and it points the reader at the wrong remedy.
 *
 * This module holds ONLY the mapping, so the copy layer stays copy and the
 * classification can be tested against the worker's throw sites directly.
 */

import type { BulkAnchorResultStatus } from '@/hooks/useBulkAnchors';

/** Rendering order — most actionable first, least assertive last. */
export const RECIPIENT_OUTCOME_CLASSES = [
  'notPermitted',
  'notLinked',
  'linkedNotSent',
  'linkedUnconfirmed',
  'unknown',
] as const;

export type RecipientOutcomeClass = (typeof RECIPIENT_OUTCOME_CLASSES)[number];

export type RecipientOutcomeCounts = Record<RecipientOutcomeClass, number>;

/**
 * Reason code -> what actually happened. Every entry is pinned to a throw site:
 *
 * - `notPermitted`   decided in `handleSelfServiceBulk` before any link is
 *                    attempted; the caller cannot resolve it themselves.
 * - `notLinked`      thrown at or before the `anchor_recipients` insert.
 * - `linkedNotSent`  insert committed, `sendEmail` reported a rejection.
 * - `linkedUnconfirmed` insert committed and the send is genuinely unknown: a
 *                    concurrent claim holder may be mid-send
 *                    (`delivery_pending`), or the delivery row could not be
 *                    read back (`claim_failed`).
 *
 * Anything absent from this table is `unknown` — which asserts nothing rather
 * than guessing, so a newer worker's reason code can never make the UI lie.
 */
const REASON_OUTCOMES: Readonly<Record<string, RecipientOutcomeClass>> = {
  recipient_provisioning_forbidden: 'notPermitted',
  recipient_authorization_unavailable: 'notPermitted',

  recipient_email_invalid: 'notLinked',
  recipient_pepper_unavailable: 'notLinked',
  recipient_anchor_unavailable: 'notLinked',
  recipient_profile_lookup_failed: 'notLinked',
  recipient_profile_create_failed: 'notLinked',
  recipient_link_failed: 'notLinked',
  recipient_link_conflict: 'notLinked',

  recipient_activation_email_failed: 'linkedNotSent',

  recipient_activation_delivery_pending: 'linkedUnconfirmed',
  recipient_activation_claim_failed: 'linkedUnconfirmed',
};

export function classifyRecipientOutcome(reason: string | undefined): RecipientOutcomeClass {
  if (!reason) return 'unknown';
  return REASON_OUTCOMES[reason] ?? 'unknown';
}

/** Rows whose anchor committed but whose recipient did not resolve. */
const RECIPIENT_FAILED_STATUSES = new Set<string>(['created_recipient_failed', 'skipped_recipient_failed']);

export function countRecipientOutcomes(
  rows: ReadonlyArray<{ status: BulkAnchorResultStatus | string; reason?: string }>,
): RecipientOutcomeCounts {
  const counts = Object.fromEntries(
    RECIPIENT_OUTCOME_CLASSES.map((name) => [name, 0]),
  ) as RecipientOutcomeCounts;

  for (const row of rows) {
    if (!RECIPIENT_FAILED_STATUSES.has(row.status)) continue;
    counts[classifyRecipientOutcome(row.reason)] += 1;
  }
  return counts;
}
