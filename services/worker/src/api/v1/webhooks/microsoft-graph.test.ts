/**
 * Tests for Microsoft Graph change-notifications webhook (SCRUM-1138 R2 closeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const integrationLookup = vi.fn();
const nonceInsert = vi.fn(); // legacy guard: should not be called after migration 0291
const enqueueRpc = vi.fn();

const mockConfig: { microsoftGraphClientState?: string } = {};
vi.mock('../../../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../utils/db.js', () => {
  // Mirrors findIntegrationBySubscription's PostgREST chain after the
  // PR #695 fix: connector_subscriptions has no `revoked_at` column;
  // liveness is the `status` text field, so the chain ends with `.neq('status',
  // 'revoked').maybeSingle()`. Pre-fix this was `.is('revoked_at', null)` —
  // would have errored at runtime in prod the moment ENABLE_MICROSOFT_GRAPH_WEBHOOK
  // flipped on. CodeRabbit ASSERTIVE on PR #695.
  const subscriptionsChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          neq: () => ({ maybeSingle: () => integrationLookup() }),
        }),
      }),
    }),
  };
  const noncesChain = {
    insert: (...args: unknown[]) => nonceInsert(...args),
  };
  return {
    db: {
      from: (table: string) => {
        if (table === 'connector_subscriptions') return subscriptionsChain;
        if (table === 'microsoft_graph_webhook_nonces') return noncesChain;
        throw new Error(`unexpected table ${table}`);
      },
      rpc: (...args: unknown[]) => enqueueRpc(...args),
    },
  };
});

const { microsoftGraphWebhookRouter } = await import('./microsoft-graph.js');

const ORG_ID = 'org-aaaaaaaa';
const INTEGRATION_ID = 'int-bbbbbbbb';
const SUB_ID = 'sub-cccccccc';
const CLIENT_STATE = 'shared-secret-test';
const RESOURCE_ID = 'res-dddddddd';

function buildReq(overrides: Partial<{ body: unknown; query: Record<string, string> }>): Request {
  const body = overrides.body ?? {};
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    body,
    query: overrides.query ?? {},
    headers: {},
    rawBody,
    path: '/',
    method: 'POST',
  } as unknown as Request;
}

function buildRes() {
  let statusCode: number | undefined;
  let body: unknown;
  let textBody: string | undefined;
  const json = vi.fn((payload: unknown) => { body = payload; });
  const send = vi.fn((payload: string) => { textBody = payload; });
  const type = vi.fn(() => ({ send }));
  const status = vi.fn((code: number) => { statusCode = code; return { json, send, type }; });
  const setHeader = vi.fn();
  const res = { status, json, send, type, setHeader } as unknown as Response;
  return {
    res, status, json, send, type, setHeader,
    get statusCode() { return statusCode; },
    get body() { return body; },
    get textBody() { return textBody; },
  };
}

async function callRouter(req: Request, res: Response): Promise<void> {
  const layer = (microsoftGraphWebhookRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: { post: boolean }; stack: Array<{ handle: (r: Request, s: Response) => Promise<void> }> } }>;
  }).stack;
  const routeLayer = layer.find((l) => l.route?.path === '/' && l.route.methods.post);
  if (!routeLayer?.route) throw new Error('router shape changed');
  await routeLayer.route.stack[0].handle(req, res);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.microsoftGraphClientState = CLIENT_STATE;
  integrationLookup.mockResolvedValue({
    data: { org_integrations: { id: INTEGRATION_ID, org_id: ORG_ID } },
    error: null,
  });
  nonceInsert.mockResolvedValue({ error: null });
  // Migration 0291: record_msgraph_nonce_and_enqueue is the single compound
  // RPC the handler calls. RETURNS TABLE(rule_event_id UUID, duplicate BOOL)
  // surfaces as an array of rows via PostgREST.
  enqueueRpc.mockResolvedValue({
    data: [{ rule_event_id: 'evt_msgraph_1', duplicate: false }],
    error: null,
  });
});

afterEach(() => {
  delete mockConfig.microsoftGraphClientState;
});

describe('microsoft-graph webhook (SCRUM-1138 R2 closeout)', () => {
  it('validation handshake: echoes validationToken back as text/plain', async () => {
    const ctx = buildRes();
    const req = buildReq({ query: { validationToken: 'abc-token-xyz' } });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(200);
    expect(ctx.type).toHaveBeenCalledWith('text/plain');
    expect(ctx.send).toHaveBeenCalledWith('abc-token-xyz');
    expect(enqueueRpc).not.toHaveBeenCalled();
  });

  it('validation handshake rejects 400 when token contains unsafe characters (XSS reflection guard)', async () => {
    const ctx = buildRes();
    const req = buildReq({ query: { validationToken: '<script>alert(1)</script>' } });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(400);
    expect(ctx.send).toHaveBeenCalledWith('invalid_validation_token');
  });

  it('validation handshake rejects 400 when token exceeds max length', async () => {
    const ctx = buildRes();
    const req = buildReq({ query: { validationToken: 'a'.repeat(2000) } });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(400);
  });

  it('validation handshake rejects 400 when token is empty string', async () => {
    const ctx = buildRes();
    const req = buildReq({ query: { validationToken: '' } });
    await callRouter(req, ctx.res);
    // empty string ≠ null in our handler — treated as a present-but-empty token
    expect(ctx.statusCode).toBe(400);
  });

  it('rejects 503 when microsoftGraphClientState is unset', async () => {
    delete mockConfig.microsoftGraphClientState;
    const ctx = buildRes();
    const req = buildReq({ body: { value: [] } });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(503);
  });

  it('rejects 400 when value[] is missing or empty', async () => {
    const ctx = buildRes();
    await callRouter(buildReq({ body: { value: [] } }), ctx.res);
    expect(ctx.statusCode).toBe(400);
  });

  it('rejects 401 when ALL items fail clientState constant-time compare', async () => {
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: 'attacker-supplied',
            resource: 'sites/site-1/drive/items/' + RESOURCE_ID,
            resourceData: { id: RESOURCE_ID, name: 'doc.docx' },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(401);
    expect(enqueueRpc).not.toHaveBeenCalled();
  });

  it('enqueues a sharepoint event when clientState matches and resource is /sites/...', async () => {
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/site-1/drive/items/' + RESOURCE_ID,
            resourceData: { id: RESOURCE_ID, name: 'msa.docx' },
            changeType: 'updated',
            tenantId: '00000000-0000-0000-0000-000000000000',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    const rpcName = enqueueRpc.mock.calls[0]?.[0] as string;
    expect(rpcName).toBe('record_msgraph_nonce_and_enqueue');
    const enqueueArgs = enqueueRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(enqueueArgs.p_org_id).toBe(ORG_ID);
    expect(enqueueArgs.p_trigger_type).toBe('WORKSPACE_FILE_MODIFIED');
    expect(enqueueArgs.p_vendor).toBe('sharepoint');
    expect(enqueueArgs.p_external_file_id).toBe(RESOURCE_ID);
    expect(enqueueArgs.p_subscription_id).toBe(SUB_ID);
    expect(enqueueArgs.p_resource_id).toBe(RESOURCE_ID);
    expect(enqueueArgs.p_change_type).toBe('updated');
    expect(typeof enqueueArgs.p_payload_hash).toBe('string');
    expect((enqueueArgs.p_payload_hash as string).length).toBe(64); // sha256 hex
    const payload = enqueueArgs.p_payload as Record<string, unknown>;
    expect(payload.source).toBe('microsoft_graph');
    expect(payload.integration_id).toBe(INTEGRATION_ID);
    expect(payload.change_type).toBe('updated');
    // Direct .from('microsoft_graph_webhook_nonces').insert() is no longer
    // called; the compound RPC handles both the nonce row + enqueue atomically.
    expect(nonceInsert).not.toHaveBeenCalled();
  });

  it('routes /me/drive/... resource to vendor=onedrive', async () => {
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: '/me/drive/items/' + RESOURCE_ID,
            resourceData: { id: RESOURCE_ID, name: 'personal.docx' },
            changeType: 'created',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    const enqueueArgs = enqueueRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(enqueueArgs.p_vendor).toBe('onedrive');
  });

  it('skips items for unknown subscriptions without affecting valid ones in the same batch', async () => {
    integrationLookup
      .mockResolvedValueOnce({ data: null, error: null }) // unknown sub
      .mockResolvedValueOnce({ data: { org_integrations: { id: INTEGRATION_ID, org_id: ORG_ID } }, error: null });
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: 'unknown-sub',
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1' },
            changeType: 'updated',
          },
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/y/drive/items/r2',
            resourceData: { id: 'r2' },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    const body = ctx.body as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(1);
    expect(body.skipped).toBe(1);
    expect(enqueueRpc).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when integration lookup fails transiently and nothing was enqueued', async () => {
    // CodeRabbit ASSERTIVE on PR #695: a connector_subscriptions DB outage
    // must NOT be ack'd as `unknown_subscription` + 202. Graph stops retrying
    // on 2xx, so silent drop. New behavior: lookupFailed is tracked; if it
    // fired and zero items enqueued, surface 503 so Graph retries the batch.
    // The nonce dedupe table protects against double-delivery on retry.
    integrationLookup.mockResolvedValue({
      data: null,
      error: { message: 'pg connection refused', code: 'ECONNREFUSED' },
    });
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1' },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(503);
    const body = ctx.body as { error: { code: string } };
    expect(body.error.code).toBe('integration_lookup_failed');
    expect(enqueueRpc).not.toHaveBeenCalled();
  });

  it('partial lookup failure: still 202 when at least one item enqueued (lookup-failed item just skipped)', async () => {
    integrationLookup
      .mockResolvedValueOnce({ data: null, error: { message: 'transient' } })
      .mockResolvedValueOnce({ data: { org_integrations: { id: INTEGRATION_ID, org_id: ORG_ID } }, error: null });
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: 'will-fail-lookup',
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1' },
            changeType: 'updated',
          },
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/y/drive/items/r2',
            resourceData: { id: 'r2' },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    expect(enqueueRpc).toHaveBeenCalledTimes(1);
  });

  it('Zod gate: rejects items with non-string subscriptionId (was passed through ad-hoc check before)', async () => {
    // CodeRabbit ASSERTIVE on PR #695: replace the ad-hoc field-presence
    // check with a proper Zod parse so wrong types and out-of-bounds
    // strings never reach the DB write paths.
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: 12345, // wrong type
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1' },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    // Single item, all malformed → falls through to 202 with skipped[]
    // (Graph would retry-storm on 4xx for clearly-attacker-controllable shapes).
    expect(ctx.statusCode).toBe(202);
    const body = ctx.body as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toBe(1);
    expect(enqueueRpc).not.toHaveBeenCalled();
  });

  it('Zod gate: rejects items with invalid changeType enum value', async () => {
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1' },
            changeType: 'restored', // not in [created, updated, deleted]
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    const body = ctx.body as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toBe(1);
    expect(enqueueRpc).not.toHaveBeenCalled();
  });

  it('Zod gate: rejects items with resourceData.id exceeding 512 chars', async () => {
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'a'.repeat(513) },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    const body = ctx.body as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toBe(1);
  });

  it('migration 0291 atomic rollback: compound RPC error → enqueue_failed skip, no permanent drop', async () => {
    // Migration 0291: when the compound RPC raises (transient enqueue
    // validation error, lock timeout, etc.) Postgres rolls back the nonce
    // INSERT in the same transaction. So Graph's retry will not collide
    // on the nonce PK and will attempt fresh. The handler must NOT 202-ack
    // the failed item — surface it as `enqueue_failed` skipped reason.
    enqueueRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'enqueue_rule_event raised: invalid_org_id', code: '23503' },
    });
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1' },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    const body = ctx.body as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toBe(1);
    // The atomic rollback property is what we're documenting in this test;
    // we cannot directly assert "the nonce row was rolled back" from the
    // unit-test layer (no real DB), but we CAN assert that nothing was
    // marked enqueued and the RPC was the only DB call made.
    expect(enqueueRpc).toHaveBeenCalledTimes(1);
    expect(nonceInsert).not.toHaveBeenCalled();
  });

  it('migration 0291 PK widening: same sub+resource+changeType with different payload_hash both enqueue', async () => {
    // Pre-0291 the PK was (subscription_id, resource_id, change_type) — every
    // legitimate later `updated` for the same Graph resource collided on the
    // nonce table and got dropped as `duplicate`. After 0291 the PK includes
    // payload_hash, so two updates with different bodies both succeed.
    integrationLookup.mockResolvedValue({
      data: { org_integrations: { id: INTEGRATION_ID, org_id: ORG_ID } },
      error: null,
    });
    enqueueRpc
      .mockResolvedValueOnce({ data: [{ rule_event_id: 'evt_msgraph_a', duplicate: false }], error: null })
      .mockResolvedValueOnce({ data: [{ rule_event_id: 'evt_msgraph_b', duplicate: false }], error: null });
    // First request: same sub + same resource + same changeType, payload A.
    // Note: tenantId omitted — MicrosoftGraphChange schema requires UUID
    // shape and we don't need it for this test.
    const reqA = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1', name: 'doc.docx' },
            changeType: 'updated',
          },
        ],
      },
    });
    const ctxA = buildRes();
    await callRouter(reqA, ctxA.res);
    expect(ctxA.statusCode).toBe(202);

    // Second request: same sub + same resource + same changeType, but later
    // edit so the rawBody (and therefore payload_hash) differs. Pre-0291 this
    // would collide and be `duplicate`; post-0291 it must enqueue.
    const reqB = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1', name: 'doc-revised.docx' }, // different name → different hash
            changeType: 'updated',
          },
        ],
      },
    });
    const ctxB = buildRes();
    await callRouter(reqB, ctxB.res);
    expect(ctxB.statusCode).toBe(202);

    expect(enqueueRpc).toHaveBeenCalledTimes(2);
    const hashA = (enqueueRpc.mock.calls[0]?.[1] as Record<string, unknown>).p_payload_hash;
    const hashB = (enqueueRpc.mock.calls[1]?.[1] as Record<string, unknown>).p_payload_hash;
    expect(hashA).not.toBe(hashB); // different rawBody → different sha256
    expect((ctxB.body as { enqueued: number }).enqueued).toBe(1);
  });

  it('treats compound-RPC duplicate=true row as a replay (no rule_event_id, still 202)', async () => {
    // Migration 0291: the wider PK (subscription_id, resource_id, change_type,
    // payload_hash) collides only on a TRUE replay (same payload bytes).
    // Compound RPC short-circuits and returns duplicate=true with no rule_event_id.
    enqueueRpc.mockResolvedValueOnce({
      data: [{ rule_event_id: null, duplicate: true }],
      error: null,
    });
    const ctx = buildRes();
    const req = buildReq({
      body: {
        value: [
          {
            subscriptionId: SUB_ID,
            clientState: CLIENT_STATE,
            resource: 'sites/x/drive/items/r1',
            resourceData: { id: 'r1' },
            changeType: 'updated',
          },
        ],
      },
    });
    await callRouter(req, ctx.res);
    expect(ctx.statusCode).toBe(202);
    const body = ctx.body as { enqueued: number; skipped: number };
    expect(body.enqueued).toBe(0);
    expect(body.skipped).toBe(1);
    // Compound RPC was called once and returned duplicate=true, which the
    // handler maps to skipped reason 'duplicate'. The legacy `nonceInsert`
    // direct-table call is no longer made.
    expect(enqueueRpc).toHaveBeenCalledTimes(1);
    expect(nonceInsert).not.toHaveBeenCalled();
  });
});
