/**
 * Audit Log Tests
 *
 * SCRUM-1270 (R2-7): browser writes to `audit_events` are no longer permitted
 * directly (migration 0277 dropped the authenticated INSERT policy). Tests
 * pin the new fetch-based path through `POST /api/audit/event`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'https://worker.test',
}));

import { logAuditEvent } from './auditLog';

describe('logAuditEvent', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the event to /api/audit/event with the bearer token', async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'jwt-token-123' } },
    });

    await logAuditEvent({
      eventType: 'ANCHOR_CREATED',
      eventCategory: 'ANCHOR',
      targetType: 'anchor',
      targetId: 'anchor-1',
      orgId: 'org-1',
      details: 'Created anchor',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://worker.test/api/audit/event');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer jwt-token-123',
    });
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body)).toEqual({
      event_type: 'ANCHOR_CREATED',
      event_category: 'ANCHOR',
      target_type: 'anchor',
      target_id: 'anchor-1',
      org_id: 'org-1',
      details: 'Created anchor',
    });
  });

  it('skips the request entirely when there is no session (logged-out user)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await logAuditEvent({ eventType: 'PAGE_VIEW', eventCategory: 'AUTH' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when getSession rejects (auth service down)', async () => {
    mockGetSession.mockRejectedValue(new Error('Auth service down'));
    await expect(
      logAuditEvent({ eventType: 'ANCHOR_CREATED', eventCategory: 'ANCHOR' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when fetch rejects (worker unreachable)', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    fetchMock.mockRejectedValue(new Error('network error'));
    await expect(
      logAuditEvent({ eventType: 'LOGIN', eventCategory: 'AUTH' }),
    ).resolves.toBeUndefined();
  });

  it('fills optional fields with null when not provided', async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    await logAuditEvent({ eventType: 'LOGIN', eventCategory: 'AUTH' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      target_type: null,
      target_id: null,
      org_id: null,
      details: null,
    });
  });
});
