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

beforeEach(() => {
  vi.clearAllMocks();
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

  it('200s and enqueues a rule event when channel-token matches', async () => {
    dbFromMock.mockReturnValueOnce(lookupChain({
      org_id: 'org-1',
      integration_id: 'int-1',
      channel_token: 'expected-token',
    }));
    const res = await request(createApp())
      .post('/webhooks/drive')
      .set('X-Goog-Channel-ID', 'chan-1')
      .set('X-Goog-Resource-State', 'change')
      .set('X-Goog-Channel-Token', 'expected-token');
    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith('enqueue_rule_event', expect.objectContaining({
      p_org_id: 'org-1',
    }));
  });
});
