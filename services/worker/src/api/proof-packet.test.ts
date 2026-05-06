/**
 * Tests for SCRUM-1149 — audit proof packet export.
 *
 * AC:
 *   - Export includes source event, normalized metadata, rule match, action,
 *     actor, timestamps, anchor receipt, version lineage, revocation/supersede,
 *     verification URI.
 *   - JSON first, PDF later.
 *   - Aligned with Phase 1.5 verification API response fields.
 *   - Org-scoped, audit-logged.
 *   - Handles missing anchor receipt gracefully for queued/unanchored items.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const profilesMaybeSingle = vi.fn();
const executionsMaybeSingle = vi.fn();
const ruleEventMaybeSingle = vi.fn();
const ruleMaybeSingle = vi.fn();
const anchorMaybeSingle = vi.fn();
// SCRUM-1593 AC4/AC5: supersede chain walk + parent walk.
// Both query the `anchors` table with different `.eq('id'|'parent_anchor_id', ...)` filters.
// We dispatch by inspecting the eq-call args to keep one mock per query type.
const supersedeMaybeSingle = vi.fn();
const parentChainMaybeSingleByAnchorId = new Map<string, () => Promise<{ data: unknown; error: unknown }>>();
const auditInsert = vi.fn();

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  const profilesChain = {
    select: () => ({ eq: () => ({ maybeSingle: () => profilesMaybeSingle() }) }),
  };
  const executionsChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: () => executionsMaybeSingle() }),
      }),
    }),
  };
  const ruleEventsChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: () => ruleEventMaybeSingle() }),
      }),
    }),
  };
  const rulesChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: () => ruleMaybeSingle() }),
      }),
    }),
  };
  // SCRUM-1149 + SCRUM-1593: the `anchors` table is queried for THREE distinct
  // shapes from proof-packet.ts. We dispatch by the eq-call args:
  //   1. loadAnchor:                .eq('org_id').eq('metadata->>external_file_id').order().limit(1).maybeSingle()
  //   2. loadSupersededByPublicId:  .eq('org_id').eq('parent_anchor_id', <id>).is('deleted_at', null).order().limit(1).maybeSingle()
  //   3. loadLineagePrevious:       .eq('org_id').eq('id', <parentId>).is('deleted_at', null).maybeSingle()
  // CodeRabbit ASSERTIVE on PR #695: shapes 2 and 3 gained an `.is('deleted_at',
  // null)` filter so soft-deleted anchors don't surface in lineage / supersede
  // responses. Mock chain extended to support it.
  const anchorsChain = {
    select: () => ({
      eq: (_orgCol: string, _orgVal: string) => ({
        eq: (col: string, val: string) => {
          if (col === 'metadata->>external_file_id') {
            return {
              order: () => ({
                limit: () => ({ maybeSingle: () => anchorMaybeSingle() }),
              }),
            };
          }
          if (col === 'parent_anchor_id') {
            return {
              is: (_deletedCol: string, _nullVal: null) => ({
                order: () => ({
                  limit: () => ({ maybeSingle: () => supersedeMaybeSingle() }),
                }),
              }),
            };
          }
          if (col === 'id') {
            const fn = parentChainMaybeSingleByAnchorId.get(val);
            return {
              is: (_deletedCol: string, _nullVal: null) => ({
                maybeSingle: () => (fn ? fn() : Promise.resolve({ data: null, error: null })),
              }),
            };
          }
          throw new Error(`unexpected anchors filter: ${col}`);
        },
      }),
    }),
  };
  const auditChain = {
    insert: (...args: unknown[]) => auditInsert(...args),
  };
  return {
    db: {
      from: (table: string) => {
        if (table === 'profiles') return profilesChain;
        if (table === 'organization_rule_executions') return executionsChain;
        if (table === 'organization_rule_events') return ruleEventsChain;
        if (table === 'organization_rules') return rulesChain;
        if (table === 'anchors') return anchorsChain;
        if (table === 'audit_events') return auditChain;
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
});

const { handleProofPacketExport } = await import('./proof-packet.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXEC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RULE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function buildRes() {
  let statusCode: number | undefined;
  let body: unknown;
  let cdHeader: string | null = null;
  const json = vi.fn((payload: unknown) => { body = payload; });
  const status = vi.fn((code: number) => { statusCode = code; return { json }; });
  const setHeader = vi.fn((name: string, val: string) => {
    if (name.toLowerCase() === 'content-disposition') cdHeader = val;
  });
  const res = { status, json, setHeader } as unknown as Response;
  return {
    res, status, json, setHeader,
    get body() { return body; },
    get statusCode() { return statusCode; },
    get cdHeader() { return cdHeader; },
  };
}

function buildReq(params: Record<string, string>): Request {
  return { params, query: {}, headers: {}, body: {} } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  profilesMaybeSingle.mockResolvedValue({ data: { org_id: ORG_ID }, error: null });
  executionsMaybeSingle.mockResolvedValue({
    data: {
      id: EXEC_ID,
      rule_id: RULE_ID,
      org_id: ORG_ID,
      trigger_event_id: 'evt-1',
      status: 'SUCCEEDED',
      input_payload: { match_reason: 'matched' },
      output_payload: { outcome: 'webhook_delivered' },
      error: null,
      attempt_count: 1,
      started_at: '2026-04-24T12:00:00Z',
      completed_at: '2026-04-24T12:00:01Z',
      created_at: '2026-04-24T11:59:59Z',
    },
    error: null,
  });
  ruleEventMaybeSingle.mockResolvedValue({
    data: {
      id: 'evt-1',
      org_id: ORG_ID,
      trigger_type: 'ESIGN_COMPLETED',
      vendor: 'docusign',
      external_file_id: 'env-123',
      filename: 'msa.pdf',
      sender_email: 'signer@example.com',
      payload: { source: 'docusign_connect' },
      created_at: '2026-04-24T11:55:00Z',
    },
    error: null,
  });
  ruleMaybeSingle.mockResolvedValue({
    data: {
      id: RULE_ID,
      org_id: ORG_ID,
      name: 'Notify on signed contract',
      description: null,
      trigger_type: 'ESIGN_COMPLETED',
      action_type: 'NOTIFY',
      action_config: { channels: ['email'] },
    },
    error: null,
  });
  anchorMaybeSingle.mockResolvedValue({
    data: {
      id: 'aid_main',
      public_id: 'pid_acmemsa1',
      status: 'SECURED',
      fingerprint: 'sha256:abc',
      bitcoin_tx_id: 'txid_abc',
      block_height: 800001,
      revoked_at: null,
      revocation_reason: null,
      parent_anchor_id: null,
      version_number: 1,
    },
    error: null,
  });
  supersedeMaybeSingle.mockResolvedValue({ data: null, error: null });
  parentChainMaybeSingleByAnchorId.clear();
  auditInsert.mockResolvedValue({ error: null });
});

describe('handleProofPacketExport (SCRUM-1149)', () => {
  it('rejects callers without an organization with 403', async () => {
    profilesMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when execution does not belong to caller org', async () => {
    executionsMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(404);
  });

  it('returns the full packet shape with all required sections', async () => {
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(200);
    const packet = ctx.body as {
      schema_version: number;
      execution: { id: string; status: string };
      source_event: { trigger_type: string; vendor: string };
      rule: { id: string; name: string; action_type: string };
      action: { type: string; outcome: string };
      timestamps: { event_received_at: string; action_started_at: string; action_completed_at: string };
      anchor_receipt: { public_id: string; bitcoin_tx_id: string | null; verification_uri: string };
      lineage: { previous: unknown[]; revoked_at: string | null; superseded_by_public_id: string | null };
      actor: { user_id: string };
    };
    expect(packet.schema_version).toBeGreaterThanOrEqual(1);
    expect(packet.execution.id).toBe(EXEC_ID);
    expect(packet.source_event.trigger_type).toBe('ESIGN_COMPLETED');
    expect(packet.rule.action_type).toBe('NOTIFY');
    expect(packet.action.outcome).toBe('webhook_delivered');
    expect(packet.timestamps.event_received_at).toBe('2026-04-24T11:55:00Z');
    expect(packet.anchor_receipt.public_id).toBe('pid_acmemsa1');
    expect(packet.anchor_receipt.verification_uri).toBe('https://app.arkova.io/verify/pid_acmemsa1');
    expect(packet.actor.user_id).toBe(USER_ID);
  });

  it('writes a PROOF_PACKET_EXPORTED audit row scoped to caller org', async () => {
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    expect(auditInsert).toHaveBeenCalledTimes(1);
    const insert = auditInsert.mock.calls[0][0] as { event_type: string; org_id: string; actor_id: string };
    expect(insert.event_type).toBe('PROOF_PACKET_EXPORTED');
    expect(insert.org_id).toBe(ORG_ID);
    expect(insert.actor_id).toBe(USER_ID);
  });

  it('handles missing anchor receipt gracefully (queued/unanchored items)', async () => {
    anchorMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    expect(ctx.status).toHaveBeenCalledWith(200);
    const packet = ctx.body as {
      anchor_receipt: { public_id: string | null; bitcoin_tx_id: string | null; verification_uri: string | null; status: string };
    };
    expect(packet.anchor_receipt.public_id).toBeNull();
    expect(packet.anchor_receipt.verification_uri).toBeNull();
    expect(packet.anchor_receipt.status).toBe('not_anchored');
  });

  it('reports revocation status when the anchor was revoked', async () => {
    anchorMaybeSingle.mockResolvedValueOnce({
      data: {
        id: 'aid_main',
        public_id: 'pid_acmemsa1',
        status: 'REVOKED',
        fingerprint: 'sha256:abc',
        bitcoin_tx_id: 'txid_abc',
        block_height: 800001,
        revoked_at: '2026-04-25T00:00:00Z',
        revocation_reason: 'Replaced by terminal version',
        parent_anchor_id: null,
        version_number: 1,
      },
      error: null,
    });
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    const packet = ctx.body as {
      lineage: { revoked_at: string | null; revocation_reason: string | null };
    };
    expect(packet.lineage.revoked_at).toBe('2026-04-25T00:00:00Z');
    expect(packet.lineage.revocation_reason).toContain('Replaced by terminal version');
  });

  it('attaches a Content-Disposition header so browsers download the JSON', async () => {
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    expect(ctx.cdHeader).toMatch(/attachment.*proof-packet/i);
    expect(ctx.cdHeader).toContain('.json');
  });

  it('does not expose internal anchor.id or org_id in response (CLAUDE.md §6)', async () => {
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    const body = ctx.body as {
      anchor_receipt: Record<string, unknown>;
      org_id?: unknown;
    };
    // Per CLAUDE.md §6 the banned identifiers are user_id / org_id / anchors.id.
    // Execution + rule UUIDs are first-class surface identifiers (audit
    // references them by id), so we only assert the anchor_receipt block
    // and the top-level org_id are clean.
    expect(body.org_id).toBeUndefined();
    expect(Object.keys(body.anchor_receipt)).not.toContain('id');
  });

  // SCRUM-1593 AC4 / AC5 — supersede chain walk
  it('lineage.superseded_by_public_id is set when a child anchor names this anchor as parent', async () => {
    supersedeMaybeSingle.mockResolvedValueOnce({
      data: { public_id: 'pid_acmemsa2' },
      error: null,
    });
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    const packet = ctx.body as { lineage: { superseded_by_public_id: string | null } };
    expect(packet.lineage.superseded_by_public_id).toBe('pid_acmemsa2');
  });

  it('lineage.previous walks the parent_anchor_id chain and exposes only public-safe columns', async () => {
    // Current anchor v3 → parent v2 → grandparent v1.
    anchorMaybeSingle.mockResolvedValueOnce({
      data: {
        id: 'aid_v3',
        public_id: 'pid_v3',
        status: 'SECURED',
        fingerprint: 'sha256:v3',
        bitcoin_tx_id: 'txid_v3',
        block_height: 800003,
        revoked_at: null,
        revocation_reason: null,
        parent_anchor_id: 'aid_v2',
        version_number: 3,
      },
      error: null,
    });
    parentChainMaybeSingleByAnchorId.set('aid_v2', () => Promise.resolve({
      data: {
        public_id: 'pid_v2',
        status: 'SUPERSEDED',
        fingerprint: 'sha256:v2',
        parent_anchor_id: 'aid_v1',
        version_number: 2,
        created_at: '2026-04-23T00:00:00Z',
      },
      error: null,
    }));
    parentChainMaybeSingleByAnchorId.set('aid_v1', () => Promise.resolve({
      data: {
        public_id: 'pid_v1',
        status: 'SUPERSEDED',
        fingerprint: 'sha256:v1',
        parent_anchor_id: null,
        version_number: 1,
        created_at: '2026-04-22T00:00:00Z',
      },
      error: null,
    }));
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    const packet = ctx.body as {
      lineage: {
        previous: Array<Record<string, unknown>>;
      };
    };
    expect(packet.lineage.previous).toHaveLength(2);
    expect(packet.lineage.previous[0]).toEqual({
      public_id: 'pid_v2',
      version_number: 2,
      status: 'SUPERSEDED',
      fingerprint: 'sha256:v2',
      created_at: '2026-04-23T00:00:00Z',
    });
    expect(packet.lineage.previous[1]).toEqual({
      public_id: 'pid_v1',
      version_number: 1,
      status: 'SUPERSEDED',
      fingerprint: 'sha256:v1',
      created_at: '2026-04-22T00:00:00Z',
    });
    // Internal UUIDs MUST NOT leak through the chain walk.
    for (const entry of packet.lineage.previous) {
      expect(Object.keys(entry)).not.toContain('id');
      expect(Object.keys(entry)).not.toContain('parent_anchor_id');
    }
  });

  it('lineage.previous bounded by depth cap — cycle in parent_anchor_id does not hang', async () => {
    // Adversarial: A → B → A. Should stop at the duplicate visit, not loop.
    anchorMaybeSingle.mockResolvedValueOnce({
      data: {
        id: 'aid_A',
        public_id: 'pid_A',
        status: 'SECURED',
        fingerprint: 'sha256:A',
        bitcoin_tx_id: null,
        block_height: null,
        revoked_at: null,
        revocation_reason: null,
        parent_anchor_id: 'aid_B',
        version_number: 2,
      },
      error: null,
    });
    parentChainMaybeSingleByAnchorId.set('aid_B', () => Promise.resolve({
      data: {
        public_id: 'pid_B',
        status: 'SUPERSEDED',
        fingerprint: 'sha256:B',
        parent_anchor_id: 'aid_A',
        version_number: 1,
        created_at: '2026-04-21T00:00:00Z',
      },
      error: null,
    }));
    parentChainMaybeSingleByAnchorId.set('aid_A', () => Promise.resolve({
      data: {
        public_id: 'pid_A',
        status: 'SECURED',
        fingerprint: 'sha256:A',
        parent_anchor_id: 'aid_B',
        version_number: 2,
        created_at: '2026-04-22T00:00:00Z',
      },
      error: null,
    }));
    const ctx = buildRes();
    await handleProofPacketExport(USER_ID, buildReq({ executionId: EXEC_ID }), ctx.res);
    const packet = ctx.body as { lineage: { previous: unknown[] } };
    // Cycle guard — at most 2 unique entries (B, A) before the cycle is detected.
    expect(packet.lineage.previous.length).toBeLessThanOrEqual(2);
  });
});
