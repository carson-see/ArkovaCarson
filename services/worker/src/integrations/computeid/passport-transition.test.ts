/**
 * The DLQ contract shared by both `passport.*` producers (SCRUM-4495).
 *
 * `enqueue_computeid_failure` (migration 0448) RAISEs 22023 unless
 * `p_payload_hash` is exactly 64 lowercase hex. `recordPassportFailure` cannot
 * re-raise — the DLQ is the diagnostic of last resort, not the operation — so
 * a producer that gets the shape wrong loses EVERY failure row silently. The
 * re-check job shipped with a `recheck:<iso>` marker and would have done
 * exactly that, including for `revocation_authority_failed`: tombstone not
 * written, API keys left live, nothing durable to page on.
 *
 * These tests enforce the RPC's real regex against the mock, so a producer
 * that stops minting a sha256 fails here rather than in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
vi.mock('../../utils/db.js', () => ({ db: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const captureMessage = vi.fn();
vi.mock('../../utils/sentry.js', () => ({ Sentry: { captureMessage: (...a: unknown[]) => captureMessage(...a) } }));

const { recordPassportFailure, payloadHashOf, PAYLOAD_HASH_RE } = await import('./passport-transition.js');

/** The migration's own guard, so the mock cannot be more permissive than prod. */
function enforceRpcContract(_name: string, args: Record<string, unknown>) {
  const hash = args.p_payload_hash;
  const reason = args.p_reason;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)
    || typeof reason !== 'string' || reason.length < 1 || reason.length > 500) {
    return { data: null, error: { code: '22023', message: 'invalid ComputeID failure record' } };
  }
  return { data: true, error: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => enforceRpcContract(name, args));
});

describe('payloadHashOf', () => {
  it('produces the only shape the DLQ accepts', () => {
    expect(payloadHashOf('b390e5e6:recheck:2026-09-12T12:00:00.000Z')).toMatch(PAYLOAD_HASH_RE);
  });

  it('is stable and distinguishes inputs, so the (payload_hash, reason) dedupe key stays per-passport', () => {
    expect(payloadHashOf('a')).toBe(payloadHashOf('a'));
    expect(payloadHashOf('a')).not.toBe(payloadHashOf('b'));
  });
});

describe('recordPassportFailure', () => {
  it('lands a row when the hash honours the contract', async () => {
    await recordPassportFailure({
      reason: 'recheck_transition_failed:passport.revoked',
      externalId: 'b390e5e6-c79d-4f02-9a42-212494b1fd44',
      payloadHash: payloadHashOf('run-1'),
    });
    expect(rpcMock).toHaveBeenCalledWith('enqueue_computeid_failure', expect.objectContaining({
      p_payload_hash: expect.stringMatching(PAYLOAD_HASH_RE),
    }));
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('raises an alert when the DLQ REJECTS the row — a lost failure row is itself an incident', async () => {
    await recordPassportFailure({
      reason: 'revocation_authority_failed',
      externalId: null,
      payloadHash: 'recheck:2026-09-12T12:00:00.000Z',
    });
    expect(captureMessage).toHaveBeenCalledWith(
      'ComputeID: DLQ insert rejected',
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('alerts when the RPC throws outright, and never carries partner bytes into the alert', async () => {
    rpcMock.mockRejectedValueOnce(new Error('connection reset'));
    await recordPassportFailure({ reason: 'agent_lookup_failed', externalId: null, payloadHash: payloadHashOf('x') });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [, opts] = captureMessage.mock.calls[0] as [string, { extra?: Record<string, unknown> }];
    expect(opts.extra).toEqual({ reason: 'agent_lookup_failed' });
  });

  it('never throws — the DLQ is a diagnostic, not the operation', async () => {
    rpcMock.mockRejectedValueOnce(new Error('boom'));
    await expect(recordPassportFailure({ reason: 'r', externalId: null, payloadHash: 'nope' })).resolves.toBeUndefined();
  });
});
