/**
 * S3 (#3034 review): the bulk-import summary used ONE copy string for every
 * recipient failure, and that string asserted "the recipient could not be
 * linked, so no invitation was sent". For half the reason codes the worker can
 * return that is false — `anchor_recipients` commits BEFORE
 * `deliverBulkActivationOnce`, so an activation-delivery reason means the link
 * SUCCEEDED and only the email did not go (or may already have gone via a
 * concurrent claim holder). These tests pin the reason -> outcome mapping
 * against the actual throw sites in `services/worker/src/api/bulk-recipient.ts`.
 */

import { describe, it, expect } from 'vitest';
import { classifyRecipientOutcome, countRecipientOutcomes, RECIPIENT_OUTCOME_CLASSES } from './bulkRecipientOutcome';

describe('classifyRecipientOutcome', () => {
  // Thrown before or by the `anchor_recipients` insert: nothing was linked.
  it.each([
    'recipient_email_invalid',
    'recipient_pepper_unavailable',
    'recipient_anchor_unavailable',
    'recipient_profile_lookup_failed',
    'recipient_profile_create_failed',
    'recipient_link_failed',
    'recipient_link_conflict',
  ])('classifies %s as notLinked', (reason) => {
    expect(classifyRecipientOutcome(reason)).toBe('notLinked');
  });

  // Decided before any link is attempted, and the caller cannot fix it alone.
  it.each([
    'recipient_provisioning_forbidden',
    'recipient_authorization_unavailable',
  ])('classifies %s as notPermitted', (reason) => {
    expect(classifyRecipientOutcome(reason)).toBe('notPermitted');
  });

  // The insert already committed; only sendEmail reported a rejection.
  it('classifies recipient_activation_email_failed as linkedNotSent', () => {
    expect(classifyRecipientOutcome('recipient_activation_email_failed')).toBe('linkedNotSent');
  });

  // Linked, but whether the invitation went out is genuinely not known:
  // `delivery_pending` means another claim holder is mid-send, and
  // `claim_failed` covers both a failed claim insert and an unreadable prior
  // delivery row. Neither may be reported as "not sent".
  it.each([
    'recipient_activation_delivery_pending',
    'recipient_activation_claim_failed',
  ])('classifies %s as linkedUnconfirmed', (reason) => {
    expect(classifyRecipientOutcome(reason)).toBe('linkedUnconfirmed');
  });

  // §1.5: an unrecognised or absent code must assert nothing at all — not that
  // the link failed, and not that it succeeded.
  it.each([undefined, '', 'something_new_from_a_newer_worker'])('classifies %s as unknown', (reason) => {
    expect(classifyRecipientOutcome(reason)).toBe('unknown');
  });
});

describe('countRecipientOutcomes', () => {
  it('counts only rows whose anchor committed but whose recipient did not resolve', () => {
    const counts = countRecipientOutcomes([
      { status: 'created' },
      { status: 'skipped' },
      { status: 'failed', reason: 'instant_intent_unavailable' },
      { status: 'created_recipient_failed', reason: 'recipient_provisioning_forbidden' },
      { status: 'skipped_recipient_failed', reason: 'recipient_provisioning_forbidden' },
      { status: 'created_recipient_failed', reason: 'recipient_activation_email_failed' },
      { status: 'created_recipient_failed', reason: 'recipient_link_conflict' },
      { status: 'created_recipient_failed' },
    ]);

    expect(counts).toEqual({
      notPermitted: 2,
      notLinked: 1,
      linkedNotSent: 1,
      linkedUnconfirmed: 0,
      unknown: 1,
    });
  });

  it('returns an all-zero tally for a batch with no recipient failures', () => {
    expect(countRecipientOutcomes([{ status: 'created' }, { status: 'failed' }]))
      .toEqual({ notPermitted: 0, notLinked: 0, linkedNotSent: 0, linkedUnconfirmed: 0, unknown: 0 });
  });

  it('exposes a stable, exhaustive class list for rendering', () => {
    expect(RECIPIENT_OUTCOME_CLASSES)
      .toEqual(['notPermitted', 'notLinked', 'linkedNotSent', 'linkedUnconfirmed', 'unknown']);
  });
});
