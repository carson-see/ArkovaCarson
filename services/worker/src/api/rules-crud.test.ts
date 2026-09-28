/**
 * ARK-112 (SCRUM-1120) — Rule CRUD API test coverage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import type { MirrorConnectedDriveFolderResult } from '../integrations/connectors/drive-folder-mirror.js';

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
      is: (...args: unknown[]) => {
        calls.push({ method: 'is', args });
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

// Eager Drive-folder mirror wiring (founder spec — "duplicate connected
// folders in Arkova automatically upon setup"). Only `mirrorConnectedDriveFolders`
// (the DB-touching call) is stubbed — the pure guard/extraction helpers stay
// real so the wiring tests below prove `rules-crud.ts` actually calls through
// with the real trigger_type/action_config-derived decision, not a fake one.
const driveFolderMirrorMock = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.hoisted runs before the real module's types are in scope; the real shape is asserted via the `MirrorConnectedDriveFolderResult[]` import at call sites below.
  mirrorConnectedDriveFolders: vi.fn(async (): Promise<any[]> => []),
}));
vi.mock('../integrations/connectors/drive-folder-mirror.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../integrations/connectors/drive-folder-mirror.js')>();
  return { ...actual, mirrorConnectedDriveFolders: driveFolderMirrorMock.mirrorConnectedDriveFolders };
});

import {
  handleCreateRule,
  handleGetRule,
  handleListRuleExecutions,
  handleRunRuleNow,
  handleListRules,
  handleTestRule,
  handleUpdateRule,
  handleDeleteRule,
  resetManualRuleRunRateLimitForTests,
  UpdateOrgRuleInput,
} from './rules-crud.js';

// -- Fixtures ------------------------------------------------------------

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RULE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function mockRes(): {
  res: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const setHeader = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json, setHeader } as unknown as Response, status, json, setHeader };
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

/**
 * Pumps microtask ticks until `mockFn` has been called at least once, or
 * `maxTicks` is reached. Used instead of a fixed tick count to prove an
 * await-ordering guarantee (the response must not be sent before some other
 * mock resolves) without the test being fragile to the exact number of DB
 * round-trips a handler happens to make before reaching that call.
 */
async function waitUntilCalled(mockFn: { mock: { calls: unknown[] } }, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks && mockFn.mock.calls.length === 0; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  stub.from = vi.fn();
  resetManualRuleRunRateLimitForTests();
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
            id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
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

// -- handleRunRuleNow ---------------------------------------------------

function selectOne(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
}

function executionInsert(capture?: (row: Record<string, unknown>) => void, error: unknown = null) {
  return {
    insert: vi.fn((row: Record<string, unknown>) => {
      capture?.(row);
      return {
        select: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({
          data: error ? null : { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          error,
        }),
      };
    }),
  };
}

function auditInsert() {
  return {
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
}

describe('handleRunRuleNow', () => {
  it('queues a manual execution for an org-admin owned rule', async () => {
    let insertedExecution: Record<string, unknown> | null = null;
    stub.from.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return selectOne({ org_id: ORG_ID, role: 'ORG_ADMIN', is_platform_admin: false });
      }
      if (table === 'org_members') return selectOne({ role: 'admin' });
      if (table === 'organization_rules') {
        return selectOne({
          id: RULE_ID,
          org_id: ORG_ID,
          name: 'DocuSign intake',
          enabled: true,
          trigger_type: 'ESIGN_COMPLETED',
          action_type: 'QUEUE_FOR_REVIEW',
        });
      }
      if (table === 'organization_rule_executions') {
        return executionInsert((row) => {
          insertedExecution = row;
        });
      }
      return auditInsert();
    });

    const { res, status, json } = mockRes();
    await handleRunRuleNow(USER_ID, mockReq({ params: { id: RULE_ID } }), res);

    expect(status).toHaveBeenCalledWith(202);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      queued: true,
      execution_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      trigger_event_id: expect.stringMatching(/^manual:/),
    }));
    expect(insertedExecution).toMatchObject({
      rule_id: RULE_ID,
      org_id: ORG_ID,
      status: 'PENDING',
      input_payload: expect.objectContaining({
        source: 'manual_run',
        actor_user_id: USER_ID,
        rule_name: 'DocuSign intake',
      }),
    });
  });

  it('rate-limits manual runs to 5 per minute per org', async () => {
    stub.from.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return selectOne({ org_id: ORG_ID, role: 'ORG_ADMIN', is_platform_admin: false });
      }
      if (table === 'org_members') return selectOne({ role: 'admin' });
      if (table === 'organization_rules') {
        return selectOne({
          id: RULE_ID,
          org_id: ORG_ID,
          name: 'Rule',
          enabled: true,
          trigger_type: 'MANUAL_UPLOAD',
          action_type: 'NOTIFY',
        });
      }
      if (table === 'organization_rule_executions') return executionInsert();
      return auditInsert();
    });

    for (let i = 0; i < 5; i++) {
      const { res } = mockRes();
      await handleRunRuleNow(USER_ID, mockReq({ params: { id: RULE_ID } }), res);
    }

    const { res, status, json, setHeader } = mockRes();
    await handleRunRuleNow(USER_ID, mockReq({ params: { id: RULE_ID } }), res);

    expect(status).toHaveBeenCalledWith(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'rate_limited' }),
    }));
  });

  it('does not spend rate-limit capacity for a foreign or missing rule', async () => {
    stub.from.mockImplementation((table: string) => {
      if (table === 'profiles') return selectOne({ org_id: ORG_ID });
      if (table === 'org_members') return selectOne({ role: 'admin' });
      if (table === 'organization_rules') return selectOne(null);
      return auditInsert();
    });

    const { res, status } = mockRes();
    await handleRunRuleNow(USER_ID, mockReq({ params: { id: RULE_ID } }), res);

    expect(status).toHaveBeenCalledWith(404);
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
    const payload = insertCall!.args[0] as { enabled: boolean; name: string; created_by_user_id: string };
    expect(payload.enabled).toBe(false);
    expect(payload.name).toBe(VALID_CREATE_BODY.name);
    expect(payload.created_by_user_id).toBe(USER_ID);
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

  // -- Connectors-page adopt-vs-create race guard (CTO pre-mortem 2026-09-13) --

  const CONNECTOR_CREATE_BODY = {
    ...VALID_CREATE_BODY,
    trigger_type: 'WORKSPACE_FILE_MODIFIED' as const,
    trigger_config: { vendors: ['google_drive'] },
    action_type: 'AUTO_ANCHOR' as const,
    action_config: { tag: 'connector-google_drive' },
  };

  it('refuses a connector-tagged create with 409 rule_exists when an enabled rule of that trigger_type already exists (seeder race)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const raceCheck = tableMock({
      select: { data: { id: 'seeded-rule-id' }, error: null },
    });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from(''), raceCheck.from('')));

    const { res, status, json } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: CONNECTOR_CREATE_BODY }), res);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'rule_exists', existing_rule_id: 'seeded-rule-id' }),
      }),
    );
    // Never reached the insert — no second `insert` call recorded anywhere.
    expect(raceCheck.calls.some((c) => c.method === 'insert')).toBe(false);
  });

  it('a connector-tagged create proceeds normally when the race-check finds no enabled rule', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const raceCheck = tableMock({ select: { data: null, error: null } });
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), raceCheck.from(''), rulesInsert.from(''), auditInsert.from('')),
    );

    const { res, status, json } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: CONNECTOR_CREATE_BODY }), res);

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({ id: RULE_ID });
  });

  it('does NOT run the race-check for a create with no connector tag (RulesPage/RuleBuilderPage stays unaffected)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    // Exactly 4 scripted handlers: profiles, membership, insert, audit — if the
    // race-check ran, it would consume the `rulesInsert` slot as a SELECT and
    // this test would fail on the insert-shape assertion below.
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), rulesInsert.from(''), auditInsert.from('')),
    );

    const { res, status } = mockRes();
    // VALID_CREATE_BODY's action_config `{tag:'ds'}` does not match the
    // `connector-<provider>` marker pattern.
    await handleCreateRule(USER_ID, mockReq({ body: VALID_CREATE_BODY }), res);

    expect(status).toHaveBeenCalledWith(201);
    const insertCall = rulesInsert.calls.find((c) => c.method === 'insert');
    expect(insertCall).toBeDefined();
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

  // A plain (non-connector) row, disabled — used by every enabled:true test
  // below to feed `checkConnectorEnableRace`'s current-row read a realistic
  // answer instead of leaning on tableMock's op defaults. `action_config`
  // has no `connector-<provider>` tag, so the race-check reads this ONE row
  // and stops (no second query) — matching a RulesPage/RuleBuilderPage
  // admin's plain toggle, which the guard must not affect.
  function plainDisabledRuleRead() {
    return tableMock({
      select: {
        data: {
          trigger_type: 'ESIGN_COMPLETED', trigger_config: { vendors: ['docusign'] },
          action_type: 'AUTO_ANCHOR', action_config: { tag: 'ds' }, enabled: false,
          org_id: ORG_ID, created_by_user_id: USER_ID,
        },
        error: null,
      },
    });
  }

  it('happy path: partial update returns ok:true', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = plainDisabledRuleRead();
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from(''), currentRuleRead.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { enabled: true } }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ ok: true });
    expect(rulesUpdate.calls.some((c) => c.method === 'update')).toBe(true);
  });

  it('emits ORG_RULE_ENABLED audit when toggling enabled=true (SEC-02)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = plainDisabledRuleRead();
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from(''), currentRuleRead.from(''), rulesUpdate.from(''), audit.from('')),
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

  // -- Connectors-page adopt-vs-create race guard, second half (CTO
  // pre-mortem, 2026-09-13): the enable-PATCH step of the create flow ------

  it('refuses to enable a connector-tagged rule with 409 rule_exists when another enabled rule of that trigger_type already exists (seeder race, second gap)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = tableMock({
      select: {
        data: {
          trigger_type: 'ESIGN_COMPLETED', trigger_config: { vendors: ['docusign'] },
          action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-docusign' }, enabled: false,
          org_id: ORG_ID, created_by_user_id: USER_ID,
        },
        error: null,
      },
    });
    const raceCheck = tableMock({ select: { data: { id: 'seeded-rule-id' }, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from(''), currentRuleRead.from(''), raceCheck.from('')),
    );

    const { res, status, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { enabled: true } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: 'rule_exists', existing_rule_id: 'seeded-rule-id' }),
    });
    // The update must never fire when the race-check refuses.
    expect(raceCheck.calls.some((c) => c.method === 'update')).toBe(false);
  });

  it('enables a connector-tagged rule normally when the enable race-check finds no other enabled rule', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = tableMock({
      select: {
        data: {
          trigger_type: 'ESIGN_COMPLETED', trigger_config: { vendors: ['docusign'] },
          action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-docusign' }, enabled: false,
          org_id: ORG_ID, created_by_user_id: USER_ID,
        },
        error: null,
      },
    });
    const raceCheck = tableMock({ select: { data: null, error: null } });
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(
        profiles.from(''),
        membership.from(''),
        currentRuleRead.from(''),
        currentRuleRead.from(''),
        raceCheck.from(''),
        rulesUpdate.from(''),
        audit.from(''),
      ),
    );

    const { res, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { enabled: true } }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ ok: true });
  });

  it('does NOT run the enable race-check a second time when the rule is already enabled (idempotent re-patch)', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = tableMock({
      select: {
        data: {
          trigger_type: 'ESIGN_COMPLETED', trigger_config: { vendors: ['docusign'] },
          action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-docusign' }, enabled: true,
          org_id: ORG_ID, created_by_user_id: USER_ID,
        },
        error: null,
      },
    });
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    // Only 4 scripted handlers: if the already-enabled short-circuit didn't
    // fire, a second SELECT would consume the `rulesUpdate` slot and this
    // test would fail on the update-shape assertion below.
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from(''), currentRuleRead.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { enabled: true } }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ ok: true });
    expect(rulesUpdate.calls.some((c) => c.method === 'update')).toBe(true);
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

  // -- D4: action_type on PATCH (Connectors page, SPEC-CONNECTORS §1.5) ---

  it('test 22: PATCH with action_type + action_config succeeds and writes both columns', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = tableMock({
      select: {
        data: {
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
          org_id: ORG_ID,
        },
        error: null,
      },
    });
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({
        params: { id: RULE_ID },
        body: { action_type: 'INSTANT_SECURE', action_config: { tag: 'connector-google_drive' } },
      }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ ok: true });

    const updateCall = rulesUpdate.calls.find((c) => c.method === 'update');
    expect(updateCall).toBeDefined();
    const writtenRow = updateCall!.args[0] as Record<string, unknown>;
    expect(writtenRow.action_type).toBe('INSTANT_SECURE');
    expect(writtenRow.action_config).toEqual({ tag: 'connector-google_drive' });
  });

  it('test 23: PATCH with action_type ALONE gives 400 invalid_config (the pairing superRefine)', async () => {
    installAuthedCaller();
    const { res, status, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({ params: { id: RULE_ID }, body: { action_type: 'INSTANT_SECURE' } }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_config' }) }),
    );
  });

  it('test 24: an action_config that fails the target action_type\'s own schema gives 400 invalid_config', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = tableMock({
      select: {
        data: {
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
          org_id: ORG_ID,
        },
        error: null,
      },
    });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from('')));

    const { res, status, json } = mockRes();
    // `tag` must be a string on ActionConfigInstantSecure — a number fails
    // the Zod parse (Zod object schemas are non-strict, so a config that just
    // carries EXTRA unrelated keys would silently pass; a genuine type
    // mismatch on a shared field is what actually proves the merged
    // (action_type, action_config) pair gets re-validated together).
    await handleUpdateRule(
      USER_ID,
      mockReq({
        params: { id: RULE_ID },
        body: { action_type: 'INSTANT_SECURE', action_config: { tag: 12345 } },
      }),
      res,
    );
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_config' }) }),
    );
  });

  it('test 25: ORG_RULE_UPDATED audit details carries {from, to} action types', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = tableMock({
      select: {
        data: {
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
          org_id: ORG_ID,
        },
        error: null,
      },
    });
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({
        params: { id: RULE_ID },
        body: { action_type: 'INSTANT_SECURE', action_config: { tag: 'connector-google_drive' } },
      }),
      res,
    );
    await Promise.resolve();
    await Promise.resolve();

    const auditInsertCall = audit.calls.find((c) => c.method === 'insert');
    expect(auditInsertCall).toBeDefined();
    const payload = auditInsertCall!.args[0] as { event_type: string; details: string };
    expect(payload.event_type).toBe('ORG_RULE_UPDATED');
    expect(JSON.parse(payload.details)).toEqual({ from: 'AUTO_ANCHOR', to: 'INSTANT_SECURE' });
  });

  it('regression: an existing-shape PATCH (RulesPage/RuleBuilderPage — no action_type) behaves exactly as before D4', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRuleRead = tableMock({
      select: {
        data: {
          trigger_type: 'ESIGN_COMPLETED',
          trigger_config: { vendors: ['docusign'] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'ds' },
          org_id: ORG_ID,
        },
        error: null,
      },
    });
    const rulesUpdate = tableMock({ update: { error: null, count: 1 } });
    const audit = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), currentRuleRead.from(''), rulesUpdate.from(''), audit.from('')),
    );

    const { res, json } = mockRes();
    // Pre-D4 shape: name/description/trigger_config/action_config/enabled
    // only — no action_type field at all.
    await handleUpdateRule(
      USER_ID,
      mockReq({
        params: { id: RULE_ID },
        body: { name: 'Renamed via RuleBuilderPage', trigger_config: { vendors: ['docusign', 'adobe_sign'] } },
      }),
      res,
    );
    expect(json).toHaveBeenCalledWith({ ok: true });

    const updateCall = rulesUpdate.calls.find((c) => c.method === 'update');
    const writtenRow = updateCall!.args[0] as Record<string, unknown>;
    expect(writtenRow.name).toBe('Renamed via RuleBuilderPage');
    expect(writtenRow.trigger_config).toEqual({ vendors: ['docusign', 'adobe_sign'] });
    // The absent field is genuinely ABSENT from the write, not written as
    // undefined/null — buildRuleUpdate's `if (patch[k] !== undefined)` guard
    // is what this pins.
    expect('action_type' in writtenRow).toBe(false);

    await Promise.resolve();
    await Promise.resolve();
    const auditInsertCall = audit.calls.find((c) => c.method === 'insert');
    const payload = auditInsertCall!.args[0] as { event_type: string; details: string };
    expect(payload.event_type).toBe('ORG_RULE_UPDATED');
    // Pre-D4 shape stays the generic {patch} dump — {from,to} is ONLY for an
    // action_type patch.
    expect(JSON.parse(payload.details)).toEqual({
      patch: { name: 'Renamed via RuleBuilderPage', trigger_config: { vendors: ['docusign', 'adobe_sign'] } },
    });
  });

  it('test 26: PATCH cannot change trigger_type — the field is absent from the schema and never applied', () => {
    const parsed = UpdateOrgRuleInput.safeParse({
      enabled: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proving an unknown key is stripped, not typed
      trigger_type: 'SCHEDULED_CRON' as any,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('trigger_type' in parsed.data).toBe(false);
    }
  });
});

// -- Drive-folder mirror wiring (connect/rule-save time) ----------------

describe('handleCreateRule / handleUpdateRule — Drive folder mirror wiring', () => {
  const CONNECTOR_CREATE_WITH_FOLDERS = {
    ...VALID_CREATE_BODY,
    trigger_type: 'WORKSPACE_FILE_MODIFIED' as const,
    trigger_config: {
      vendors: ['google_drive'],
      drive_folders: [{ type: 'drive_folder', folder_id: 'drv-1', folder_name: 'Invoices' }],
    },
    action_type: 'AUTO_ANCHOR' as const,
    action_config: { tag: 'connector-google_drive' },
  };

  it('a connector-tagged Drive create with drive_folders mirrors — calls through with the org, actor, and selected folders', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const raceCheck = tableMock({ select: { data: null, error: null } });
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), raceCheck.from(''), rulesInsert.from(''), auditInsert.from('')),
    );

    const { res, status } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: CONNECTOR_CREATE_WITH_FOLDERS }), res);

    expect(status).toHaveBeenCalledWith(201);
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).toHaveBeenCalledTimes(1);
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).toHaveBeenCalledWith(
      expect.objectContaining({ db: expect.anything() }),
      { orgId: ORG_ID, actorUserId: USER_ID, ruleId: RULE_ID, folders: [{ folderId: 'drv-1', folderName: 'Invoices' }] },
    );
  });

  it('review P2: handleCreateRule AWAITS the mirror before responding — the response is not sent until it resolves', async () => {
    // Regression for the review finding: the mirror used to run
    // fire-and-forget AFTER `res.json` was already called, so a restart or
    // transient DB failure during it left an enabled rule with no folders
    // and no trace — nothing in the response ever said so. Proven here by
    // holding the mirror's promise open and asserting the response has NOT
    // gone out yet, then resolving it and asserting the response DOES go out
    // and carries the real per-folder outcome.
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const raceCheck = tableMock({ select: { data: null, error: null } });
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), raceCheck.from(''), rulesInsert.from(''), auditInsert.from('')),
    );

    let resolveMirror!: (v: MirrorConnectedDriveFolderResult[]) => void;
    driveFolderMirrorMock.mirrorConnectedDriveFolders.mockImplementationOnce(
      () => new Promise<MirrorConnectedDriveFolderResult[]>((resolve) => { resolveMirror = resolve; }),
    );

    const { res, json, status } = mockRes();
    const handlerPromise = handleCreateRule(USER_ID, mockReq({ body: CONNECTOR_CREATE_WITH_FOLDERS }), res);

    // Wait until the mirror has actually been invoked (bounded microtask
    // pump — not a magic tick count, so this stays valid regardless of how
    // many DB round-trips precede the mirror call), then prove the response
    // has NOT gone out yet: it is still awaiting that same mirror call.
    await waitUntilCalled(driveFolderMirrorMock.mirrorConnectedDriveFolders);
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();

    resolveMirror([{ folderId: 'folder-1', driveFolderId: 'drv-1', outcome: 'created' }]);
    await handlerPromise;

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({
      id: RULE_ID,
      drive_folder_mirror: [{ folderId: 'folder-1', driveFolderId: 'drv-1', outcome: 'created' }],
    });
  });

  it('review P2: a rule whose mirror comes back with a per-folder error still gets a 201 — the failure is recoverable data in the body, not a swallowed exception', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const raceCheck = tableMock({ select: { data: null, error: null } });
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), raceCheck.from(''), rulesInsert.from(''), auditInsert.from('')),
    );
    const erroredMirror: MirrorConnectedDriveFolderResult[] = [
      { folderId: '', driveFolderId: 'drv-1', outcome: 'error', error: 'connection reset by peer' },
    ];
    driveFolderMirrorMock.mirrorConnectedDriveFolders.mockResolvedValueOnce(erroredMirror);

    const { res, json, status } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: CONNECTOR_CREATE_WITH_FOLDERS }), res);

    expect(status).toHaveBeenCalledWith(201);
    expect(json).toHaveBeenCalledWith({
      id: RULE_ID,
      drive_folder_mirror: [{ folderId: '', driveFolderId: 'drv-1', outcome: 'error', error: 'connection reset by peer' }],
    });
  });

  it('a plain DocuSign create (no WORKSPACE_FILE_MODIFIED / no drive_folders) never calls the mirror — unrelated rules are unaffected', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), rulesInsert.from(''), auditInsert.from('')),
    );

    const { res, status } = mockRes();
    await handleCreateRule(USER_ID, mockReq({ body: VALID_CREATE_BODY }), res);

    expect(status).toHaveBeenCalledWith(201);
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).not.toHaveBeenCalled();
  });

  it('a WORKSPACE_FILE_MODIFIED create WITHOUT drive_folders (vendors filter only) never calls the mirror', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const raceCheck = tableMock({ select: { data: null, error: null } });
    const rulesInsert = tableMock({ insert: { data: { id: RULE_ID }, error: null } });
    const auditInsert = tableMock({ insert: { data: null, error: null } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), raceCheck.from(''), rulesInsert.from(''), auditInsert.from('')),
    );

    const { res, status } = mockRes();
    await handleCreateRule(
      USER_ID,
      mockReq({
        body: {
          ...CONNECTOR_CREATE_WITH_FOLDERS,
          trigger_config: { vendors: ['google_drive'] },
        },
      }),
      res,
    );

    expect(status).toHaveBeenCalledWith(201);
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).not.toHaveBeenCalled();
  });

  it('adopting/re-saving the connector rule (PATCH with trigger_config + action_config) re-mirrors', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRow = tableMock({
      select: {
        data: {
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
          org_id: ORG_ID,
          created_by_user_id: null,
        },
        error: null,
      },
    });
    const creatorClaim = tableMock({ update: { error: null, count: 1 } });
    const ruleUpdate = tableMock({ update: { error: null, count: 1 } });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from(''), currentRow.from(''), creatorClaim.from(''), ruleUpdate.from('')));
    driveFolderMirrorMock.mirrorConnectedDriveFolders.mockResolvedValueOnce([
      { folderId: 'arkova-folder-1', driveFolderId: 'drv-2', outcome: 'created' },
    ]);

    const { res, json } = mockRes();
    await handleUpdateRule(
      USER_ID,
      mockReq({
        params: { id: RULE_ID },
        body: {
          trigger_config: {
            vendors: ['google_drive'],
            drive_folders: [{ type: 'drive_folder', folder_id: 'drv-2', folder_name: 'Contracts' }],
          },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
        },
      }),
      res,
    );

    // The mirror is awaited, so its created-folder result is part of the
    // response body rather than invisible to the caller.
    expect(json).toHaveBeenCalledWith({
      ok: true,
      drive_folder_mirror: [{ folderId: 'arkova-folder-1', driveFolderId: 'drv-2', outcome: 'created' }],
    });
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).toHaveBeenCalledTimes(1);
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).toHaveBeenCalledWith(
      expect.objectContaining({ db: expect.anything() }),
      { orgId: ORG_ID, actorUserId: USER_ID, ruleId: RULE_ID, folders: [{ folderId: 'drv-2', folderName: 'Contracts' }] },
    );
    const claimUpdate = creatorClaim.calls.find((call) => call.method === 'update');
    expect(claimUpdate?.args[0]).toEqual({ created_by_user_id: USER_ID });
    expect(creatorClaim.calls).toContainEqual({ method: 'is', args: ['created_by_user_id', null] });
  });

  it('review P2: handleUpdateRule AWAITS the mirror before responding, and the response carries its real per-folder outcome', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const currentRow = tableMock({
      select: {
        data: {
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'] },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
          org_id: ORG_ID,
        },
        error: null,
      },
    });
    const ruleUpdate = tableMock({ update: { error: null, count: 1 } });
    stub.from.mockImplementation(scriptedFrom(profiles.from(''), membership.from(''), currentRow.from(''), ruleUpdate.from('')));

    let resolveMirror!: (v: MirrorConnectedDriveFolderResult[]) => void;
    driveFolderMirrorMock.mirrorConnectedDriveFolders.mockImplementationOnce(
      () => new Promise<MirrorConnectedDriveFolderResult[]>((resolve) => { resolveMirror = resolve; }),
    );

    const { res, json } = mockRes();
    const handlerPromise = handleUpdateRule(
      USER_ID,
      mockReq({
        params: { id: RULE_ID },
        body: {
          trigger_config: {
            vendors: ['google_drive'],
            drive_folders: [{ type: 'drive_folder', folder_id: 'drv-2', folder_name: 'Contracts' }],
          },
          action_type: 'AUTO_ANCHOR',
          action_config: { tag: 'connector-google_drive' },
        },
      }),
      res,
    );

    await waitUntilCalled(driveFolderMirrorMock.mirrorConnectedDriveFolders);
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();

    resolveMirror([{ folderId: 'folder-2', driveFolderId: 'drv-2', outcome: 'existing' }]);
    await handlerPromise;

    expect(json).toHaveBeenCalledWith({
      ok: true,
      drive_folder_mirror: [{ folderId: 'folder-2', driveFolderId: 'drv-2', outcome: 'existing' }],
    });
  });

  it('rejects enable-only PATCH when the stored rule config is malformed', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const malformedStoredRule = tableMock({
      select: {
        data: {
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'], folder_id: 'drv-orphan' },
          action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-google-drive' }, enabled: false,
          org_id: ORG_ID, created_by_user_id: USER_ID,
        },
        error: null,
      },
    });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), malformedStoredRule.from('')),
    );

    const { res, status, json } = mockRes();
    await handleUpdateRule(USER_ID, mockReq({ params: { id: RULE_ID }, body: { enabled: true } }), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: 'invalid_config' }) }),
    );
    expect(malformedStoredRule.calls.some((call) => call.method === 'update')).toBe(false);
  });

  it('accepts a valid stored legacy single-folder rule on enable-only PATCH without re-deriving the mirror', async () => {
    const profiles = tableMock({ select: { data: { org_id: ORG_ID }, error: null } });
    const membership = adminMembership();
    const enableRaceCheck = tableMock({
      select: {
        data: {
          trigger_type: 'WORKSPACE_FILE_MODIFIED',
          trigger_config: { vendors: ['google_drive'], type: 'drive_folder', folder_id: 'drv-legacy' },
          action_type: 'AUTO_ANCHOR', action_config: { tag: 'connector-google_drive' }, enabled: false,
          org_id: ORG_ID, created_by_user_id: USER_ID,
        },
        error: null,
      },
    });
    const raceLookup = tableMock({ select: { data: null, error: null } });
    const ruleUpdate = tableMock({ update: { error: null, count: 1 } });
    stub.from.mockImplementation(
      scriptedFrom(profiles.from(''), membership.from(''), enableRaceCheck.from(''), enableRaceCheck.from(''), raceLookup.from(''), ruleUpdate.from('')),
    );

    const { res, json } = mockRes();
    await handleUpdateRule(USER_ID, mockReq({ params: { id: RULE_ID }, body: { enabled: true } }), res);

    expect(json).toHaveBeenCalledWith({ ok: true });
    expect(driveFolderMirrorMock.mirrorConnectedDriveFolders).not.toHaveBeenCalled();
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
