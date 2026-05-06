/**
 * Drive push-notification webhook handler tests (SCRUM-1099, SCRUM-1211).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbFromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => dbFromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}));

import { driveWebhookRouter } from './drive.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/drive', driveWebhookRouter);
  return app;
}

function lookupChain(row: { org_id: string; integration_id: string; channel_token: string | null } | null, error: unknown = null) {
  // Match the on-disk row shape: account_label is a JSON string holding the
  // channel_token until a dedicated column lands in a follow-up migration.
  const dbRow = row && {
    org_id: row.org_id,
    id: row.integration_id,
    account_label: row.channel_token === null ? null : JSON.stringify({ channel_token: row.channel_token }),
  };
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: dbRow, error }),
  };
}

// SCRUM-1242: drive_webhook_nonces insert mock.
function nonceInsert(error: { code?: string } | null = null) {
  return {
    insert: vi.fn().mockResolvedValue({ error }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbFromMock.mockReset(); // SCRUM-1242: clearAllMocks doesn't clear mockReturnValueOnce queue.
  rpcMock.mockResolvedValue({ data: 'rule-1', error: null });
});

describe('POST /webhooks/drive (SCRUM-1211 fail-closed channel-token)', () => {
  it('rejects when channel id header is missing', async () => {
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Resource-State', 'change');
    expect(res.status).toBe(400);
  });

  it('200s the sync handshake without DB lookup', async () => {
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-1')
      .set('X-Goog-Resource-State', 'sync');
    expect(res.status).toBe(200);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('200s and skips an unknown channel id', async () => {
    dbFromMock.mockReturnValueOnce({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-orphan')
      .set('X-Goog-Resource-State', 'change')
      .set('X-Goog-Channel-Token', 'anything');
    expect(res.status).toBe(200);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('SCRUM-1211: 401 when stored channel_token is missing (fail closed, was previously accepted)', async () => {
    dbFromMock.mockReturnValueOnce(lookupChain({
      org_id: 'org-1',
      integration_id: 'int-1',
      channel_token: null,
    }));
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-1')
      .set('X-Goog-Resource-State', 'change')
      .set('X-Goog-Channel-Token', 'anything');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('integration_missing_channel_token');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('SCRUM-1211: 401 when caller omits X-Goog-Channel-Token header', async () => {
    dbFromMock.mockReturnValueOnce(lookupChain({
      org_id: 'org-1',
      integration_id: 'int-1',
      channel_token: 'expected-token',
    }));
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-1')
      .set('X-Goog-Resource-State', 'change');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_channel_token');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('SCRUM-1211: 401 when channel-token mismatches stored value', async () => {
    dbFromMock.mockReturnValueOnce(lookupChain({
      org_id: 'org-1',
      integration_id: 'int-1',
      channel_token: 'expected-token',
    }));
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-1')
      .set('X-Goog-Resource-State', 'change')
      .set('X-Goog-Channel-Token', 'attacker-token');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_channel_token');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  // SCRUM-1661: post-runner-wiring, the webhook is a 200-only ack at-rest
  // (ENABLE_DRIVE_CHANGES_RUNNER defaults to disabled). The runner's
  // changes.list → enqueue_rule_event flow is exercised separately in
  // drive-changes-runner.test.ts. This test only verifies that a valid
  // channel-token + nonce write produces 200 without touching the
  // legacy stub-event enqueue.
  it('200s on valid channel-token + nonce write (runner disabled at rest)', async () => {
    dbFromMock.mockReturnValueOnce(lookupChain({
      org_id: 'org-1',
      integration_id: 'int-1',
      channel_token: 'expected-token',
    }));
    dbFromMock.mockReturnValueOnce(nonceInsert(null)); // SCRUM-1242
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-1')
      .set('X-Goog-Resource-State', 'change')
      .set('X-Goog-Channel-Token', 'expected-token')
      .set('X-Goog-Message-Number', '42');
    expect(res.status).toBe(200);
    // Legacy stub event no longer fires from the handler — the runner
    // (when enabled) is the only path that calls enqueue_rule_event.
    expect(rpcMock).not.toHaveBeenCalledWith('enqueue_rule_event', expect.anything());
  });

  // SCRUM-1242 (AUDIT-0424-26): Drive replay protection. Drive doesn't carry
  // an HMAC, so we dedupe on (channel_id, message_number) — Google's
  // monotonic per-channel counter is the canonical replay-detection signal.
  it('SCRUM-1242: 200s without enqueue when nonce already present (replay)', async () => {
    dbFromMock.mockReturnValueOnce(lookupChain({
      org_id: 'org-1',
      integration_id: 'int-1',
      channel_token: 'expected-token',
    }));
    // Postgres unique_violation — already saw (chan-1, 42).
    dbFromMock.mockReturnValueOnce(nonceInsert({ code: '23505' }));

    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-1')
      .set('X-Goog-Resource-State', 'change')
      .set('X-Goog-Channel-Token', 'expected-token')
      .set('X-Goog-Message-Number', '42');

    expect(res.status).toBe(200);
    // Critical: no rule-event enqueue on replay.
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('SCRUM-1242: writes nonce row keyed on (channel_id, message_number)', async () => {
    dbFromMock.mockReturnValueOnce(lookupChain({
      org_id: 'org-1',
      integration_id: 'int-1',
      channel_token: 'expected-token',
    }));
    const nonceMock = nonceInsert(null);
    dbFromMock.mockReturnValueOnce(nonceMock);

    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-99')
      .set('X-Goog-Resource-State', 'change')
      .set('X-Goog-Channel-Token', 'expected-token')
      .set('X-Goog-Message-Number', '7');

    expect(res.status).toBe(200);
    expect(nonceMock.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'chan-99',
        message_number: 7,
      }),
    );
  });
});
