/**
 * RED-FIRST proof of the SILENT-WRITE CLASS for audit events.
 *
 * The recorder in `test-utils/lazy-supabase-builder.ts` records a payload ONLY
 * when `.then()` is called — the exact seam a `mockReturnThis()` or a
 * resolved-Promise mock erases. `voidDiscardsTheBuilder` below reproduces the
 * shipped bug against that same recorder, so these tests demonstrate the defect
 * rather than merely asserting the fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLazyBuilderRecorder } from '../test-utils/lazy-supabase-builder.js';

const recorder = createLazyBuilderRecorder({ data: null, error: null });
const insert = vi.fn((payload: Record<string, unknown>) => recorder.build(payload));

vi.mock('./db.js', () => ({
  db: { from: vi.fn(() => ({ insert: (p: Record<string, unknown>) => insert(p) })) },
}));

const loggerError = vi.fn();
vi.mock('./logger.js', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), info: vi.fn() },
}));

const { recordAuditEvent } = await import('./auditEvent.js');
const { db } = await import('./db.js');

/** The shipped bug: build the query, discard it, never call `.then()`. */
function voidDiscardsTheBuilder(row: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reproducing the defect
  void (db as any).from('audit_events').insert(row);
}

const ROW = { event_type: 'VERIFICATION_QUERIED', target_id: 'ARK-TEST-000001' };

describe('audit_events silent-write class', () => {
  beforeEach(() => {
    recorder.reset();
    insert.mockClear();
    loggerError.mockClear();
  });

  it('reproduces the defect: a discarded builder issues NO request', () => {
    voidDiscardsTheBuilder(ROW);

    // The builder was constructed — which is why a mockReturnThis-style double
    // reports success and the bug ships.
    expect(insert).toHaveBeenCalledTimes(1);
    // But nothing was ever sent.
    expect(recorder.executed).toEqual([]);
  });

  it('recordAuditEvent actually issues the request', async () => {
    await recordAuditEvent(ROW);

    expect(recorder.executed).toEqual([ROW]);
  });

  it('reports a failed audit write instead of swallowing it', async () => {
    const failing = createLazyBuilderRecorder({ data: null, error: { message: 'boom' } });
    insert.mockImplementationOnce((p) => failing.build(p));

    await recordAuditEvent(ROW);

    expect(loggerError).toHaveBeenCalledTimes(1);
    const [ctx, msg] = loggerError.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx.eventType).toBe('VERIFICATION_QUERIED');
    expect(msg).toMatch(/audit trail incomplete/);
  });

  it('never rejects, so a floating call cannot become an unhandled rejection', async () => {
    const throwing = {
      then: (_ok?: unknown, onrejected?: (r: unknown) => unknown) =>
        Promise.resolve(onrejected?.(new Error('transport failed'))),
    };
    insert.mockImplementationOnce(() => throwing as never);

    await expect(recordAuditEvent(ROW)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  // ── SYNCHRONOUS failure, which is what actually reaches the caller ─────────
  //
  // The async guarantee above is the easy half. `recordAuditEvent` is called as
  // `void recordAuditEvent(...)` from inside a request handler, so anything it
  // throws SYNCHRONOUSLY propagates straight out of the handler and 500s the
  // user's request — the exact outcome the module docstring says must never
  // happen ("A failed audit write must not fail the user's request"). Two
  // shapes reach that path, and both were live:
  //
  //   1. `.insert()` throws outright.
  //   2. `.insert()` returns a NON-THENABLE, so calling `.then()` on it throws
  //      `TypeError: ....then is not a function`. This is not hypothetical —
  //      it is the shape of every unlisted table in the api-e2e supabase
  //      double, and it took `GET /api/v1/verify/:publicId` from 200 to 500.
  //
  // A fire-and-forget writer that can kill the request it is auditing is a
  // guard that only looks like it works.

  it('does not throw when the query builder throws synchronously', async () => {
    insert.mockImplementationOnce(() => {
      throw new Error('client not initialised');
    });

    await expect(recordAuditEvent(ROW)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [ctx] = loggerError.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.eventType).toBe('VERIFICATION_QUERIED');
  });

  it('does not throw when the builder is not thenable (api-e2e double shape)', async () => {
    // No `.then` anywhere on the returned object — `.then()` is a TypeError.
    insert.mockImplementationOnce(() => ({ select: () => ({}) }) as never);

    await expect(recordAuditEvent(ROW)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [ctx] = loggerError.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.eventType).toBe('VERIFICATION_QUERIED');
  });

  it('a synchronous failure is still reported, never silently dropped', async () => {
    insert.mockImplementationOnce(() => {
      throw new Error('client not initialised');
    });

    await recordAuditEvent(ROW);

    const [, msg] = loggerError.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatch(/audit trail incomplete/);
  });
});
