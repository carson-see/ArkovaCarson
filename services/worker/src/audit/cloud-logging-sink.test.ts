import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../utils/gcp-auth.js', () => ({
  hasGcpCredential: vi.fn().mockReturnValue(true),
  getGcpAccessToken: vi.fn().mockResolvedValue('mock-token'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { writeAuditBatch, type AuditLogEntry } from './cloud-logging-sink.js';

const sampleEntry: AuditLogEntry = {
  id: 'ae-1',
  event_type: 'anchor.secured',
  event_category: 'ANCHOR',
  actor_id: 'user-1',
  org_id: 'org-1',
  target_type: 'anchor',
  target_id: 'a-1',
  details: JSON.stringify({ fingerprint: 'abc123' }),
  created_at: '2026-04-24T00:00:00Z',
};

describe('writeAuditBatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty set for empty input', async () => {
    const result = await writeAuditBatch([]);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('writes entries to Cloud Logging and returns their IDs', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    const result = await writeAuditBatch([sampleEntry]);
    expect(result.size).toBe(1);
    expect(result.has('ae-1')).toBe(true);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://logging.googleapis.com/v2/entries:write');
    expect(options.headers.Authorization).toBe('Bearer mock-token');

    const body = JSON.parse(options.body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].insertId).toBe('ae-1');
    expect(body.entries[0].severity).toBe('INFO');
    expect(body.entries[0].jsonPayload.event_type).toBe('anchor.secured');
  });

  it('returns empty set on Cloud Logging failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
    });

    const result = await writeAuditBatch([sampleEntry]);
    expect(result.size).toBe(0);
  });

  it('maps REVOKED events to WARNING severity', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    const revokedEntry: AuditLogEntry = {
      ...sampleEntry,
      id: 'ae-2',
      event_type: 'anchor.revoked',
    };
    await writeAuditBatch([revokedEntry]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.entries[0].severity).toBe('WARNING');
  });

  it('handles non-JSON details gracefully', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    const badEntry: AuditLogEntry = {
      ...sampleEntry,
      id: 'ae-3',
      details: 'not valid json',
    };
    await writeAuditBatch([badEntry]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.entries[0].jsonPayload.details).toEqual({ raw: 'not valid json' });
  });
});
