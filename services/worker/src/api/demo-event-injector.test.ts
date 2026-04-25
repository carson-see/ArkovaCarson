/**
 * Tests for SCRUM-1144 — demo event injector.
 *
 * Acceptance Criteria:
 *   - Admin-only endpoint creates canonical event payloads through the
 *     production enqueue path.
 *   - Supports e-signature, workspace file, connector document, email intake,
 *     and manual upload sample event types.
 *   - Event payloads are clearly marked as demo/test events.
 *   - Demo events are org-scoped and auditable.
 *   - Disabled outside demo/staging unless an explicit feature flag is set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mockRpc = vi.fn();
const mockProfilesSelect = vi.fn();
const mockOrgMembersSelect = vi.fn();
const mockProfilesEq = vi.fn();
const mockOrgMembersEq = vi.fn();
const mockProfilesMaybeSingle = vi.fn();
const mockOrgMembersMaybeSingle = vi.fn();
const mockAuditInsert = vi.fn();

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  const profilesChain = {
    select: (_cols?: string) => {
      mockProfilesSelect();
      return {
        eq: (_col: string, _val: unknown) => {
          mockProfilesEq();
          return { maybeSingle: () => mockProfilesMaybeSingle() };
        },
      };
    },
  };
  const orgMembersChain = {
    select: (_cols?: string) => {
      mockOrgMembersSelect();
      return {
        eq: (_col: string, _val: unknown) => {
          mockOrgMembersEq();
          return {
            eq: (_col2: string, _val2: unknown) => ({
              maybeSingle: () => mockOrgMembersMaybeSingle(),
            }),
          };
        },
      };
    },
  };
  const auditChain = {
    insert: (...args: unknown[]) => mockAuditInsert(...args),
  };
  return {
    db: {
      from: (table: string) => {
        if (table === 'profiles') return profilesChain;
        if (table === 'org_members') return orgMembersChain;
        if (table === 'audit_events') return auditChain;
        throw new Error(`unexpected table: ${table}`);
      },
      rpc: (...args: unknown[]) => mockRpc(...args),
    },
  };
});

const { handleInjectDemoEvent, isDemoInjectorEnabled } = await import('./demo-event-injector.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; body?: unknown; statusCode?: number } {
  let statusCode: number | undefined;
  let body: unknown;
  const json = vi.fn((payload: unknown) => {
    body = payload;
  });
  const status = vi.fn((code: number) => {
    statusCode = code;
    return { json };
  });
  const res = { status, json } as unknown as Response;
  return { res, status, json, get body() { return body; }, get statusCode() { return statusCode; } };
}

function buildReq(body: Record<string, unknown>): Request {
  return { body } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENABLE_DEMO_INJECTOR;
  delete process.env.NODE_ENV;
  // Default scenario: caller is org admin
  mockProfilesMaybeSingle.mockResolvedValue({ data: { org_id: ORG_ID, role: 'ORG_ADMIN', is_platform_admin: false }, error: null });
  mockOrgMembersMaybeSingle.mockResolvedValue({ data: { role: 'admin' }, error: null });
  mockRpc.mockResolvedValue({ data: 'evt-1234', error: null });
  mockAuditInsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('demo-event-injector (SCRUM-1144)', () => {
  describe('isDemoInjectorEnabled', () => {
    it('disabled by default in production', () => {
      process.env.NODE_ENV = 'production';
      expect(isDemoInjectorEnabled()).toBe(false);
    });
    it('enabled in development', () => {
      process.env.NODE_ENV = 'development';
      expect(isDemoInjectorEnabled()).toBe(true);
    });
    it('enabled in staging', () => {
      process.env.NODE_ENV = 'staging';
      expect(isDemoInjectorEnabled()).toBe(true);
    });
    it('enabled when ENABLE_DEMO_INJECTOR=true even in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.ENABLE_DEMO_INJECTOR = 'true';
      expect(isDemoInjectorEnabled()).toBe(true);
    });
  });

  describe('handleInjectDemoEvent', () => {
    it('rejects when feature flag is off in production', async () => {
      process.env.NODE_ENV = 'production';
      const ctx = buildRes();
      await handleInjectDemoEvent(USER_ID, buildReq({ trigger_type: 'ESIGN_COMPLETED' }), ctx.res);
      expect(ctx.status).toHaveBeenCalledWith(403);
      expect((ctx.body as { error: { code: string } }).error.code).toBe('demo_injector_disabled');
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects non-admins with 403 even when enabled', async () => {
      process.env.NODE_ENV = 'development';
      // Single profile fetch covers both org-id and admin-check (no N+1).
      mockProfilesMaybeSingle.mockReset();
      mockProfilesMaybeSingle.mockResolvedValue({
        data: { org_id: ORG_ID, role: 'MEMBER', is_platform_admin: false },
        error: null,
      });
      mockOrgMembersMaybeSingle.mockReset();
      mockOrgMembersMaybeSingle.mockResolvedValue({ data: { role: 'member' }, error: null });
      const ctx = buildRes();
      await handleInjectDemoEvent(USER_ID, buildReq({ trigger_type: 'ESIGN_COMPLETED' }), ctx.res);
      expect(ctx.status).toHaveBeenCalledWith(403);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('rejects unknown trigger_type', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(USER_ID, buildReq({ trigger_type: 'BOGUS' }), ctx.res);
      expect(ctx.status).toHaveBeenCalledWith(400);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('e-signature: enqueues canonical ESIGN_COMPLETED event tagged demo', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({ trigger_type: 'ESIGN_COMPLETED' }),
        ctx.res,
      );
      expect(ctx.status).toHaveBeenCalledWith(202);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      const [name, params] = mockRpc.mock.calls[0];
      expect(name).toBe('enqueue_rule_event');
      expect(params.p_org_id).toBe(ORG_ID);
      expect(params.p_trigger_type).toBe('ESIGN_COMPLETED');
      expect(params.p_vendor).toBe('docusign');
      expect(params.p_payload.source).toBe('demo_injector');
      expect(params.p_payload.demo).toBe(true);
      expect(params.p_payload.injected_by_user_id).toBe(USER_ID);
    });

    it('workspace file: defaults to google_drive vendor', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({ trigger_type: 'WORKSPACE_FILE_MODIFIED' }),
        ctx.res,
      );
      expect(ctx.status).toHaveBeenCalledWith(202);
      const [, params] = mockRpc.mock.calls[0];
      expect(params.p_trigger_type).toBe('WORKSPACE_FILE_MODIFIED');
      expect(params.p_vendor).toBe('google_drive');
    });

    it('connector document: vendor=veremark', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({ trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED' }),
        ctx.res,
      );
      expect(ctx.status).toHaveBeenCalledWith(202);
      const [, params] = mockRpc.mock.calls[0];
      expect(params.p_vendor).toBe('veremark');
    });

    it('email intake: produces sender_email + subject sample fields', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({ trigger_type: 'EMAIL_INTAKE' }),
        ctx.res,
      );
      expect(ctx.status).toHaveBeenCalledWith(202);
      const [, params] = mockRpc.mock.calls[0];
      expect(params.p_trigger_type).toBe('EMAIL_INTAKE');
      expect(params.p_sender_email).toBeTruthy();
      expect(params.p_subject).toBeTruthy();
    });

    it('manual upload: uses placeholder filename and no vendor', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({ trigger_type: 'MANUAL_UPLOAD' }),
        ctx.res,
      );
      expect(ctx.status).toHaveBeenCalledWith(202);
      const [, params] = mockRpc.mock.calls[0];
      expect(params.p_filename).toMatch(/demo/i);
      expect(params.p_vendor).toBeNull();
    });

    it('caller-supplied filename / sender_email override sample defaults but stay org-scoped', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({
          trigger_type: 'ESIGN_COMPLETED',
          filename: 'msa-2026.pdf',
          sender_email: 'demo@example.com',
        }),
        ctx.res,
      );
      const [, params] = mockRpc.mock.calls[0];
      expect(params.p_filename).toBe('msa-2026.pdf');
      expect(params.p_sender_email).toBe('demo@example.com');
      expect(params.p_org_id).toBe(ORG_ID); // never spoofed
    });

    it('writes an audit event for every successful injection', async () => {
      process.env.NODE_ENV = 'development';
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({ trigger_type: 'ESIGN_COMPLETED' }),
        ctx.res,
      );
      expect(mockAuditInsert).toHaveBeenCalledTimes(1);
      const insert = mockAuditInsert.mock.calls[0][0] as { event_type: string; org_id: string; actor_id: string };
      expect(insert.event_type).toBe('DEMO_RULE_EVENT_INJECTED');
      expect(insert.org_id).toBe(ORG_ID);
      expect(insert.actor_id).toBe(USER_ID);
    });

    it('returns 500 with code rule_event_enqueue_failed when RPC errors', async () => {
      process.env.NODE_ENV = 'development';
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });
      const ctx = buildRes();
      await handleInjectDemoEvent(
        USER_ID,
        buildReq({ trigger_type: 'ESIGN_COMPLETED' }),
        ctx.res,
      );
      expect(ctx.status).toHaveBeenCalledWith(500);
      expect((ctx.body as { error: { code: string } }).error.code).toBe('rule_event_enqueue_failed');
    });
  });
});
