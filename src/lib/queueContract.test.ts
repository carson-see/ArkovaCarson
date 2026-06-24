/**
 * QUEUE-01 / SCRUM-2347 — Queue/Instant-Secure UX contract tests.
 *
 * TDD guard for the frozen UX contract:
 *  - the canonical queue lifecycle union is exhaustively labelled in copy.ts;
 *  - the credit-debit touchpoint states map 1:1 to the debit_and_enqueue +
 *    reconciler model;
 *  - the securing-path union exposes ONLY the queue-first path at launch
 *    (instant-secure is gated/hidden, per the AC "Secure Instantly is hidden
 *    if backend processor/credit gate is disabled");
 *  - the three distinct "queue" concepts have distinct page titles (Carson's
 *    premortem: never ship two surfaces both titled "Review queue").
 *
 * These are pure, dependency-free assertions over the typed contract + the copy
 * registry — no React, no network, no DB.
 */

import { describe, it, expect } from 'vitest';
import {
  QUEUE_LIFECYCLE_STATES,
  CREDIT_DEBIT_STATES,
  SECURING_PATHS,
  QUEUE_SURFACES,
  INSTANT_SECURE_DEFAULT_EXPOSED,
  CREDIT_DEBIT_TIMING,
  isQueueLifecycleState,
  type QueueLifecycleState,
  type CreditDebitState,
  type SecuringPath,
  type QueueSurface,
} from './queueContract';
import {
  QUEUE_LIFECYCLE_LABELS,
  QUEUE_LIFECYCLE_DESCRIPTIONS,
  CREDIT_DEBIT_LABELS,
  SECURE_QUEUE_LABELS,
  SECURING_CHOICE_LABELS,
  QUEUE_SURFACE_TITLES,
} from './copy';

describe('queue lifecycle contract', () => {
  it('enumerates the canonical lifecycle states in order', () => {
    expect(QUEUE_LIFECYCLE_STATES).toEqual([
      'pending',
      'queued',
      'processing',
      'materialized',
      'anchored',
      'failed',
      'skipped',
    ]);
  });

  it('labels every lifecycle state exactly once (exhaustive, no orphans)', () => {
    const labelled = Object.keys(QUEUE_LIFECYCLE_LABELS).sort();
    const expected = [...QUEUE_LIFECYCLE_STATES].sort();
    expect(labelled).toEqual(expected);
    for (const state of QUEUE_LIFECYCLE_STATES) {
      expect(QUEUE_LIFECYCLE_LABELS[state]).toBeTruthy();
      expect(QUEUE_LIFECYCLE_DESCRIPTIONS[state]).toBeTruthy();
    }
  });

  it('exhaustive-switch over the union compiles and is total', () => {
    // A switch with no default that returns for every member is the compile-time
    // exhaustiveness proof: adding a state without a branch fails `tsc`.
    function describeState(state: QueueLifecycleState): string {
      switch (state) {
        case 'pending':
          return QUEUE_LIFECYCLE_LABELS.pending;
        case 'queued':
          return QUEUE_LIFECYCLE_LABELS.queued;
        case 'processing':
          return QUEUE_LIFECYCLE_LABELS.processing;
        case 'materialized':
          return QUEUE_LIFECYCLE_LABELS.materialized;
        case 'anchored':
          return QUEUE_LIFECYCLE_LABELS.anchored;
        case 'failed':
          return QUEUE_LIFECYCLE_LABELS.failed;
        case 'skipped':
          return QUEUE_LIFECYCLE_LABELS.skipped;
        default: {
          const never: never = state;
          return never;
        }
      }
    }
    for (const state of QUEUE_LIFECYCLE_STATES) {
      expect(describeState(state)).toBe(QUEUE_LIFECYCLE_LABELS[state]);
    }
  });

  it('isQueueLifecycleState narrows known values and rejects unknown ones', () => {
    expect(isQueueLifecycleState('anchored')).toBe(true);
    expect(isQueueLifecycleState('SECURED')).toBe(false);
    expect(isQueueLifecycleState('')).toBe(false);
    expect(isQueueLifecycleState(undefined)).toBe(false);
  });
});

describe('credit-debit touchpoint contract', () => {
  it('enumerates the three credit-debit states', () => {
    expect(CREDIT_DEBIT_STATES).toEqual(['spent', 'pending', 'refunded']);
  });

  it('labels every credit-debit state exactly once (1:1 with the ledger model)', () => {
    const labelled = Object.keys(CREDIT_DEBIT_LABELS).sort();
    const expected = [...CREDIT_DEBIT_STATES].sort();
    expect(labelled).toEqual(expected);
    for (const state of CREDIT_DEBIT_STATES) {
      expect(CREDIT_DEBIT_LABELS[state as CreditDebitState]).toBeTruthy();
    }
  });

  it('charges at SECURING, never at queueing', () => {
    // The load-bearing money rule (PRD AC: "Queueing does not consume credits").
    expect(CREDIT_DEBIT_TIMING).toBe('on_securing');
  });
});

describe('securing-path exposure contract (launch posture)', () => {
  it('defines exactly the queue-first and instant paths', () => {
    expect(SECURING_PATHS).toEqual(['queue', 'instant']);
  });

  it('exposes ONLY the queue path by default (instant-secure hidden at launch)', () => {
    // AC: "Secure Instantly is hidden if backend processor/credit gate is
    // disabled." The contract default is queue-first only — instant is absent
    // (not greyed) until the server capability turns it on.
    expect(INSTANT_SECURE_DEFAULT_EXPOSED).toBe(false);
  });

  it('labels both securing-choice paths so the UI can name them when enabled', () => {
    for (const path of SECURING_PATHS) {
      expect(SECURING_CHOICE_LABELS[path as SecuringPath]).toBeTruthy();
    }
  });
});

describe('queue-surface disambiguation (premortem: no duplicate page titles)', () => {
  it('names the three distinct queue concepts', () => {
    expect(QUEUE_SURFACES).toEqual([
      'consumer_secure_queue',
      'org_duplicate_review',
      'org_approvals',
    ]);
  });

  it('gives each surface a distinct, non-colliding page title', () => {
    const titles = QUEUE_SURFACES.map((s) => QUEUE_SURFACE_TITLES[s as QueueSurface]);
    for (const t of titles) expect(t).toBeTruthy();
    expect(new Set(titles).size).toBe(titles.length);
    // None of the new surface titles reuse the ambiguous legacy "Review queue".
    expect(QUEUE_SURFACE_TITLES.consumer_secure_queue).not.toMatch(/^Review queue$/i);
  });
});

describe('SECURE_QUEUE_LABELS copy block', () => {
  it('provides the consumer secure-queue surface copy', () => {
    expect(SECURE_QUEUE_LABELS.PAGE_TITLE).toBeTruthy();
    expect(SECURE_QUEUE_LABELS.EMPTY_TITLE).toBeTruthy();
    expect(SECURE_QUEUE_LABELS.ADD_TO_QUEUE).toBeTruthy();
  });
});
