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
const agentEventMock = vi.fn();
vi.mock('../../utils/db.js', () => ({ db: { rpc: (...a: unknown[]) => rpcMock(...a) } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const captureMessage = vi.fn();
vi.mock('../../utils/sentry.js', () => ({ Sentry: { captureMessage: (...a: unknown[]) => captureMessage(...a) } }));
vi.mock('../../webhooks/agentEvents.js', () => ({
  emitAgentEvent: (...a: unknown[]) => agentEventMock(...a), hintAgentWebhookDrain: vi.fn(),
}));

const { recordPassportFailure, payloadHashOf, PAYLOAD_HASH_RE, applyPassportEventToAgent } = await import('./passport-transition.js');

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

describe('provider transition notification outcome', () => {
  const metadata = { computeid: { issuer: 'computeid', passport_id: '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f', bound_at: '2026-09-07T09:00:00.000Z', receipt_expires_at: '2026-09-08T09:00:00.000Z' } };
  const agent = { id: '22222222-2222-4222-8222-222222222222', org_id: '11111111-1111-4111-8111-111111111111', name: 'agent', status: 'active' as const, metadata };
  const delivery = { event: 'passport.suspended' as const, passportId: '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f', timestamp: '2026-09-07T10:00:00.000Z', payloadHash: payloadHashOf('provider-event') };
  it('uses the transactional outbox wrapper for an applied transition', async () => {
    rpcMock.mockResolvedValueOnce({ data: { applied: true }, error: null });
    expect(await applyPassportEventToAgent(agent, delivery)).toEqual({ outcome: 'applied' });
    expect(rpcMock).toHaveBeenCalledWith('apply_computeid_agent_transition_with_outbox',
      expect.objectContaining({ p_emit_event_type: 'agent.updated' }));
    expect(agentEventMock).not.toHaveBeenCalled();
  });
  it('uses the terminal agent identity for provider revocation', async () => {
    rpcMock.mockResolvedValueOnce({ data: { applied: true }, error: null });
    await applyPassportEventToAgent(agent, { ...delivery, event: 'passport.revoked' });
    expect(rpcMock).toHaveBeenCalledWith('apply_computeid_agent_transition_with_outbox',
      expect.objectContaining({ p_emit_event_type: 'agent.revoked' }));
    expect(agentEventMock).not.toHaveBeenCalled();
  });
  it('does not emit for skipped, conflict, or failed transitions', async () => {
    const stale = { ...agent, status: 'suspended' as const, metadata: { computeid: { ...metadata.computeid, suspended_by: 'computeid', last_event: 'passport.suspended', last_event_at: delivery.timestamp } } };
    expect((await applyPassportEventToAgent(stale, delivery)).outcome).toBe('skipped');
    rpcMock.mockResolvedValueOnce({ data: { applied: false }, error: null });
    expect((await applyPassportEventToAgent(agent, delivery)).outcome).toBe('conflict');
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'failed' } });
    expect((await applyPassportEventToAgent(agent, delivery)).outcome).toBe('failed');
    expect(agentEventMock).not.toHaveBeenCalled();
  });
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
