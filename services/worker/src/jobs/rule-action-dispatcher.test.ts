/**
 * Tests for SCRUM-1142 — rule action dispatcher MVP.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEmitOrgAdminNotifications = vi.fn();
const mockFetch = vi.fn();
const mockGetSecret = vi.fn();
const mockSubmitJob = vi.fn();
const mockDbRpc = vi.fn();
const mockLoggerWarn = vi.fn();

interface ExecutionRow {
  id: string;
  rule_id: string;
  org_id: string;
  trigger_event_id: string;
  status: string;
  attempt_count: number;
  input_payload: Record<string, unknown>;
}

interface RuleRow {
  id: string;
  org_id: string;
  name: string;
  action_type: string;
  action_config: Record<string, unknown>;
}

interface AnchorInsert {
  fingerprint: string;
  status: string;
  org_id: string;
  user_id: string;
  filename: string;
  credential_type: string;
  metadata: Record<string, unknown>;
}

const dbState = {
  executions: [] as ExecutionRow[],
  rules: new Map<string, RuleRow>(),
  finalUpdates: new Map<string, Record<string, unknown>>(),
  anchorInserts: [] as AnchorInsert[],
  anchorInsertError: null as { message: string; code?: string } | null,
  orgMembers: [{ user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'owner' }],
};

// Org-credit enforcement is OFF by default in production config. The
// FAST_TRACK_ANCHOR path now goes through the shared `deductOrgCredit`
// helper (SCRUM-1647 follow-up: bug #6), which short-circuits to allowed=true
// when the flag is off. The dispatcher tests below pin the AC behavior on
// the gated path (the 1649 PRD ACs are written against credit enforcement
// being live), so flip the flag on in the per-test config mock.
vi.mock('../config.js', () => ({ config: { enableOrgCreditEnforcement: true } }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: (...args: unknown[]) => mockEmitOrgAdminNotifications(...args),
}));
vi.mock('../utils/secrets.js', () => ({
  resolveSecretHandle: (...args: unknown[]) => mockGetSecret(...args),
}));
vi.mock('../utils/jobQueue.js', () => ({
  submitJob: (...args: unknown[]) => mockSubmitJob(...args),
}));

vi.mock('../utils/db.js', () => {
  // The dispatcher issues three Supabase chains per pass:
  //   A) executions: .select(cols).in('status', [..]).order(..).limit(..)
  //   B) rules:      .select(cols).in('id', [..])
  //   C) executions: .update(patch).eq('id', execId)        (per-row finalize)
  //
  // The proxy below mirrors that shape: select-chain stays chainable until
  // `.limit()`, update-chain becomes awaited at `.eq('id', ..)`.
  const executionsSelectChain = () => {
    const limit = async () => ({ data: dbState.executions, error: null });
    const order = () => ({ limit });
    const inFn = (_col: string, _vals: unknown[]) => ({ order, limit });
    return { in: inFn, order, limit };
  };

  const executionsUpdateChain = (patch: Record<string, unknown>) => {
    let capturedId: string | null = null;
    // The race-guarded UPDATE chains `.eq('id', X).eq('status', Y)`.
    // First eq returns the chain; second eq resolves to the supabase result.
    const chain: Record<string, unknown> = {};
    chain.eq = (col: string, val: unknown) => {
      if (col === 'id') {
        capturedId = String(val);
        // Return a chainable that supports a follow-up `.eq('status', ...)`.
        const next: Record<string, unknown> = {};
        next.eq = async () => {
          if (capturedId) dbState.finalUpdates.set(capturedId, patch);
          return { error: null };
        };
        return next;
      }
      return { error: null };
    };
    return chain;
  };

  const buildExecutionsBuilder = () => ({
    select: (_cols?: string) => executionsSelectChain(),
    update: (patch: Record<string, unknown>) => executionsUpdateChain(patch),
  });

  const buildRulesBuilder = () => ({
    select: () => ({
      in: async () => ({ data: [...dbState.rules.values()], error: null }),
    }),
  });

  const buildAnchorsBuilder = () => ({
    insert: (payload: AnchorInsert) => ({
      select: () => ({
        single: async () => {
          if (dbState.anchorInsertError) {
            return { data: null, error: dbState.anchorInsertError };
          }
          dbState.anchorInserts.push(payload);
          return {
            data: {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              public_id: 'ARK-2026-ABCD1234',
              fingerprint: payload.fingerprint,
              status: payload.status,
              created_at: '2026-05-13T12:00:00.000Z',
            },
            error: null,
          };
        },
      }),
    }),
  });

  const buildOrgMembersBuilder = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: dbState.orgMembers[0] ?? null, error: null }),
    };
    return chain;
  };

  return {
    db: {
      from: (table: string) => {
        if (table === 'organization_rule_executions') return buildExecutionsBuilder();
        if (table === 'organization_rules') return buildRulesBuilder();
        if (table === 'anchors') return buildAnchorsBuilder();
        if (table === 'org_members') return buildOrgMembersBuilder();
        throw new Error(`unexpected table: ${table}`);
      },
      rpc: (...args: unknown[]) => mockDbRpc(...args),
    },
  };
});

const { runRuleActionDispatcher, MAX_DISPATCH_ATTEMPTS } = await import('./rule-action-dispatcher.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RULE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXEC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const defaultExec: ExecutionRow = {
  id: EXEC_ID,
  rule_id: RULE_ID,
  org_id: ORG_ID,
  trigger_event_id: 'evt-1',
  status: 'PENDING',
  attempt_count: 0,
  input_payload: {
    match_reason: 'matched',
    trigger_type: 'ESIGN_COMPLETED',
    vendor: 'docusign',
    external_file_id: 'env-1',
    filename: 'signed-msa.pdf',
    sender_email: 'sender@example.com',
    payload: {
      source: 'docusign_connect',
      integration_id: 'int-1',
      account_id: 'acct-1',
      envelope_id: 'env-1',
      document_sha256: 'a'.repeat(64),
    },
  },
};

const defaultRule: RuleRow = {
  id: RULE_ID,
  org_id: ORG_ID,
  name: 'Notify on signed contract',
  action_type: 'NOTIFY',
  action_config: {
    channels: ['email'],
    recipient_user_ids: [],
    recipient_emails: ['ops@example.com'],
  },
};

function setScenario(opts: { executions?: ExecutionRow[]; rule?: RuleRow | null } = {}) {
  dbState.executions = opts.executions ?? [defaultExec];
  dbState.rules = new Map();
  if (opts.rule !== null) {
    const r = opts.rule ?? defaultRule;
    dbState.rules.set(r.id, r);
  }
  dbState.finalUpdates = new Map();
  dbState.anchorInserts = [];
  dbState.anchorInsertError = null;
  dbState.orgMembers = [{ user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'owner' }];
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENABLE_RULE_ACTION_DISPATCHER;
  mockGetSecret.mockResolvedValue('test-secret-bytes');
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
  mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
  // Default: deduct_org_credit succeeds with balance 100→99. Tests that need
  // insufficient_credits explicitly override per-test via mockDbRpc.
  mockDbRpc.mockResolvedValue({ data: { success: true, balance: 99, deducted: 1 }, error: null });
  mockSubmitJob.mockResolvedValue('job-fast-track-1');
});

describe('rule-action-dispatcher MVP (SCRUM-1142)', () => {
  it('NOTIFY: emits org admin notifications and marks SUCCEEDED', async () => {
    setScenario();
    const result = await runRuleActionDispatcher();
    expect(result.dispatched).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockEmitOrgAdminNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rule_fired', organizationId: ORG_ID }),
    );
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('SUCCEEDED');
    expect(final?.completed_at).toBeDefined();
    expect((final?.output_payload as { outcome: string }).outcome).toBe('notification_sent');
  });

  it('QUEUE_FOR_REVIEW: marks SUCCEEDED with routed_to=review_queue (compliance inbox)', async () => {
    setScenario({
      rule: {
        ...defaultRule,
        action_type: 'QUEUE_FOR_REVIEW',
        action_config: { label: 'pii-detected', priority: 'high' },
      },
    });
    const result = await runRuleActionDispatcher();
    expect(result.succeeded).toBe(1);
    const final = dbState.finalUpdates.get(EXEC_ID);
    const out = final?.output_payload as { outcome: string; routed_to: string; priority?: string };
    expect(out.outcome).toBe('queued_for_review');
    expect(out.routed_to).toBe('review_queue');
    expect(out.priority).toBe('high');
  });

  it('FLAG_COLLISION: marks SUCCEEDED with routed_to=collision', async () => {
    setScenario({
      rule: {
        ...defaultRule,
        action_type: 'FLAG_COLLISION',
        action_config: { window_minutes: 5 },
      },
    });
    const result = await runRuleActionDispatcher();
    expect(result.succeeded).toBe(1);
    const final = dbState.finalUpdates.get(EXEC_ID);
    const out = final?.output_payload as { outcome: string; routed_to: string };
    expect(out.outcome).toBe('flagged_collision');
    expect(out.routed_to).toBe('collision');
  });

  it('FORWARD_TO_URL: posts signed webhook with HMAC and marks SUCCEEDED', async () => {
    setScenario({
      rule: {
        ...defaultRule,
        action_type: 'FORWARD_TO_URL',
        action_config: {
          target_url: 'https://example.com/hooks/arkova',
          hmac_secret_handle: 'sm:webhook_a',
          timeout_ms: 5000,
        },
      },
    });
    const result = await runRuleActionDispatcher();
    expect(result.succeeded).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://example.com/hooks/arkova');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['Content-Type']).toBe('application/json');
    expect(typeof headers['X-Arkova-Signature']).toBe('string');
    expect(headers['X-Arkova-Signature'].length).toBeGreaterThan(20);
    expect(headers['X-Arkova-Timestamp']).toMatch(/^\d+$/);
    const final = dbState.finalUpdates.get(EXEC_ID);
    const out = final?.output_payload as { outcome: string; status_code?: number };
    expect(out.outcome).toBe('webhook_delivered');
    expect(out.status_code).toBe(200);
  });

  it('FORWARD_TO_URL: failure on non-2xx response, RETRYING when under max attempts', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal', text: async () => 'boom' });
    setScenario({
      rule: {
        ...defaultRule,
        action_type: 'FORWARD_TO_URL',
        action_config: {
          target_url: 'https://example.com/hooks/arkova',
          hmac_secret_handle: 'sm:webhook_a',
          timeout_ms: 5000,
        },
      },
    });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('RETRYING');
    expect(typeof final?.error).toBe('string');
    expect(final?.error).toContain('500');
  });

  it('FORWARD_TO_URL: parks in DLQ once attempt_count reaches MAX_DISPATCH_ATTEMPTS', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '' });
    setScenario({
      executions: [{ ...defaultExec, attempt_count: MAX_DISPATCH_ATTEMPTS - 1 }],
      rule: {
        ...defaultRule,
        action_type: 'FORWARD_TO_URL',
        action_config: {
          target_url: 'https://example.com/hooks/arkova',
          hmac_secret_handle: 'sm:webhook_a',
          timeout_ms: 5000,
        },
      },
    });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('DLQ');
    expect(final?.completed_at).toBeDefined();
  });

  // Pre-SCRUM-1649: AUTO_ANCHOR was treated as unknown. Post-1649, AUTO_ANCHOR
  // routes to the org anchor queue (DS-07). Truly-unknown action_types still
  // fail closed — pinned with a synthetic action_type that will never be wired.
  it('truly-unknown action types fail closed and are visible in run history', async () => {
    setScenario({
      rule: { ...defaultRule, action_type: 'NEPTUNE_DRIFT', action_config: {} },
    });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('FAILED');
    expect(typeof final?.error).toBe('string');
    expect(final?.error as string).toContain('NEPTUNE_DRIFT');
    expect(final?.completed_at).toBeDefined();
  });

  it('NOTIFY missing required metadata: fail closed with visible error (FAILED, not DLQ)', async () => {
    setScenario({
      rule: {
        ...defaultRule,
        action_type: 'NOTIFY',
        action_config: { channels: [] }, // invalid: requires >=1 channel
      },
    });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('FAILED');
    expect(typeof final?.error).toBe('string');
  });

  it('respects ENABLE_RULE_ACTION_DISPATCHER=false (no-op pass)', async () => {
    process.env.ENABLE_RULE_ACTION_DISPATCHER = 'false';
    setScenario();
    const result = await runRuleActionDispatcher();
    expect(result.dispatched).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('parent rule missing fails the execution closed with a clear error', async () => {
    setScenario({ rule: null });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('FAILED');
    expect(final?.error as string).toMatch(/rule.*not.*found/i);
  });

  // ─── SCRUM-1649 DS-AUTO-02 — anchor action routing (DS-06 + DS-07) ─────
  // Red baseline. These tests fail until [Implement] (SCRUM-1657) wires
  // AUTO_ANCHOR + FAST_TRACK_ANCHOR through the dispatcher to the org
  // anchor queue / anchor job pipeline with `deduct_org_credit` fall-through.

  it('AUTO_ANCHOR (DS-07): SUCCEEDED with routed_to=anchor_queue and no credit movement', async () => {
    setScenario({
      rule: { ...defaultRule, action_type: 'AUTO_ANCHOR', action_config: {} },
    });
    const result = await runRuleActionDispatcher();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockDbRpc).not.toHaveBeenCalledWith('deduct_org_credit', expect.anything());
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('SUCCEEDED');
    const out = final?.output_payload as {
      outcome: string;
      routed_to: string;
      credit_denial_reason: string | null;
    };
    expect(out.outcome).toBe('queued_for_anchor');
    expect(out.routed_to).toBe('anchor_queue');
    expect(out.credit_denial_reason).toBeNull();
  });

  it('AUTO_ANCHOR (DS-07): materializes a PENDING DocuSign anchor row for the org queue', async () => {
    setScenario({
      executions: [
        {
          ...defaultExec,
          input_payload: {
            match_reason: 'esign_completed:docusign',
            trigger_type: 'ESIGN_COMPLETED',
            vendor: 'docusign',
            external_file_id: 'env-1',
            filename: 'signed-msa.pdf',
            sender_email: 'sender@example.com',
            payload: {
              source: 'docusign_connect',
              integration_id: 'int-1',
              account_id: 'acct-1',
              envelope_id: 'env-1',
              document_sha256: 'a'.repeat(64),
            },
          },
        },
      ],
      rule: { ...defaultRule, action_type: 'AUTO_ANCHOR', action_config: { tag: 'signed-contract' } },
    });

    const result = await runRuleActionDispatcher();

    expect(result.succeeded).toBe(1);
    expect(dbState.anchorInserts).toHaveLength(1);
    expect(dbState.anchorInserts[0]).toMatchObject({
      fingerprint: 'a'.repeat(64),
      status: 'PENDING',
      org_id: ORG_ID,
      user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      filename: 'docusign/signed-msa.pdf',
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: expect.objectContaining({
        connector_source: 'docusign',
        external_file_id: 'env-1',
        source_envelope_id: 'env-1',
        rule_action_type: 'AUTO_ANCHOR',
        rule_tag: 'signed-contract',
        credit_denial_reason: null,
        account_id_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        sender_email_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(JSON.stringify(dbState.anchorInserts[0].metadata)).not.toContain('sender@example.com');
    expect(JSON.stringify(dbState.anchorInserts[0].metadata)).not.toContain('acct-1');
    expect(JSON.stringify(dbState.anchorInserts[0].metadata)).not.toContain(RULE_ID);
    expect(JSON.stringify(dbState.anchorInserts[0].metadata)).not.toContain(EXEC_ID);
    const final = dbState.finalUpdates.get(EXEC_ID);
    const out = final?.output_payload as { anchor_public_id?: string; anchor_materialized?: boolean };
    expect(out.anchor_materialized).toBe(true);
    expect(out.anchor_public_id).toBe('ARK-2026-ABCD1234');
  });

  it('FAST_TRACK_ANCHOR (DS-06) with credits: deducts via RPC and submits anchor job', async () => {
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    const result = await runRuleActionDispatcher();
    expect(result.succeeded).toBe(1);
    expect(dbState.anchorInserts).toHaveLength(1);
    expect(dbState.anchorInserts[0]).toMatchObject({
      fingerprint: 'a'.repeat(64),
      status: 'PENDING',
      org_id: ORG_ID,
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: expect.objectContaining({
        connector_source: 'docusign',
        rule_action_type: 'FAST_TRACK_ANCHOR',
      }),
    });
    expect(mockDbRpc).toHaveBeenCalledWith(
      'deduct_org_credit',
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_amount: 1,
        p_reason: 'rule.fast_track_anchor',
      }),
    );
    expect(mockSubmitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'anchor.fast_track',
        payload: expect.objectContaining({
          org_id: ORG_ID,
          rule_id: RULE_ID,
          execution_id: EXEC_ID,
          trigger_event_id: 'evt-1',
          anchor_public_id: 'ARK-2026-ABCD1234',
        }),
      }),
    );
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('SUCCEEDED');
    const out = final?.output_payload as {
      outcome: string;
      routed_to: string;
      anchor_materialized?: boolean;
      anchor_public_id?: string;
    };
    expect(out.outcome).toBe('anchor_dispatched');
    expect(out.routed_to).toBe('anchor_pipeline');
    expect(out.anchor_materialized).toBe(true);
    expect(out.anchor_public_id).toBe('ARK-2026-ABCD1234');
  });

  it('FAST_TRACK_ANCHOR (DS-06): recomputes invalid sender_email_sha256 input before anchor metadata', async () => {
    setScenario({
      executions: [
        {
          ...defaultExec,
          input_payload: {
            ...defaultExec.input_payload,
            sender_email: 'Sender@Example.com ',
            sender_email_sha256: 'not-a-sha256',
          },
        },
      ],
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });

    const result = await runRuleActionDispatcher();

    expect(result.succeeded).toBe(1);
    expect(dbState.anchorInserts).toHaveLength(1);
    expect(dbState.anchorInserts[0].metadata.sender_email_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(dbState.anchorInserts[0].metadata.sender_email_sha256).not.toBe('not-a-sha256');
  });

  it('FAST_TRACK_ANCHOR (DS-06): deterministic payload errors fail without deducting credit', async () => {
    setScenario({
      executions: [
        {
          ...defaultExec,
          input_payload: {
            ...defaultExec.input_payload,
            payload: {
              source: 'docusign_connect',
              integration_id: 'int-1',
              account_id: 'acct-1',
              envelope_id: 'env-1',
            },
          },
        },
      ],
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });

    const result = await runRuleActionDispatcher();

    expect(result.failed).toBe(1);
    expect(mockDbRpc).not.toHaveBeenCalledWith('deduct_org_credit', expect.anything());
    expect(mockSubmitJob).not.toHaveBeenCalled();
    expect(dbState.anchorInserts).toHaveLength(0);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('FAILED');
    expect(final?.error as string).toMatch(/document SHA-256 fingerprint/i);
  });

  it('FAST_TRACK_ANCHOR (DS-06): sanitizes anchor payload validation issue logs', async () => {
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    dbState.orgMembers = [{ user_id: 'not-a-uuid', role: 'owner' }];

    const result = await runRuleActionDispatcher();

    expect(result.failed).toBe(1);
    expect(mockDbRpc).not.toHaveBeenCalledWith('deduct_org_credit', expect.anything());
    const validationLog = mockLoggerWarn.mock.calls.find(
      ([, message]) => message === 'anchor queue materialization payload failed validation',
    );
    expect(validationLog).toBeDefined();
    const [fields] = validationLog as [Record<string, unknown>, string];
    expect(fields.issues).toEqual([
      expect.objectContaining({ code: expect.any(String), path: ['user_id'] }),
    ]);
    const serializedIssues = JSON.stringify(fields.issues);
    expect(serializedIssues).not.toContain('message');
    expect(serializedIssues).not.toContain('not-a-uuid');
  });

  it('FAST_TRACK_ANCHOR (DS-06): paid anchor insert failure after credit deduction refunds and retries', async () => {
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    dbState.anchorInsertError = { message: 'database unavailable' };

    const result = await runRuleActionDispatcher();

    expect(result.failed).toBe(1);
    expect(mockDbRpc).toHaveBeenCalledWith('deduct_org_credit', expect.anything());
    expect(mockDbRpc).toHaveBeenCalledWith('refund_org_credit', {
      p_org_id: ORG_ID,
      p_amount: 1,
      p_reason: 'rule.fast_track_anchor_compensation',
      p_reference_id: EXEC_ID,
    });
    expect(mockSubmitJob).not.toHaveBeenCalled();
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('RETRYING');
    expect(final?.error as string).toMatch(/credit refunded/i);
  });

  it('FAST_TRACK_ANCHOR (DS-06): insufficient-credit anchor insert failure is retryable', async () => {
    mockDbRpc.mockResolvedValueOnce({
      data: { success: false, error: 'insufficient_credits', balance: 0, required: 1 },
      error: null,
    });
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    dbState.anchorInsertError = { message: 'database unavailable' };

    const result = await runRuleActionDispatcher();

    expect(result.failed).toBe(1);
    expect(mockDbRpc).toHaveBeenCalledWith('deduct_org_credit', expect.anything());
    expect(mockSubmitJob).not.toHaveBeenCalled();
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('RETRYING');
    expect(final?.error as string).toMatch(/anchor queue materialization insert failed/i);
  });

  it('FAST_TRACK_ANCHOR (DS-06) without credits: falls through to anchor queue with credit_denial_reason', async () => {
    mockDbRpc.mockResolvedValueOnce({
      data: { success: false, error: 'insufficient_credits', balance: 0, required: 1 },
      error: null,
    });
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    const result = await runRuleActionDispatcher();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    // RPC was called (and refused), no anchor job dispatched
    expect(mockDbRpc).toHaveBeenCalledWith('deduct_org_credit', expect.anything());
    expect(mockSubmitJob).not.toHaveBeenCalled();
    expect(dbState.anchorInserts).toHaveLength(1);
    expect(dbState.anchorInserts[0]).toMatchObject({
      fingerprint: 'a'.repeat(64),
      status: 'PENDING',
      org_id: ORG_ID,
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: expect.objectContaining({
        connector_source: 'docusign',
        rule_action_type: 'FAST_TRACK_ANCHOR',
        credit_denial_reason: 'insufficient_credits',
      }),
    });
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('SUCCEEDED');
    const out = final?.output_payload as {
      outcome: string;
      routed_to: string;
      credit_denial_reason: string;
      anchor_materialized?: boolean;
      anchor_public_id?: string;
    };
    expect(out.outcome).toBe('queued_for_anchor');
    expect(out.routed_to).toBe('anchor_queue');
    expect(out.credit_denial_reason).toBe('insufficient_credits');
    expect(out.anchor_materialized).toBe(true);
    expect(out.anchor_public_id).toBe('ARK-2026-ABCD1234');
  });

  it('FAST_TRACK_ANCHOR (DS-06): credit RPC throw is transient — RETRYING under max attempts', async () => {
    mockDbRpc.mockRejectedValueOnce(new Error('database connection lost'));
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    expect(dbState.anchorInserts).toHaveLength(0);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('RETRYING');
    expect(mockSubmitJob).not.toHaveBeenCalled();
  });

  it('FAST_TRACK_ANCHOR (Codex P1): submitJob failure AFTER credit deduction refunds and retries', async () => {
    // deduct_org_credit succeeds (default mock) but the queue refuses the
    // anchor job. The dispatcher compensates with refund_org_credit before
    // retrying so the retry loop cannot double-charge the org.
    mockSubmitJob.mockResolvedValueOnce(null);
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    expect(mockDbRpc).toHaveBeenCalledWith('refund_org_credit', {
      p_org_id: ORG_ID,
      p_amount: 1,
      p_reason: 'rule.fast_track_anchor_compensation',
      p_reference_id: EXEC_ID,
    });
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('RETRYING');
    expect(final?.error as string).toMatch(/credit refunded/i);
  });

  it('FAST_TRACK_ANCHOR (DS-06): org_not_initialized is permanent failure (not retryable)', async () => {
    mockDbRpc.mockResolvedValueOnce({
      data: { success: false, error: 'org_not_initialized' },
      error: null,
    });
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    const result = await runRuleActionDispatcher();
    expect(result.failed).toBe(1);
    expect(dbState.anchorInserts).toHaveLength(0);
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('FAILED');
    expect(final?.error as string).toMatch(/org_not_initialized/i);
  });
});
