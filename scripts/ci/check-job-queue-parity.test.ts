/**
 * Tests for the job_queue producer/consumer parity guard.
 *
 * The guard exists because the worker has NO central job dispatcher: a
 * `job_queue` type is handled if and only if some file happens to call
 * `claimJob` / `processNextJob` with that same string. Two produced types
 * shipped with zero consumers and neither produced any error signal — one of
 * them (`anchor.fast_track`) charged the customer a credit first.
 *
 * These tests pin the guard's pure decision function, then run it against the
 * real worker tree so the invariant is a live ratchet, not a unit-test toy.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  QUEUE_INTERNALS_ALLOWLIST,
  loadWorkerSources,
  runJobQueueParityCheck,
  scanJobQueueUsage,
} from './check-job-queue-parity.js';

function sources(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('scanJobQueueUsage', () => {
  it('resolves a string-literal producer and consumer into a matched pair', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/api/produce.ts': `
        import { submitJob } from '../utils/jobQueue.js';
        await submitJob({ type: 'thing.happened', payload: {} });
      `,
      'services/worker/src/jobs/consume.ts': `
        import { processNextJob } from '../utils/jobQueue.js';
        await processNextJob('thing.happened', async () => {});
      `,
    }));

    expect(scan.producers.map((p) => p.type)).toEqual(['thing.happened']);
    expect(scan.consumers.map((c) => c.type)).toEqual(['thing.happened']);
    expect(runJobQueueParityCheck(scan).ok).toBe(true);
  });

  it('resolves an identifier constant to its literal (the repo convention)', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/jobs/types.ts': `
        export const WIDGET_JOB_TYPE = 'widget.built';
      `,
      'services/worker/src/api/produce.ts': `
        import { WIDGET_JOB_TYPE } from '../jobs/types.js';
        await submitJob({ type: WIDGET_JOB_TYPE, payload: {} });
      `,
      'services/worker/src/jobs/consume.ts': `
        import { WIDGET_JOB_TYPE } from './types.js';
        const job = await claimJob(WIDGET_JOB_TYPE);
      `,
    }));

    expect(scan.producers[0]?.type).toBe('widget.built');
    expect(scan.consumers[0]?.type).toBe('widget.built');
    expect(runJobQueueParityCheck(scan).ok).toBe(true);
  });

  // The repo declares every job-type constant as `= '...' as const`. The first
  // run of this guard failed closed on all three of them because the resolver
  // did not unwrap the AsExpression — the guard caught its own blind spot.
  it('resolves an `as const` constant, the form the repo actually uses', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/jobs/types.ts': `
        export const WIDGET_JOB_TYPE = 'widget.built' as const;
      `,
      'services/worker/src/api/produce.ts': `
        await submitJob({ type: WIDGET_JOB_TYPE, payload: {} });
      `,
      'services/worker/src/jobs/consume.ts': `
        await claimJob(WIDGET_JOB_TYPE);
      `,
    }));

    expect(scan.producers[0]?.type).toBe('widget.built');
    expect(scan.consumers[0]?.type).toBe('widget.built');
    expect(runJobQueueParityCheck(scan).ok).toBe(true);
  });

  it('treats a name bound to two different literals as unresolvable, not as a coin flip', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/jobs/a.ts': `export const JOB_TYPE = 'a.type';`,
      'services/worker/src/jobs/b.ts': `export const JOB_TYPE = 'b.type';`,
      'services/worker/src/api/produce.ts': `await submitJob({ type: JOB_TYPE, payload: {} });`,
      'services/worker/src/jobs/consume.ts': `await claimJob('a.type');`,
    }));

    expect(scan.producers[0]?.type).toBeNull();
    expect(runJobQueueParityCheck(scan).ok).toBe(false);
  });

  it('ignores test files — a mocked drain is not a consumer', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/api/produce.ts': `
        await submitJob({ type: 'only.in.tests', payload: {} });
      `,
      'services/worker/src/api/produce.test.ts': `
        await processNextJob('only.in.tests', async () => {});
      `,
      'services/worker/src/jobs/__tests__/helper.ts': `
        await claimJob('only.in.tests');
      `,
    }));

    expect(scan.consumers).toHaveLength(0);
    expect(runJobQueueParityCheck(scan).ok).toBe(false);
  });
});

describe('runJobQueueParityCheck', () => {
  it('FAILS on a produced type with no consumer, naming the type and the enqueue site', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/jobs/dispatcher.ts': `
        await submitJob({ type: 'anchor.fast_track', payload: {} });
      `,
      'services/worker/src/jobs/consume.ts': `
        await processNextJob('other.type', async () => {});
      `,
      'services/worker/src/api/produce.ts': `
        await submitJob({ type: 'other.type', payload: {} });
      `,
    }));

    const result = runJobQueueParityCheck(scan);

    expect(result.ok).toBe(false);
    const text = result.lines.join('\n');
    expect(text).toContain('anchor.fast_track');
    expect(text).toContain('services/worker/src/jobs/dispatcher.ts');
  });

  it('FAILS on a consumed type nothing produces — a drain wired to nothing', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/api/produce.ts': `
        await submitJob({ type: 'real.type', payload: {} });
      `,
      'services/worker/src/jobs/consume.ts': `
        await processNextJob('real.type', async () => {});
        await claimJob('ghost.type');
      `,
    }));

    const result = runJobQueueParityCheck(scan);

    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('ghost.type');
  });

  it('FAILS CLOSED when a type expression cannot be resolved to a literal', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/api/produce.ts': `
        await submitJob({ type: buildTypeName(kind), payload: {} });
      `,
      'services/worker/src/jobs/consume.ts': `
        await processNextJob('real.type', async () => {});
      `,
    }));

    expect(scan.producers[0]?.type).toBeNull();
    const result = runJobQueueParityCheck(scan);
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('could not be resolved');
  });

  it('FAILS CLOSED on an empty scan rather than reporting "no drift" from nothing', () => {
    const empty = scanJobQueueUsage(sources({
      'services/worker/src/utils/nothing.ts': 'export const x = 1;',
    }));

    const result = runJobQueueParityCheck(empty);

    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/no .*(producers|consumers)/i);
  });

  it('FAILS when a module writes job_queue directly, bypassing submitJob entirely', () => {
    const scan = scanJobQueueUsage(sources({
      'services/worker/src/api/produce.ts': `
        await submitJob({ type: 'real.type', payload: {} });
        await db.from('job_queue').insert({ type: 'sneaky.type', status: 'pending' });
      `,
      'services/worker/src/jobs/consume.ts': `
        await processNextJob('real.type', async () => {});
      `,
    }));

    const result = runJobQueueParityCheck(scan);

    expect(result.ok).toBe(false);
    const text = result.lines.join('\n');
    expect(text).toContain('services/worker/src/api/produce.ts');
    expect(text).toMatch(/submitJob/);
  });

  it('allows direct job_queue access from the queue-internals modules (leases, checkpoints)', () => {
    expect(QUEUE_INTERNALS_ALLOWLIST).toContain('services/worker/src/utils/jobQueue.ts');
    expect(QUEUE_INTERNALS_ALLOWLIST).toContain('services/worker/src/jobs/run-lease.ts');
    expect(QUEUE_INTERNALS_ALLOWLIST).toContain('services/worker/src/jobs/proofJobCheckpoint.ts');

    const scan = scanJobQueueUsage(sources({
      'services/worker/src/utils/jobQueue.ts': `
        await db.from('job_queue').insert({ type, status: 'pending' });
      `,
      'services/worker/src/jobs/run-lease.ts': `
        await db.from('job_queue').update({ status: 'processing' });
      `,
      'services/worker/src/api/produce.ts': `
        await submitJob({ type: 'real.type', payload: {} });
      `,
      'services/worker/src/jobs/consume.ts': `
        await processNextJob('real.type', async () => {});
      `,
    }));

    expect(scan.unmanagedTableAccess).toHaveLength(0);
    expect(runJobQueueParityCheck(scan).ok).toBe(true);
  });
});

describe('live worker tree', () => {
  // Walking and regex-scanning the whole worker tree (~1,200 files, ~16 MB) is
  // real work that grows with the repo, so scan ONCE for the block instead of
  // per-test, and give it an explicit budget.
  //
  // Vitest's 5s default is a repo-size tripwire, not a correctness signal: this
  // block passed in isolation but timed out in CI under full-suite parallelism
  // (426 files) once `main` grew. The assertions below are unchanged — only the
  // time allowance is, so a genuine parity break still fails the build.
  let scan: ReturnType<typeof scanJobQueueUsage>;

  beforeAll(() => {
    scan = scanJobQueueUsage(loadWorkerSources());
  }, 60_000);

  it('every enqueued job_queue type has a real consumer', () => {
    const result = runJobQueueParityCheck(scan);

    // Print the guard's own diagnosis on failure — the assertion message alone
    // would not name the orphaned type.
    expect(result.lines.join('\n')).toBeTruthy();
    expect(result.ok).toBe(true);
  });

  it('finds the known job types (guard is reading the real tree, not an empty set)', () => {
    const produced = new Set(scan.producers.map((p) => p.type));

    expect(produced).toContain('docusign.envelope_completed');
    expect(produced).toContain('google_drive.file_changed');
    expect(produced).toContain('professional_education.metadata_extraction');
    expect(produced).toContain('ai_credits.reconcile_refund');
  });
});
