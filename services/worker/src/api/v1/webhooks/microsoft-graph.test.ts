/**
 * Tests for Microsoft Graph change-notifications webhook (SCRUM-1138 R2 closeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const integrationLookup = vi.fn();
const nonceInsert = vi.fn();
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
  const subscriptionsChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          is: () => ({ maybeSingle: () => integrationLookup() }),
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
  enqueueRpc.mockResolvedValue({ data: 'evt_msgraph_1', error: null });
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
    const enqueueArgs = enqueueRpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(enqueueArgs.p_org_id).toBe(ORG_ID);
    expect(enqueueArgs.p_trigger_type).toBe('WORKSPACE_FILE_MODIFIED');
    expect(enqueueArgs.p_vendor).toBe('sharepoint');
    expect(enqueueArgs.p_external_file_id).toBe(RESOURCE_ID);
    const payload = enqueueArgs.p_payload as Record<string, unknown>;
    expect(payload.source).toBe('microsoft_graph');
    expect(payload.integration_id).toBe(INTEGRATION_ID);
    expect(payload.change_type).toBe('updated');
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

  it('treats Postgres unique-violation on nonce as duplicate (no enqueue, still 202)', async () => {
    nonceInsert.mockResolvedValueOnce({ error: { code: '23505' } });
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
    expect(enqueueRpc).not.toHaveBeenCalled();
  });
});
