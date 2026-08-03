/**
 * Founder directive (2026-08-03): "The 'Auto Secure' rule doesn't secure.
 * ... we need to be able to instantly secure or add to queue and we need
 * rules to work."
 *
 * The rule builder's INSTANT_SECURE option must read EXACTLY like the
 * manual "Secure Instantly" control (SECURING_CHOICE_LABELS.instant /
 * SECURING_CHOICE_HINTS.instant, src/components/anchor/SecureDocumentDialog.tsx)
 * so a user sees the same promise ("instant, costs 1 credit") whether they
 * secure a document by hand or configure a rule to do it automatically.
 * AUTO_ANCHOR's existing copy implied immediacy ("Secure the document" /
 * "Anchor it on the network automatically") while its dispatcher behavior
 * only ever queues (SCRUM-1649 DS-07) — relabeled to mirror the free
 * "Add to Queue" path's copy instead, so the label stops promising something
 * the action does not do. AUTO_ANCHOR's dispatcher BEHAVIOR is unchanged by
 * this PR — this is copy-only.
 */
import { describe, expect, it } from 'vitest';
import {
  RULE_ACTION_COPY,
  SECURING_CHOICE_LABELS,
  SECURING_CHOICE_HINTS,
} from './copy';

describe('RULE_ACTION_COPY — INSTANT_SECURE mirrors the manual Secure Instantly copy exactly', () => {
  it('INSTANT_SECURE label is byte-identical to the manual instant-secure control', () => {
    expect(RULE_ACTION_COPY.INSTANT_SECURE.label).toBe(SECURING_CHOICE_LABELS.instant);
  });

  it('INSTANT_SECURE desc states plainly that it costs 1 credit — byte-identical to the manual flow', () => {
    expect(RULE_ACTION_COPY.INSTANT_SECURE.desc).toBe(SECURING_CHOICE_HINTS.instant);
    expect(RULE_ACTION_COPY.INSTANT_SECURE.desc).toMatch(/1 credit/i);
  });

  it('AUTO_ANCHOR is relabeled to mirror the free "Add to Queue" copy — no longer implies immediacy', () => {
    expect(RULE_ACTION_COPY.AUTO_ANCHOR.label).toBe(SECURING_CHOICE_LABELS.queue);
    expect(RULE_ACTION_COPY.AUTO_ANCHOR.desc).toBe(SECURING_CHOICE_HINTS.queue);
    expect(RULE_ACTION_COPY.AUTO_ANCHOR.desc).toMatch(/free/i);
    // The old copy's immediacy claim must be gone.
    expect(RULE_ACTION_COPY.AUTO_ANCHOR.label).not.toMatch(/secure the document/i);
    expect(RULE_ACTION_COPY.AUTO_ANCHOR.desc).not.toMatch(/automatically$/i);
  });

  it('the two options read as opposites on cost — queue is free, instant costs a credit', () => {
    expect(RULE_ACTION_COPY.AUTO_ANCHOR.desc).toMatch(/free/i);
    expect(RULE_ACTION_COPY.INSTANT_SECURE.desc).not.toMatch(/free/i);
  });

  it('FAST_TRACK_ANCHOR copy is untouched by this PR (out of scope — separate, pre-existing action)', () => {
    expect(RULE_ACTION_COPY.FAST_TRACK_ANCHOR).toEqual({
      label: 'Fast-track secure',
      desc: 'Priority batch (paid plans only).',
    });
  });
});
