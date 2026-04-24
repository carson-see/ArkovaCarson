/**
 * ARK-112 (SCRUM-1120) — Rule CRUD API test coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

interface TerminalResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

const stub: { from: ReturnType<typeof vi.fn> } = { from: vi.fn() };

/**
 * Minimal chained-builder stub. Records every verb+filter call in `calls`,
 * resolves terminal awaits (`then`, `maybeSingle`, `single`) with the
 * op-keyed `TerminalResult`.
 */
function tableMock(terminalByOp: {
  select?: TerminalResult;
  insert?: TerminalResult;
  update?: TerminalResult;
  delete?: TerminalResult;
}): {
  from: (table: string) => Record<string, unknown>;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  function chain(terminal: TerminalResult): Record<string, unknown> {
    const handler: Record<string, unknown> = {
      // Post-mutation `.select(...)` (used by INSERT ... RETURNING id)
      select: () => handler,
      eq: (...args: unknown[]) => {
        calls.push({ method: 'eq', args });
        return handler;
      },
      order: () => handler,
      limit: () => handler,
      maybeSingle: async () => terminal,
      single: async () => terminal,
      then(onFulfilled: (v: TerminalResult) => unknown) {
        return Promise.resolve(terminal).then(onFulfilled);
      },
    };
    return handler;
  }

  const byOp: Record<string, TerminalResult> = {
    select: terminalByOp.select ?? { data: [], error: null },
    insert: terminalByOp.insert ?? { data: { id: 'rule-new' }, error: null },
    update: terminalByOp.update ?? { error: null, count: 1 },
    delete: terminalByOp.delete ?? { error: null, count: 1 },
  };

  const from = (_table: string) => ({
    select: (...args: unknown[]) => {
      calls.push({ method: 'select', args });
      return chain(byOp.select);
    },
    insert: (...args: unknown[]) => {
      calls.push({ method: 'insert', args });
      return chain(byOp.insert);
    },
    update: (...args: unknown[]) => {
      calls.push({ method: 'update', args });
      return chain(byOp.update);
    },
    delete: (...args: unknown[]) => {
      calls.push({ method: 'delete', args });
      return chain(byOp.delete);
    },
  });

  return { from, calls };
}

/**
 * Swap a multi-call `db.from()` dispatcher for a scripted handler list.
 * First call returns `handlers[0]`, second `handlers[1]`, etc. After the
 * list is exhausted, repeats the last handler.
 */
function scriptedFrom(
  ...handlers: Array<ReturnType<ReturnType<typeof tableMock>['from']>>
): (_table: string) => ReturnType<ReturnType<typeof tableMock>['from']> {
  let idx = 0;
  return () => handlers[Math.min(idx++, handlers.length - 1)];
}

vi.mock('../utils/db.js', () => ({
  // Pass-through — each test installs its own `stub.from` impl.
  db: {
    from: (...args: unknown[]) => (stub.from as (...a: unknown[]) => unknown)(...args),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handleCreateRule,
  handleGetRule,
  handleListRuleExecutions,
  handleListRules,
  handleTestRule,
  handleUpdateRule,
  handleDeleteRule,
  UpdateOrgRuleInput,
} from './rules-crud.js';

// -- Fixtures ------------------------------------------------------------

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_ORG_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RULE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

function mockReq(
  opts: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {},
): Request {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    headers: {},
    query: opts.query ?? {},
  } as unknown as Request;
}

const VALID_CREATE_BODY = {
  org_id: ORG_ID,
  name: 'Anchor all DocuSigns',
  description: 'Auto-anchor every signed envelope',
  trigger_type: 'ESIGN_COMPLETED' as const,
  trigger_config: { vendors: ['docusign'] },
  action_type: 'AUTO_ANCHOR' as const,
  action_config: { tag: 'ds' },
  enabled: true, // caller asks for enabled — SEC-02 must force false
};

// Returns a profiles lookup stub that always returns the caller's org.
function installAuthedCaller() {
  const { from } = tableMock({
    select: { data: { org_id: ORG_ID }, error: null },
  });
  stub.from.mockImplementation(from);
}

function adminMembership() {
  return tableMock({ select: { data: { role: 'admin' }, error: null } });
}

beforeEach(() => {
  stub.from = vi.fn();
});
afterEach(() => {
  vi.clearAllMocks();
});

// -- UpdateOrgRuleInput schema ------------------------------------------

describe('UpdateOrgRuleInput', () => {
  it('requires at least one field', () => {
    const r = UpdateOrgRuleInput.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts a single field', () => {
    const r = UpdateOrgRuleInput.safeParse({ enabled: true });
    expect(r.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const r = UpdateOrgRuleInput.safeParse({ name: '' });
    expect(r.success).toBe(false);
  });
});

// -- handleListRules -----------------------------------------------------

describe('handleListRules', () => {
  it('403s when caller has no org', async () => {
    const { from } = tableMock({ select: { data: null, error: null } });
    stub.from.mockImplementation(from);

    const { res, status, json } = mockRes();
    await handleListRules(USER_ID, mockReq(), res);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'forbidden' }) }),
    );
  });

  it('returns items + count when RPC succeeds', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const rules = tableMock({
      select: {
        data: [{ id: RULE_ID, org_id: ORG_ID, name: 'r1', trigger_type: 'MANUAL_UPLOAD' }],
        error: null,
      },
    });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), rules.from('')));

    const { res, json } = mockRes();
    await handleListRules(USER_ID, mockReq(), res);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1, items: expect.any(Array) }),
    );
  });

  it('returns 500 when list SELECT errors', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const rules = tableMock({ select: { data: null, error: { message: 'db down' } } });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), rules.from('')));

    const { res, status } = mockRes();
    await handleListRules(USER_ID, mockReq(), res);
    expect(status).toHaveBeenCalledWith(500);
  });
});

// -- handleGetRule ------------------------------------------------------

describe('handleGetRule', () => {
  it('returns scoped rule details including configs', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const rules = tableMock({
      select: {
        data: {
          id: RULE_ID,
          org_id: ORG_ID,
          name: 'Anchor all DocuSigns',
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['docusign'] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'ds' },
          enabled: false,
        },
        error: null,
      },
    });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), rules.from('')));

    const { res, json } = mockRes();
    await handleGetRule(USER_ID, mockReq({ params: { id: RULE_ID } }), res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({
          id: RULE_ID,
          trigger_config: { vendors: ['docusign'] },
          action_config: { tag: 'ds' },
        }),
      }),
    );
  });

  it('returns 404 when the rule is outside the caller org scope', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const rules = tableMock({ select: { data: null, error: null } });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), rules.from('')));

    const { res, status } = mockRes();
    await handleGetRule(USER_ID, mockReq({ params: { id: RULE_ID } }), res);

    expect(status).toHaveBeenCalledWith(404);
  });
});

// -- handleListRuleExecutions ------------------------------------------

describe('handleListRuleExecutions', () => {
  it('returns recent executions scoped to caller org', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const ruleLookup = tableMock({ select: { data: { id: RULE_ID }, error: null } });
    const executions = tableMock({
      select: {
        data: [
          {
            id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            rule_id: RULE_ID,
            trigger_event_id: 'evt-1',
            status: 'COMPLETED',
            input_payload: { match_reason: 'matched' },
            completed_at: '2026-04-24T14:00:00Z',
            created_at: '2026-04-24T13:59:00Z',
          },
        ],
        error: null,
      },
    });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), ruleLookup.from(''), executions.from('')),
    );

    const { res, json } = mockRes();
    await handleListRuleExecutions(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, query: { limit: '10' } }),
      res,
    );

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        limit: 10,
        items: [expect.objectContaining({ trigger_event_id: 'evt-1', status: 'COMPLETED' })],
      }),
    );
    expect(executions.calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['rule_id', RULE_ID] },
        { method: 'eq', args: ['org_id', ORG_ID] },
      ]),
    );
  });

  it('returns 404 when the rule is outside the caller org scope', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const ruleLookup = tableMock({ select: { data: null, error: null } });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), ruleLookup.from('')));

    const { res, status } = mockRes();
    await handleListRuleExecutions(USER_ID, mockReq({ params: { id: RULE_ID } }), res);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('400s on invalid UUID', async () => {
    installAuthedCaller();

    const { res, status } = mockRes();
    await handleListRuleExecutions(USER_ID, mockReq({ params: { id: 'nope' } }), res);

    expect(status).toHaveBeenCalledWith(400);
  });
});

// -- handleTestRule ------------------------------------------------------

describe('handleTestRule', () => {
  it('simulates a disabled draft rule as enabled by default without persisting', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from('')));

    const { res, json } = mockRes();
    await handleTestRule(
      USER_ID,
      mockReq({
        body: {
          rule: {
            ...VALID_CREATE_BODY,
            enabled: false,
          },
          event: {
            trigger_type: 'ESIGN_COMPLETED',
            vendor: 'docusign',
            filename: 'MSA.pdf',
            sender_email: 'legal@example.com',
          },
        },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        persisted: false,
        matched: true,
        reason: 'matched',
        evaluated_enabled: true,
        action_type: 'AUTO_ANCHOR',
      }),
    );
    expect(stub.from).toHaveBeenCalledTimes(2);
  });

  it('returns a clear non-match reason when event fields miss filters', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from('')));

    const { res, json } = mockRes();
    await handleTestRule(
      USER_ID,
      mockReq({
        body: {
          rule: {
            ...VALID_CREATE_BODY,
            trigger_config: { vendors: ['docusign'], filename_contains: 'contract' },
          },
          event: {
            trigger_type: 'ESIGN_COMPLETED',
            vendor: 'docusign',
            filename: 'invoice.pdf',
          },
        },
      }),
      res,
    );

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        matched: false,
        reason: 'filename_filter_rejected',
      }),
    );
  });

  it('rejects cross-org rule tests', async () => {
    installAuthedCaller();

    const { res, status, json } = mockRes();
    await handleTestRule(
      USER_ID,
      mockReq({
        body: {
          rule: VALID_CREATE_BODY,
          event: {
            org_id: OTHER_ORG_ID,
            trigger_type: 'ESIGN_COMPLETED',
            vendor: 'docusign',
          },
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'forbidden' }) }),
    );
  });

  it('rejects inline secrets before evaluating', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from('')));

    const { res, status, json } = mockRes();
    await handleTestRule(
      USER_ID,
      mockReq({
        body: {
          rule: {
            ...VALID_CREATE_BODY,
            action_config: { api_key: 'test-fake-value' }, // gitleaks:allow
          },
          event: {
            trigger_type: 'ESIGN_COMPLETED',
            vendor: 'docusign',
          },
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'inline_secret' }) }),
    );
  });
});

// -- handleCreateRule ---------------------------------------------------

describe('handleCreateRule', () => {
  it('rejects a non-matching org_id with 403 (cross-tenant guard)', async () => {
    installAuthedCaller();
    const { res, status } = mockRes();
    await handleCreateRule(
      USER_ID,
      mockReq({ body: { ...VALID_CREATE_BODY, org_id: OTHER_ORG_ID } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(403);
  });

  it('rejects invalid body with 400', async () => {
    installAuthedCaller();
    const { res, status } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: { name: 'x' } }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('rejects inline secrets in trigger_config with code inline_secret', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from('')));
    const { res, status, json } = mockRes();
    await handleCreateRule(
      USER_ID,
      mockReq({
        body: {
          ...VALID_CREATE_BODY,
          trigger_config: {
            vendors: ['docusign'],
            api_key: 'test-fake-value', // gitleaks:allow — sanitizer matches on key name, not value
          },
        },
      }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'inline_secret' }) }),
    );
  });

  it('forces enabled=false on insert regardless of request body (SEC-02)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), rulesInsert.from(''), auditInsert.from('')),
    );

    const { res, status, json } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: VALID_CREATE_BODY }), res);

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ id: RULE_ID });

    // `enabled` MUST be false even though VALID_CREATE_BODY.enabled was true.
    const insertCall = rulesInsert.calls.find((c) => c.method === 'insert');
    expect(insertCall).toBeDefined();
    const payload = insertCall!.args[0] as { enabled: boolean; name: string };
    expect(payload.enabled).toBe(false);
    expect(payload.name).toBe(VALID_CREATE_BODY.name);
  });

  it('rejects non-admin rule creation with 403', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = tableMock({ select: { data: { role: 'member' }, error: null } });
    const fallbackProfile = tableMock({
      select: { data: { role: 'INDIVIDUAL', is_platform_admin: false }, error: null },
    });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), fallbackProfile.from('')),
    );

    const { res, status, json } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: VALID_CREATE_BODY }), res);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'forbidden' }) }),
    );
  });
});

// -- handleUpdateRule ---------------------------------------------------

describe('handleUpdateRule', () => {
  it('400s on invalid UUID param', async () => {
    installAuthedCaller();
    const { res, status } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: 'not-a-uuid' }, body: { enabled: true } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
  });

  it('400s when body has no fields', async () => {
    installAuthedCaller();
    const { res, status } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: {} }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when no rows match (update with count=0)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesUpdate = tableMock({ update: { error: null, count: 0 } });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from(''), rulesUpdate.from('')));

    const { res, status, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { name: 'rename' } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'not_found' }) }),
    );
  });

  it('rejects inline-secret action_config with 400 inline_secret', async () => {
    installAuthedCaller();
    const { res, status, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({
        params: { id: RULE_ID },
        body: { action_config: { password: 'hunter2abc' } },
      }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'inline_secret' }) }),
    );
  });

  it('happy path: partial update returns ok:true', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { enabled: true } }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it('emits ORG_RULE_ENABLED audit when toggling enabled=true (SEC-02)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { enabled: true } }),
      res,
    );
    // The audit fire-and-forget fires after res.json; wait a microtask for it.
    await Promise.resolve();
    await Promise.resolve();
    const auditInsertCall = audit.calls.find((c) => c.method === 'insert');
    expect(auditInsertCall).toBeDefined();
    const payload = auditInsertCall!.args[0] as { event_type: string };
    expect(payload.event_type).toBe('ORG_RULE_ENABLED');
  });

  it('emits ORG_RULE_DISABLED audit when toggling enabled=false (SEC-02)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { enabled: false } }),
      res,
    );
    await Promise.resolve();
    await Promise.resolve();
    const auditInsertCall = audit.calls.find((c) => c.method === 'insert');
    expect(auditInsertCall).toBeDefined();
    const payload = auditInsertCall!.args[0] as { event_type: string };
    expect(payload.event_type).toBe('ORG_RULE_DISABLED');
  });
});

// -- handleDeleteRule ---------------------------------------------------

describe('handleDeleteRule', () => {
  it('403s when caller has no org', async () => {
    const noOrg = tableMock({ select: { data: null, error: null } });
    stub.from.mockImplementation(noOrg.from);

    const { res, status } = mockRes();
    await handleDeleteRule(USER_ID, mockReq({ params: { id: RULE_ID } }), res);
    expect(status).toHaveBeenCalledWith(403);
  });

  it('400s on invalid UUID', async () => {
    installAuthedCaller();
    const { res, status } = mockRes();
    await handleDeleteRule(USER_ID, mockReq({ params: { id: 'nope' } }), res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when no rows match', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesDelete = tableMock({ delete: { error: null, count: 0 } });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from(''), rulesDelete.from('')));

    const { res, status } = mockRes();
    await handleDeleteRule(USER_ID, mockReq({ params: { id: RULE_ID } }), res);
    expect(status).toHaveBeenCalledWith(404);
  });

  it('happy path returns ok:true', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesDelete = tableMock({ delete: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), rulesDelete.from(''), audit.from('')),
    );

    const { res, json } = mockRes();
    await handleDeleteRule(USER_ID, mockReq({ params: { id: RULE_ID } }), res);
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
