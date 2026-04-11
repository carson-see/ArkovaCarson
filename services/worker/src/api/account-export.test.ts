/**
 * Data Subject Rights — Access + Portability (REG-11 / SCRUM-572)
 *
 * Tests for handleAccountExport. GDPR Art. 15 (access), Art. 20 (portability),
 * Kenya DPA s. 31, Australia APP 12, South Africa POPIA s. 23, Nigeria NDPA.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { handleAccountExport, type AccountExportDeps } from './account-export.js';

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockReq(): Request {
  return {} as Request;
}

/**
 * Build a Supabase client double that returns canned data for each table the
 * exporter reads. Every `.from(table)` call returns a chained builder whose
 * terminal method resolves to the canned payload for that table.
 */
function mockDb(tables: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) => {
      const payload = tables[table] ?? [];
      // Terminal: both list queries in account-export.ts end with `.limit(N)`,
      // so we make .limit() resolve to the payload directly. The intermediate
      // methods (.select, .eq, .is, .order) chain via mockReturnThis so the
      // caller can compose them freely.
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        // .limit() is the terminal call — it returns a Promise directly
        // instead of a thenable object (SonarCloud typescript:S7739).
        limit: vi.fn().mockResolvedValue({ data: payload, error: null }),
        // .single() is the terminal for profile / single-row reads
        single: vi.fn().mockResolvedValue({
          data: Array.isArray(payload) ? payload[0] : payload,
          error: null,
        }),
        // `.insert(...).select().single()` chain for data_subject_requests
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'dsr-test-id' },
              error: null,
            }),
          }),
        }),
        // `.update(...).eq(...)` chain for marking request completed
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      };
      return builder;
    }),
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
  };
}

describe('handleAccountExport', () => {
  let deps: AccountExportDeps;
  let rpcMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rpcMock = vi.fn().mockResolvedValue({ data: true, error: null }); // rate limit OK

    deps = {
      db: {
        ...mockDb({
          profiles: {
            id: 'user-123',
            email: 'carson@arkova.ai',
            full_name: 'Carson Seeger',
            role: 'ORG_ADMIN',
            org_id: 'org-456',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-04-01T00:00:00Z',
          },
          anchors: [
            {
              id: 'anchor-1',
              public_id: 'ARK-SEC-AAA',
              fingerprint: 'a'.repeat(64),
              status: 'SECURED',
              created_at: '2026-02-01T00:00:00Z',
            },
          ],
          audit_events: [
            {
              id: 'audit-1',
              event_type: 'anchor.created',
              event_category: 'ANCHOR',
              target_type: 'anchor',
              target_id: 'anchor-1',
              created_at: '2026-02-01T00:00:00Z',
            },
          ],
          data_subject_requests: [],
        }),
        rpc: rpcMock,
      } as unknown as AccountExportDeps['db'],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
  });

  it('returns 404 for non-existent profile', async () => {
    deps.db = {
      ...mockDb({ profiles: null }),
      rpc: rpcMock,
    } as unknown as AccountExportDeps['db'];

    const res = mockRes();
    await handleAccountExport('user-404', deps, mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 429 when rate-limit RPC says false (already exported in last 24h)', async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });

    const res = mockRes();
    await handleAccountExport('user-123', deps, mockReq(), res);

    expect(deps.db.rpc).toHaveBeenCalledWith('can_export_user_data', { p_user_id: 'user-123' });
    expect(res.status).toHaveBeenCalledWith(429);
    const [[errorPayload]] = (res.json as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorPayload).toMatchObject({ error: expect.stringMatching(/24/i) });
  });

  it('returns 500 if the rate-limit RPC itself errors', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'db down' } });

    const res = mockRes();
    await handleAccountExport('user-123', deps, mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns a JSON export with profile, anchors, and audit events for the authenticated user', async () => {
    const res = mockRes();
    await handleAccountExport('user-123', deps, mockReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(429);
    expect(res.status).not.toHaveBeenCalledWith(500);

    // Content-Disposition makes the response download as a file
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/attachment; filename="arkova-export-.*\.json"/),
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');

    // Body shape
    const [[payload]] = (res.json as ReturnType<typeof vi.fn>).mock.calls;
    expect(payload).toMatchObject({
      schema: 'arkova.data-export.v1',
      generated_at: expect.any(String),
      subject: {
        profile: expect.objectContaining({
          id: 'user-123',
          email: 'carson@arkova.ai',
        }),
      },
      data: {
        anchors: expect.any(Array),
        audit_events: expect.any(Array),
      },
      request: expect.objectContaining({
        id: expect.any(String),
        type: 'export',
      }),
    });

    // Profile is present
    expect(payload.subject.profile.email).toBe('carson@arkova.ai');
    // User's anchors are present
    expect(payload.data.anchors).toHaveLength(1);
    expect(payload.data.anchors[0].public_id).toBe('ARK-SEC-AAA');
    // User's audit events are present
    expect(payload.data.audit_events).toHaveLength(1);
  });

  it('inserts a data_subject_requests row with type=export before gathering data', async () => {
    const insertSpy = vi.fn().mockResolvedValue({
      data: { id: 'dsr-test-id' },
      error: null,
    });
    const fromSpy = vi.fn((table: string) => {
      if (table === 'data_subject_requests') {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'dsr-test-id' }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      // Default stub for everything else. Terminal is .limit() (anchors,
      // audit_events) or .single() (profiles). No `then` on the object —
      // see SonarCloud typescript:S7739.
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        single: vi.fn().mockResolvedValue({
          data: table === 'profiles'
            ? { id: 'user-123', email: 'a@b.c', full_name: null, role: null, org_id: null, created_at: 't', updated_at: 't' }
            : null,
          error: null,
        }),
      };
    });
    void insertSpy;
    deps.db = {
      from: fromSpy,
      rpc: rpcMock,
    } as unknown as AccountExportDeps['db'];

    const res = mockRes();
    await handleAccountExport('user-123', deps, mockReq(), res);

    // Verify `data_subject_requests` was touched (insert + update for status)
    expect(fromSpy).toHaveBeenCalledWith('data_subject_requests');
  });

  it('logs only the user id, never email or full_name (Constitution 1.4)', async () => {
    const res = mockRes();
    await handleAccountExport('user-123', deps, mockReq(), res);

    const logInfoCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls;
    for (const [context] of logInfoCalls) {
      const serialized = JSON.stringify(context ?? {});
      expect(serialized).not.toContain('carson@arkova.ai');
      expect(serialized).not.toContain('Carson Seeger');
    }
  });
});
