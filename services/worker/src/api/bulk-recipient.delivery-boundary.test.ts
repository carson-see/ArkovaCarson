import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  send: vi.fn(),
  claims: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  duplicate: false,
}));

vi.mock('../config.js', () => ({ config: {
  nodeEnv: 'production', resendApiKey: 'fixture-key', emailFrom: 'test@arkova.invalid',
  frontendUrl: 'https://fixture.arkova.invalid',
} }));
vi.mock('../utils/logger.js', () => ({ logger: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
} }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
vi.mock('resend', () => ({ Resend: class {
  emails = { send: state.send };
} }));
vi.mock('../utils/db.js', () => ({ db: { from: (table: string) => {
  if (table === 'audit_events') return { insert: vi.fn().mockResolvedValue({ error: null }) };
  if (table !== 'recipient_activation_deliveries') throw new Error(`Unexpected table: ${table}`);
  return {
    insert: async (value: Record<string, unknown>) => {
      state.claims.push(value);
      return { error: state.duplicate ? { code: '23505' } : null };
    },
    update: (value: Record<string, unknown>) => {
      state.updates.push(value);
      const result = Object.assign(Promise.resolve({ error: null }), { eq: () => result });
      return result;
    },
    select: () => {
      const query = { eq: () => query, maybeSingle: async () => ({ data: { status: 'sending' }, error: null }) };
      return query;
    },
  };
} } }));

import { _resetClient } from '../email/sender.js';
import { deliverBulkActivationOnce } from './bulk-recipient.js';

const input = {
  profileId: 'fixture-profile', activationToken: 'a'.repeat(64),
  email: 'recipient@fixture.invalid', actorUserId: 'fixture-actor', orgId: null,
};

describe('bulk activation through the real email wrapper', () => {
  beforeEach(() => {
    state.send.mockReset(); state.claims = []; state.updates = []; state.duplicate = false;
    _resetClient();
  });

  it.each(['throw', 'sdk-error', 'server-error', 'conflict', 'missing-ack'])('holds uncertain %s outcomes without automatic resend', async (mode) => {
    if (mode === 'throw') state.send.mockRejectedValue(new Error('connection lost'));
    else if (mode === 'missing-ack') state.send.mockResolvedValue({ data: null, error: null });
    else state.send.mockResolvedValue({ data: null, error: {
      message: 'Delivery cannot be confirmed', name: 'application_error',
      ...(mode === 'server-error' ? { statusCode: 500 } : mode === 'conflict' ? { statusCode: 409 } : {}),
    } });
    await expect(deliverBulkActivationOnce(input)).rejects.toThrow('recipient_activation_delivery_pending');
    expect(state.claims).toHaveLength(1);
    expect(state.updates).toEqual([]);
    state.duplicate = true;
    await expect(deliverBulkActivationOnce(input)).rejects.toThrow('recipient_activation_delivery_pending');
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it('records an explicit request rejection as failed', async () => {
    state.send.mockResolvedValue({ data: null, error: { message: 'Invalid request', statusCode: 422 } });
    await expect(deliverBulkActivationOnce(input)).rejects.toThrow('recipient_activation_email_failed');
    expect(state.updates).toEqual([expect.objectContaining({ status: 'failed', failure_code: 'provider_rejected' })]);
  });

  it('records an acknowledged send as sent', async () => {
    state.send.mockResolvedValue({ data: { id: 'fixture-message' }, error: null });
    await deliverBulkActivationOnce(input);
    expect(state.updates).toEqual([expect.objectContaining({ status: 'sent', failure_code: null })]);
  });
});
