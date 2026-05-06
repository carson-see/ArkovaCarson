/**
 * Tests for ARK-106 rules engine queue lifecycle.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockSelect = vi.fn();
const mockIn = vi.fn();
const mockEq = vi.fn();
const mockUpsert = vi.fn();
const mockEmitOrgAdminNotifications = vi.fn();

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../notifications/dispatcher.js', () => ({
  emitOrgAdminNotifications: (...args: unknown[]) => mockEmitOrgAdminNotifications(...args),
}));
vi.mock('../utils/db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

const { runRulesEngine } = await import('./rules-engine.js');

const EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  org_id: '22222222-2222-4222-8222-222222222222',
  trigger_type: 'ESIGN_COMPLETED',
  vendor: 'docusign',
  filename: 'msa.pdf',
  folder_path: null,
  sender_email: 'sender@example.com',
  subject: null,
};

const MATCHING_RULE = {
  id: '33333333-3333-4333-8333-333333333333',
  org_id: EVENT.org_id,
  name: 'Secure signed contracts',
  enabled: true,
  trigger_type: 'ESIGN_COMPLETED',
  trigger_config: { vendors: ['docusign'] },
  action_type: 'AUTO_ANCHOR',
  action_config: {},
};

function mockClaim(events = [EVENT]) {
  mockRpc.mockImplementation((name: string) => {
    if (name === 'claim_pending_rule_events') return Promise.resolve({ data: events, error: null });
    if (name === 'complete_claimed_rule_events') return Promise.resolve({ data: events.length, error: null });
    if (name === 'release_claimed_rule_events') return Promise.resolve({ data: events.length, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

function mockRules(rows: unknown[]) {
  mockEq.mockResolvedValue({ data: rows, error: null });
}

function wireFromMock() {
  mockSelect.mockReturnValue({ in: mockIn });
  mockIn.mockReturnValue({ eq: mockEq });
  mockFrom.mockImplementation((table: string) => {
    if (table === 'organization_rules') return { select: mockSelect };
    if (table === 'organization_rule_executions') return { upsert: mockUpsert };
    throw new Error(`unexpected table ${table}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENABLE_RULES_ENGINE;
  wireFromMock();
  mockClaim();
  mockRules([MATCHING_RULE]);
  mockUpsert.mockResolvedValue({ error: null });
});

describe('runRulesEngine', () => {
  it('persists matching executions and completes claimed events after success', async () => {
    const result = await runRulesEngine();

    expect(result).toMatchObject({
      events_processed: 1,
      matches_recorded: 1,
      errors: 0,
    });
    expect(mockUpsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          rule_id: MATCHING_RULE.id,
          trigger_event_id: EVENT.id,
          org_id: EVENT.org_id,
          status: 'PENDING',
        }),
      ],
      { onConflict: 'rule_id,trigger_event_id', ignoreDuplicates: true },
    );
    expect(mockRpc).toHaveBeenCalledWith('complete_claimed_rule_events', {
      p_event_ids: [EVENT.id],
    });
    expect(mockRpc).not.toHaveBeenCalledWith(
      'release_claimed_rule_events',
      expect.anything(),
    );
  });

  it('completes claimed events even when no enabled rules match', async () => {
    mockRules([]);

    const result = await runRulesEngine();

    expect(result).toMatchObject({
      events_processed: 1,
      matches_recorded: 0,
      skipped: 1,
      errors: 0,
    });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('complete_claimed_rule_events', {
      p_event_ids: [EVENT.id],
    });
  });

  it('releases claimed events when execution persistence fails', async () => {
    mockUpsert.mockResolvedValueOnce({ error: { message: 'db down' } });

    const result = await runRulesEngine();

    expect(result.errors).toBe(1);
    expect(mockRpc).toHaveBeenCalledWith('release_claimed_rule_events', {
      p_event_ids: [EVENT.id],
      p_error: 'Rule execution persistence failed',
    });
    expect(mockRpc).not.toHaveBeenCalledWith(
      'complete_claimed_rule_events',
      expect.anything(),
    );
  });

  it('releases claimed events when enabled rule lookup fails', async () => {
    mockEq.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });

    const result = await runRulesEngine();

    expect(result.errors).toBe(1);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('release_claimed_rule_events', {
      p_event_ids: [EVENT.id],
      p_error: 'Rules fetch failed',
    });
  });
});

describe('runRulesEngine concurrency + retry contract (SCRUM-1590)', () => {
  it('claim is bounded — calls claim_pending_rule_events with p_limit=200', async () => {
    await runRulesEngine();

    expect(mockRpc).toHaveBeenCalledWith('claim_pending_rule_events', { p_limit: 200 });
  });

  it('empty claim — no complete/release calls when nothing pending', async () => {
    mockClaim([]);

    const result = await runRulesEngine();

    expect(result).toMatchObject({
      events_processed: 0,
      matches_recorded: 0,
      skipped: 0,
      errors: 0,
    });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith('claim_pending_rule_events', { p_limit: 200 });
    expect(mockRpc).not.toHaveBeenCalledWith(
      'complete_claimed_rule_events',
      expect.anything(),
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      'release_claimed_rule_events',
      expect.anything(),
    );
  });

  it('disabled engine — ENABLE_RULES_ENGINE=false skips claim entirely', async () => {
    process.env.ENABLE_RULES_ENGINE = 'false';

    const result = await runRulesEngine();

    expect(result).toMatchObject({
      events_processed: 0,
      matches_recorded: 0,
      errors: 0,
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('multi-org tick — bulk-fetches rules via .in() across all org_ids, partitions matches per org', async () => {
    const ORG_A = '22222222-2222-4222-8222-222222222222';
    const ORG_B = '99999999-9999-4999-8999-999999999999';
    const EVENT_A = { ...EVENT, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', org_id: ORG_A };
    const EVENT_B = { ...EVENT, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', org_id: ORG_B };
    const RULE_A = { ...MATCHING_RULE, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', org_id: ORG_A };
    const RULE_B = { ...MATCHING_RULE, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', org_id: ORG_B };

    mockClaim([EVENT_A, EVENT_B]);
    mockRules([RULE_A, RULE_B]);

    const result = await runRulesEngine();

    expect(result.events_processed).toBe(2);
    expect(result.matches_recorded).toBe(2);
    expect(result.errors).toBe(0);
    // Bulk fetch: a single .in([orgA, orgB]) call, not N round-trips.
    expect(mockIn).toHaveBeenCalledTimes(1);
    expect(mockIn).toHaveBeenCalledWith('org_id', expect.arrayContaining([ORG_A, ORG_B]));
    // Each org's match is persisted under its own rule_id.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: RULE_A.id, trigger_event_id: EVENT_A.id, org_id: ORG_A }),
        expect.objectContaining({ rule_id: RULE_B.id, trigger_event_id: EVENT_B.id, org_id: ORG_B }),
      ]),
      expect.objectContaining({ onConflict: 'rule_id,trigger_event_id', ignoreDuplicates: true }),
    );
    // Both events flip to PROCESSED in a single complete call — not partial.
    expect(mockRpc).toHaveBeenCalledWith('complete_claimed_rule_events', {
      p_event_ids: expect.arrayContaining([EVENT_A.id, EVENT_B.id]),
    });
  });

  it('release passes the full claimed batch (not a subset) so retry attempts stay accurate', async () => {
    const EVENT_X = { ...EVENT, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    mockClaim([EVENT, EVENT_X]);
    mockUpsert.mockResolvedValueOnce({ error: { message: 'db down' } });

    const result = await runRulesEngine();

    expect(result.errors).toBe(1);
    // Both event IDs flow to release — release RPC owns attempt_count >= 5 → FAILED
    // demotion (migration 0247:275-289), so the worker MUST hand it the full
    // claim batch or in-flight retries lose their attempt counter.
    expect(mockRpc).toHaveBeenCalledWith('release_claimed_rule_events', {
      p_event_ids: expect.arrayContaining([EVENT.id, EVENT_X.id]),
      p_error: 'Rule execution persistence failed',
    });
    expect(mockRpc).not.toHaveBeenCalledWith(
      'complete_claimed_rule_events',
      expect.anything(),
    );
  });
});
