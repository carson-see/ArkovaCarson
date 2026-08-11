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
// INSTANT_SECURE (founder directive, 2026-08-03): after the shared credit +
// anchor-materialization path succeeds, INSTANT_SECURE additionally kicks an
// immediate per-org batch-anchor pass instead of only relying on the
// standard triggers — that extra call is what makes "instant" actually true
// rather than a same-queue rename of AUTO_ANCHOR. Mocked here so dispatcher
// tests never pull in the real chain/treasury machinery.
const mockProcessBatchAnchors = vi.fn();

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

interface AnchorLookupRow {
  id?: string;
  public_id: string;
  status: string;
  created_at?: string;
}

interface JobQueueRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
}

const dbState = {
  executions: [] as ExecutionRow[],
  rules: new Map<string, RuleRow>(),
  finalUpdates: new Map<string, Record<string, unknown>>(),
  anchorInserts: [] as AnchorInsert[],
  existingAnchors: [] as AnchorLookupRow[],
  jobQueueRows: [] as JobQueueRow[],
  anchorInsertError: null as { message: string; code?: string } | null,
  orgMembers: [{ user_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'owner' }],
};

// Org-credit enforcement is OFF by default in production config. The
// FAST_TRACK_ANCHOR path now goes through the shared `deductOrgCredit`
// helper (SCRUM-1647 follow-up: bug #6), which short-circuits to allowed=true
// when the flag is off. The dispatcher tests below pin the AC behavior on
// the gated path (the 1649 PRD ACs are written against credit enforcement
// being live), so flip the flag on in the per-test config mock.
// Mutable config mock so SCRUM-2904 reconciliation tests can flip the two
// connector flags per-test. Default both OFF → the declared-hash path is the
// writer (matching prod today), so every pre-existing test is unaffected.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    enableOrgCreditEnforcement: true,
    enableConnectorArtifactEnqueue: false,
    enableConnectorArtifactDrain: false,
  },
}));
vi.mock('../config.js', () => ({ config: mockConfig }));
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
vi.mock('./batch-anchor.js', () => ({
  processBatchAnchors: (...args: unknown[]) => mockProcessBatchAnchors(...args),
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

  const buildAnchorsBuilder = () => {
    const selectChain = {
      select: () => selectChain,
      eq: () => selectChain,
      is: () => selectChain,
      neq: () => selectChain,
      // SCRUM-2904 envelope-level guard queries add .or()/.limit(). The guard is
      // now ARRAY-terminal on .limit() (it dropped its SQL ORDER BY — that sort
      // made the planner ignore every metadata index and time out on the
      // 2.97M-anchor org). `.limit()` stays chainable for any other caller by
      // returning a thenable that also exposes .maybeSingle().
      or: () => selectChain,
      order: () => selectChain,
      limit: () => Object.assign(
        Promise.resolve({ data: dbState.existingAnchors, error: null }),
        { maybeSingle: async () => ({ data: dbState.existingAnchors[0] ?? null, error: null }) },
      ),
      maybeSingle: async () => ({ data: dbState.existingAnchors[0] ?? null, error: null }),
    };
    return {
      select: () => selectChain,
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
    };
  };

  const buildJobQueueBuilder = () => {
    let executionId: string | null = null;
    let type: string | null = null;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        if (col === 'type') type = String(val);
        if (col === 'payload->>execution_id') executionId = String(val);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({
        data: dbState.jobQueueRows.find((row) =>
          row.type === type && row.payload.execution_id === executionId
        ) ?? null,
        error: null,
      }),
    };
    return chain;
  };

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
        if (table === 'job_queue') return buildJobQueueBuilder();
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
  dbState.existingAnchors = [];
  dbState.jobQueueRows = [];
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
  mockProcessBatchAnchors.mockResolvedValue({ processed: 1, batchId: 'batch-1', merkleRoot: 'r', txId: 't' });
  // SCRUM-2904: reset connector flags OFF between tests (declared-hash writer).
  mockConfig.enableConnectorArtifactEnqueue = false;
  mockConfig.enableConnectorArtifactDrain = false;
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

  it('AUTO_ANCHOR (DS-07): accepts pre-hashed account metadata without raw account id retention', async () => {
    const accountIdSha256 = 'b'.repeat(64);
    setScenario({
      executions: [
        {
          ...defaultExec,
          input_payload: {
            ...defaultExec.input_payload,
            payload: {
              source: 'docusign_connect',
              integration_id: 'int-1',
              account_id_sha256: accountIdSha256,
              envelope_id: 'env-1',
              document_sha256: 'a'.repeat(64),
            },
          },
        },
      ],
      rule: { ...defaultRule, action_type: 'AUTO_ANCHOR', action_config: {} },
    });

    const result = await runRuleActionDispatcher();

    expect(result.succeeded).toBe(1);
    expect(dbState.anchorInserts[0].metadata.account_id_sha256).toBe(accountIdSha256);
    expect(JSON.stringify(dbState.anchorInserts[0].metadata)).not.toContain('acct-1');
  });

  // ─── Billing integrity: the charged credit must buy real acceleration ────
  //
  // FAST_TRACK_ANCHOR debits 1 credit and its shipped UI template
  // (`rule-templates-data.ts` `law-firm-contract`) promises "Instantly secure
  // fully-signed contracts as soon as all parties complete e-signature."
  // Before this fix the ONLY thing the debit bought was an `anchor.fast_track`
  // job_queue row that NO code claims — no consumer, so no retry, no
  // dead-letter, no error surface. The document was anchored by the nightly
  // batch anyway (exactly what free AUTO_ANCHOR gets), so the customer paid a
  // credit for zero acceleration. These two tests pin the invariant in both
  // directions: the acceleration happens, and no orphan job is produced.
  it('FAST_TRACK_ANCHOR (billing integrity): the charged credit buys a real immediate per-org batch pass', async () => {
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });

    const result = await runRuleActionDispatcher();

    expect(result.succeeded).toBe(1);
    expect(mockDbRpc).toHaveBeenCalledWith(
      'deduct_org_credit',
      expect.objectContaining({ p_amount: 1, p_reason: 'rule.fast_track_anchor' }),
    );
    // The credit was charged, so acceleration must actually be attempted.
    expect(mockProcessBatchAnchors).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, orgId: ORG_ID }),
    );
  });

  it('FAST_TRACK_ANCHOR (billing integrity): produces no unconsumed anchor.fast_track job', async () => {
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });

    await runRuleActionDispatcher();

    // `anchor.fast_track` has no claimJob/processNextJob consumer anywhere in
    // the worker. Enqueuing it writes a row that stays `pending` forever.
    expect(mockSubmitJob).not.toHaveBeenCalled();
  });

  it('FAST_TRACK_ANCHOR (DS-06) with credits: deducts via RPC and materializes the anchor', async () => {
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
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('SUCCEEDED');
    const out = final?.output_payload as {
      outcome: string;
      routed_to: string;
      anchor_materialized?: boolean;
      anchor_public_id?: string;
      immediate_batch_triggered?: boolean;
    };
    expect(out.outcome).toBe('anchor_dispatched');
    expect(out.routed_to).toBe('anchor_pipeline');
    expect(out.anchor_materialized).toBe(true);
    expect(out.anchor_public_id).toBe('ARK-2026-ABCD1234');
    expect(out.immediate_batch_triggered).toBe(true);
  });

  // Replaces the old "retry reuses the existing anchor.fast_track job" test.
  // The retry guard was never the job row: the credit RPC is idempotent on
  // `exec.id` (migration 0326 `UNIQUE(org_id, reference_id, reason)`) and the
  // anchor insert de-duplicates on 23505. With the orphan job gone, THOSE are
  // what a dispatcher retry must lean on — so that is what this pins.
  it('FAST_TRACK_ANCHOR (DS-06): a dispatcher retry re-charges nothing and inserts no duplicate anchor', async () => {
    mockDbRpc.mockResolvedValueOnce({
      data: { success: true, balance: 99, deducted: 0, idempotent: true },
      error: null,
    });
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });
    dbState.anchorInsertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
    dbState.existingAnchors = [{ public_id: 'ARK-2026-EXISTING', status: 'PENDING' }];

    const result = await runRuleActionDispatcher();

    expect(result.succeeded).toBe(1);
    expect(mockSubmitJob).not.toHaveBeenCalled();
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('SUCCEEDED');
    const out = final?.output_payload as {
      anchor_public_id?: string;
      duplicate_anchor?: boolean;
      deduction_idempotent?: boolean;
      immediate_batch_triggered?: boolean;
    };
    expect(out.anchor_public_id).toBe('ARK-2026-EXISTING');
    expect(out.duplicate_anchor).toBe(true);
    // `deducted: 0, idempotent: true` — the replay moved no credit.
    expect(out.deduction_idempotent).toBe(true);
    expect(out.immediate_batch_triggered).toBe(true);
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

  // Replaces the old "submitJob returned null → refund and retry" test. That
  // compensation branch guarded the enqueue of a job nothing consumed, so it
  // is gone with the job. The remaining downstream failure that must still
  // unwind the charge — the anchor insert — is pinned by the "paid anchor
  // insert failure ... refunds and retries" test above. What is NEW and needs
  // its own pin is the accelerator itself failing: the document is safely
  // PENDING, so this must NOT retry or unwind the charge, but the outcome has
  // to say so rather than silently claiming acceleration happened.
  it('FAST_TRACK_ANCHOR: a throwing immediate-batch pass stays SUCCEEDED but records immediate_batch_triggered=false', async () => {
    mockProcessBatchAnchors.mockRejectedValueOnce(new Error('treasury RPC unavailable'));
    setScenario({
      rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} },
    });

    const result = await runRuleActionDispatcher();

    expect(result.succeeded).toBe(1);
    expect(mockDbRpc).not.toHaveBeenCalledWith('refund_org_credit', expect.anything());
    const final = dbState.finalUpdates.get(EXEC_ID);
    expect(final?.status).toBe('SUCCEEDED');
    const out = final?.output_payload as { immediate_batch_triggered?: boolean };
    expect(out.immediate_batch_triggered).toBe(false);
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

  // ─── INSTANT_SECURE — founder directive 2026-08-03 ─────────────────────
  // "The 'Auto Secure' rule doesn't secure. ... we need to be able to
  // instantly secure or add to queue and we need rules to work." Reuses the
  // SAME shared credit-funded anchor path as FAST_TRACK_ANCHOR (deduct via
  // RPC, idempotent on organization_rule_executions.id, refund-and-retry on
  // a downstream failure after the charge) — every credit-safety assertion
  // below mirrors the FAST_TRACK_ANCHOR suite above by design, not by
  // coincidence. The one behavioral addition is the immediate per-org batch
  // trigger on success and the log/notify on the insufficient-credit
  // fallback (neither of which FAST_TRACK_ANCHOR's existing, unchanged
  // behavior gets — this PR does not touch FAST_TRACK_ANCHOR's outcomes).
  describe('INSTANT_SECURE (founder directive 2026-08-03)', () => {
    it('with credits: deducts via RPC keyed on execution id and kicks an immediate org batch pass', async () => {
      setScenario({
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
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
          rule_action_type: 'INSTANT_SECURE',
          credit_denial_reason: null,
        }),
      });
      // Idempotency key is the STABLE execution id, never attempt_count — a
      // dispatcher retry must reuse the same reference id so deduct_org_credit
      // (migration 0326, UNIQUE(org_id, reference_id, reason)) can detect the
      // replay and refuse to charge twice.
      expect(mockDbRpc).toHaveBeenCalledWith(
        'deduct_org_credit',
        expect.objectContaining({
          p_org_id: ORG_ID,
          p_amount: 1,
          p_reason: 'rule.instant_secure',
          p_reference_id: EXEC_ID,
        }),
      );
      // No orphan `anchor.fast_track` row: nothing in the worker claims that
      // type, so enqueuing it was a write nobody would ever read.
      expect(mockSubmitJob).not.toHaveBeenCalled();
      // The actual "instant" behavior: force a batch pass for THIS org now,
      // instead of waiting on the standard triggers.
      expect(mockProcessBatchAnchors).toHaveBeenCalledWith(
        expect.objectContaining({ force: true, orgId: ORG_ID }),
      );
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('SUCCEEDED');
      const out = final?.output_payload as {
        outcome: string;
        routed_to: string;
        anchor_materialized?: boolean;
        anchor_public_id?: string;
        immediate_batch_triggered?: boolean;
      };
      expect(out.outcome).toBe('anchor_dispatched');
      expect(out.routed_to).toBe('anchor_pipeline');
      expect(out.anchor_materialized).toBe(true);
      expect(out.anchor_public_id).toBe('ARK-2026-ABCD1234');
      expect(out.immediate_batch_triggered).toBe(true);
    });

    it('retry after a prior success does NOT double-charge — reuses the existing job and reports idempotent', async () => {
      mockDbRpc.mockResolvedValueOnce({
        data: { success: true, balance: 99, deducted: 0, idempotent: true },
        error: null,
      });
      setScenario({
        executions: [{ ...defaultExec, attempt_count: 1, status: 'RETRYING' }],
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
      });
      dbState.anchorInsertError = { code: '23505', message: 'duplicate key value violates unique constraint' };
      dbState.existingAnchors = [{ public_id: 'ARK-2026-EXISTING', status: 'PENDING' }];
      dbState.jobQueueRows = [{
        id: 'job-existing-instant',
        type: 'anchor.fast_track',
        payload: { execution_id: EXEC_ID },
        status: 'pending',
        created_at: '2026-08-03T12:00:00.000Z',
      }];

      const result = await runRuleActionDispatcher();

      expect(result.succeeded).toBe(1);
      expect(mockSubmitJob).not.toHaveBeenCalled();
      // The RETRY still passes the SAME reference id (the execution id, not
      // the now-incremented attempt_count) — this is what makes the RPC's
      // own idempotency check land on the same ledger row.
      expect(mockDbRpc).toHaveBeenCalledWith(
        'deduct_org_credit',
        expect.objectContaining({ p_reference_id: EXEC_ID, p_reason: 'rule.instant_secure' }),
      );
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('SUCCEEDED');
      const out = final?.output_payload as {
        anchor_public_id?: string;
        duplicate_anchor?: boolean;
        deduction_idempotent?: boolean;
      };
      expect(out.anchor_public_id).toBe('ARK-2026-EXISTING');
      expect(out.duplicate_anchor).toBe(true);
      expect(out.deduction_idempotent).toBe(true);
      // Still tries to accelerate the (reused) anchor on every dispatch pass —
      // harmless/idempotent on the batch side, and correct if the first
      // attempt's forced pass never actually ran (e.g. crashed before it).
      expect(mockProcessBatchAnchors).toHaveBeenCalledWith(
        expect.objectContaining({ force: true, orgId: ORG_ID }),
      );
    });

    it('without credits: falls back to the free queue (document is never dropped) and logs + notifies the org', async () => {
      mockDbRpc.mockResolvedValueOnce({
        data: { success: false, error: 'insufficient_credits', balance: 0, required: 1 },
        error: null,
      });
      setScenario({
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
      });
      const result = await runRuleActionDispatcher();
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockSubmitJob).not.toHaveBeenCalled();
      // No reason to force a batch pass early — the fallback anchor is a
      // plain free-queue item, swept by the normal triggers like any other.
      expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
      expect(dbState.anchorInserts).toHaveLength(1);
      expect(dbState.anchorInserts[0]).toMatchObject({
        status: 'PENDING',
        org_id: ORG_ID,
        metadata: expect.objectContaining({
          rule_action_type: 'INSTANT_SECURE',
          credit_denial_reason: 'insufficient_credits',
        }),
      });
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('SUCCEEDED');
      const out = final?.output_payload as { outcome: string; routed_to: string; credit_denial_reason: string };
      expect(out.outcome).toBe('queued_for_anchor');
      expect(out.routed_to).toBe('anchor_queue');
      expect(out.credit_denial_reason).toBe('insufficient_credits');
      // "log/notify so someone notices the fallback happened" — the founder
      // directive's explicit non-negotiable. Someone must be able to tell
      // this org that an INSTANT_SECURE rule silently degraded to the free
      // queue instead of assuming "instant" always means instant.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ ruleId: RULE_ID, executionId: EXEC_ID, orgId: ORG_ID }),
        expect.stringMatching(/insufficient.*credit/i),
      );
      expect(mockEmitOrgAdminNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'rule_fired',
          organizationId: ORG_ID,
          payload: expect.objectContaining({
            rule_id: RULE_ID,
            execution_id: EXEC_ID,
            reason: 'insufficient_credits',
          }),
        }),
      );
    });

    it('a throwing insufficient-credit notification does NOT turn a correctly-queued fallback into a failure', async () => {
      // The fallback anchor is already safely queued — a notification-
      // delivery outage is best-effort visibility on top of it, never a
      // reason to retry (which would risk a confusing second notification
      // attempt racing the org's own credit top-up).
      mockDbRpc.mockResolvedValueOnce({
        data: { success: false, error: 'insufficient_credits', balance: 0, required: 1 },
        error: null,
      });
      mockEmitOrgAdminNotifications.mockRejectedValueOnce(new Error('notification service unavailable'));
      setScenario({
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
      });
      const result = await runRuleActionDispatcher();
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('SUCCEEDED');
      const out = final?.output_payload as { credit_denial_reason: string };
      expect(out.credit_denial_reason).toBe('insufficient_credits');
    });

    it('credit RPC throw is transient — RETRYING, no anchor, no batch trigger', async () => {
      mockDbRpc.mockRejectedValueOnce(new Error('database connection lost'));
      setScenario({
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
      });
      const result = await runRuleActionDispatcher();
      expect(result.failed).toBe(1);
      expect(dbState.anchorInserts).toHaveLength(0);
      expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('RETRYING');
      expect(mockSubmitJob).not.toHaveBeenCalled();
    });

    it('org_not_initialized is a permanent failure (not retryable)', async () => {
      mockDbRpc.mockResolvedValueOnce({ data: { success: false, error: 'org_not_initialized' }, error: null });
      setScenario({
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
      });
      const result = await runRuleActionDispatcher();
      expect(result.failed).toBe(1);
      expect(dbState.anchorInserts).toHaveLength(0);
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('FAILED');
      expect(final?.error as string).toMatch(/org_not_initialized/i);
    });

    it('anchor insert failure AFTER credit deduction refunds (compensation reason distinct from FAST_TRACK_ANCHOR) and retries', async () => {
      setScenario({
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
      });
      dbState.anchorInsertError = { message: 'database unavailable' };

      const result = await runRuleActionDispatcher();

      expect(result.failed).toBe(1);
      expect(mockDbRpc).toHaveBeenCalledWith('deduct_org_credit', expect.anything());
      expect(mockDbRpc).toHaveBeenCalledWith('refund_org_credit', {
        p_org_id: ORG_ID,
        p_amount: 1,
        p_reason: 'rule.instant_secure_compensation',
        p_reference_id: EXEC_ID,
      });
      expect(mockSubmitJob).not.toHaveBeenCalled();
      expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('RETRYING');
      expect(final?.error as string).toMatch(/credit refunded/i);
    });

    it('a throwing immediate-batch trigger does NOT turn a successful dispatch into a failure (best-effort acceleration only)', async () => {
      // The credit was charged and the anchor safely queued either way — an
      // outage in the accelerator must never look like a lost document or a
      // reason to retry (which would risk relying on refund/retry logic that
      // was never meant to unwind a step this far downstream).
      mockProcessBatchAnchors.mockRejectedValueOnce(new Error('treasury RPC unavailable'));
      setScenario({
        rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} },
      });
      const result = await runRuleActionDispatcher();
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
      const final = dbState.finalUpdates.get(EXEC_ID);
      expect(final?.status).toBe('SUCCEEDED');
      const out = final?.output_payload as { outcome: string };
      expect(out.outcome).toBe('anchor_dispatched');
    });

    it('DEFERS to the connector path (SCRUM-2904) and moves NO credit when both connector flags are on', async () => {
      mockConfig.enableConnectorArtifactEnqueue = true;
      mockConfig.enableConnectorArtifactDrain = true;
      setScenario({ rule: { ...defaultRule, action_type: 'INSTANT_SECURE', action_config: {} } });

      const result = await runRuleActionDispatcher();

      expect(result.succeeded).toBe(1);
      expect(dbState.anchorInserts).toHaveLength(0);
      expect(mockDbRpc).not.toHaveBeenCalled();
      expect(mockSubmitJob).not.toHaveBeenCalled();
      expect(mockProcessBatchAnchors).not.toHaveBeenCalled();
      const out = dbState.finalUpdates.get(EXEC_ID)?.output_payload as { outcome: string };
      expect(out.outcome).toBe('deferred_to_connector');
    });
  });

  // ── SCRUM-2904: dual-path DocuSign reconciliation ─────────────────────────
  describe('SCRUM-2904 dual-path reconciliation (declared-hash defers to connector)', () => {
    function enableConnectorPath() {
      mockConfig.enableConnectorArtifactEnqueue = true;
      mockConfig.enableConnectorArtifactDrain = true;
    }

    it('AUTO_ANCHOR DEFERS to the connector path when both flags on — no anchor, no double-anchor', async () => {
      enableConnectorPath();
      setScenario({ rule: { ...defaultRule, action_type: 'AUTO_ANCHOR', action_config: {} } });

      const result = await runRuleActionDispatcher();

      expect(result.succeeded).toBe(1);
      // The declared-hash path materialized NOTHING — the server-fetched
      // connector path is the single writer for this docusign envelope.
      expect(dbState.anchorInserts).toHaveLength(0);
      const out = dbState.finalUpdates.get(EXEC_ID)?.output_payload as {
        outcome: string;
        routed_to: string;
        anchor_materialized?: boolean;
      };
      expect(out.outcome).toBe('deferred_to_connector');
      expect(out.routed_to).toBe('connector_pipeline');
      expect(out.anchor_materialized).toBe(false);
    });

    it('FAST_TRACK_ANCHOR DEFERS and moves NO credit when both flags on', async () => {
      enableConnectorPath();
      setScenario({ rule: { ...defaultRule, action_type: 'FAST_TRACK_ANCHOR', action_config: {} } });

      const result = await runRuleActionDispatcher();

      expect(result.succeeded).toBe(1);
      expect(dbState.anchorInserts).toHaveLength(0);
      // No credit deduction RPC — defer happens BEFORE any charge.
      expect(mockDbRpc).not.toHaveBeenCalled();
      expect(mockSubmitJob).not.toHaveBeenCalled();
      const out = dbState.finalUpdates.get(EXEC_ID)?.output_payload as { outcome: string };
      expect(out.outcome).toBe('deferred_to_connector');
    });

    it('does NOT defer when the DRAIN flag is off — declared-hash stays the writer (no silent data loss)', async () => {
      // pre-mortem #1: deferring into an enqueue-but-no-drain path would strand
      // the envelope forever. So the declared-hash path must still anchor it.
      mockConfig.enableConnectorArtifactEnqueue = true;
      mockConfig.enableConnectorArtifactDrain = false;
      setScenario({ rule: { ...defaultRule, action_type: 'AUTO_ANCHOR', action_config: {} } });

      await runRuleActionDispatcher();

      expect(dbState.anchorInserts).toHaveLength(1);
      const out = dbState.finalUpdates.get(EXEC_ID)?.output_payload as { outcome: string };
      expect(out.outcome).toBe('queued_for_anchor');
    });

    it('does NOT defer when both flags off — backward-compatible prod default', async () => {
      setScenario({ rule: { ...defaultRule, action_type: 'AUTO_ANCHOR', action_config: {} } });

      await runRuleActionDispatcher();

      expect(dbState.anchorInserts).toHaveLength(1);
      const out = dbState.finalUpdates.get(EXEC_ID)?.output_payload as { outcome: string };
      expect(out.outcome).toBe('queued_for_anchor');
    });

    it('envelope-level guard: AUTO_ANCHOR reuses an anchor already created for the same envelope (flag-flip race) — single anchor', async () => {
      // Both flags OFF here (so no deferral), but the connector path had
      // previously anchored this envelope under an earlier flag state. The
      // envelope-level guard finds it and REUSES it instead of inserting a
      // second, distinct anchor — the core "one document → one anchor" guarantee
      // even when the two paths' fingerprints differ.
      dbState.existingAnchors = [{
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        public_id: 'ARK-2026-CONNECTOR',
        status: 'PENDING',
        created_at: '2026-05-10T00:00:00.000Z',
      }];
      setScenario({ rule: { ...defaultRule, action_type: 'AUTO_ANCHOR', action_config: {} } });
      // setScenario resets existingAnchors — re-set after.
      dbState.existingAnchors = [{
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        public_id: 'ARK-2026-CONNECTOR',
        status: 'PENDING',
        // SCRUM-2904-perf (migration 0381): findExistingEnvelopeAnchor now
        // issues one .eq('metadata->>KEY', ...) lookup PER key and compares
        // `created_at` across the (at most 3) matches in application code to
        // pick the earliest — the fixture row must carry a real created_at for
        // the stub's generic anchors-table SELECT to be treated as a candidate.
        created_at: '2026-05-10T00:00:00.000Z',
      }];

      const result = await runRuleActionDispatcher();

      expect(result.succeeded).toBe(1);
      // No NEW insert — the existing connector anchor is reused.
      expect(dbState.anchorInserts).toHaveLength(0);
      const out = dbState.finalUpdates.get(EXEC_ID)?.output_payload as {
        duplicate_anchor?: boolean;
        anchor_public_id?: string;
      };
      expect(out.duplicate_anchor).toBe(true);
      expect(out.anchor_public_id).toBe('ARK-2026-CONNECTOR');
    });
  });
});
