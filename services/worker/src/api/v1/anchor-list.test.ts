import express from 'express';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
import { db } from '../../utils/db.js';
import { createAnchorListRouter, defaultAnchorListDeps, type AnchorListDeps } from './anchor-list.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function app(deps: AnchorListDeps, scopes = ['read:records']) {
  const server = express();
  server.use((req, _res, next) => {
    req.apiKey = { keyId: 'key-1', keyPrefix: 'ak_live_test', orgId: ORG, userId: USER, scopes, rateLimitTier: 'paid' };
    next();
  });
  server.use('/anchors', createAnchorListRouter(deps));
  return server;
}

describe('GET /anchors', () => {
  it('derives tenant and creator, normalizes a user tag, and returns bounded fields', async () => {
    const list = vi.fn().mockResolvedValue({ anchors: [{ public_id: 'ARK-1', status: 'SECURED', created_at: '2026-09-27T10:00:00.000Z', updated_at: '2026-09-27T11:00:00.000Z', filename: 'a.pdf', description: null }], next_cursor: 'next' });
    const deps: AnchorListDeps = { revalidateCaller: vi.fn().mockResolvedValue({ orgId: ORG, userId: USER }), list };
    const response = await request(app(deps)).get('/anchors?tag=%20AcMe%20&tag_scope=user&since=2026-09-26T00:00:00Z&limit=25');
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, userId: USER, tag: 'acme', tagScope: 'user', limit: 25, since: '2026-09-26T00:00:00.000Z' }));
    expect(response.body).toEqual({ anchors: [{ public_id: 'ARK-1', status: 'SECURED', created_at: '2026-09-27T10:00:00.000Z', updated_at: '2026-09-27T11:00:00.000Z', filename: 'a.pdf', description: null }], next_cursor: 'next' });
  });

  it.each([
    ['?tag=acme', 'tag_scope_required'], ['?tag_scope=user', 'tag_required'],
    ['?since=2026-09-27', 'invalid_date_interval'],
    ['?since=2026-09-28T00:00:00Z&until=2026-09-27T00:00:00Z', 'invalid_date_interval'],
    ['?limit=101', 'invalid_anchor_list_query'], ['?cursor=not-a-cursor', 'invalid_cursor'],
  ])('rejects invalid query %s without reading anchors', async (query, code) => {
    const deps: AnchorListDeps = { revalidateCaller: vi.fn().mockResolvedValue({ orgId: ORG, userId: USER }), list: vi.fn() };
    const response = await request(app(deps)).get(`/anchors${query}`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(code);
    expect(deps.list).not.toHaveBeenCalled();
  });

  it('fails closed when the key creator no longer belongs to the bound organization', async () => {
    const deps: AnchorListDeps = { revalidateCaller: vi.fn().mockResolvedValue(null), list: vi.fn() };
    const response = await request(app(deps)).get('/anchors');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'organization_access_denied' });
    expect(deps.list).not.toHaveBeenCalled();
  });

  it('sanitizes caller revalidation transport failures', async () => {
    const deps: AnchorListDeps = { revalidateCaller: vi.fn().mockRejectedValue(new Error('private database details')), list: vi.fn() };
    const response = await request(app(deps)).get('/anchors');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'anchor_list_unavailable' });
  });

  it('revalidates the current key scopes and exact organization membership', async () => {
    const terminal = (data: unknown) => {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq']) chain[method] = vi.fn(() => chain);
      chain.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
      return chain;
    };
    const unscopedKey = terminal({ id: 'key-1', org_id: ORG, created_by: USER, is_active: true, revoked_at: null, expires_at: null, scopes: ['verify'] });
    vi.mocked(db.from).mockReturnValueOnce(unscopedKey as never);
    expect(await defaultAnchorListDeps.revalidateCaller({ keyId: 'key-1', orgId: ORG, userId: USER })).toBeNull();
    expect(unscopedKey.eq).toHaveBeenCalledWith('org_id', ORG);
    expect(unscopedKey.eq).toHaveBeenCalledWith('created_by', USER);

    vi.mocked(db.from)
      .mockReturnValueOnce(terminal({ id: 'key-1', org_id: ORG, created_by: USER, is_active: true, revoked_at: null, expires_at: null, scopes: ['read:records'] }) as never)
      .mockReturnValueOnce(terminal({ org_id: '33333333-3333-4333-8333-333333333333' }) as never)
      .mockReturnValueOnce(terminal({ id: 'membership-1' }) as never);
    await expect(defaultAnchorListDeps.revalidateCaller({ keyId: 'key-1', orgId: ORG, userId: USER })).resolves.toEqual({ orgId: ORG, userId: USER });
  });

  it('builds an exact-tenant user-tag query and returns a cursor only for an extra row', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const rows = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', public_id: 'ARK-1', status: 'SECURED', created_at: '2026-09-27T10:00:00.000Z', updated_at: '2026-09-27T10:00:00.000Z', filename: 'a.pdf', description: null },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', public_id: 'ARK-2', status: 'PENDING', created_at: '2026-09-27T09:00:00.000Z', updated_at: '2026-09-27T09:00:00.000Z', filename: 'b.pdf', description: null },
    ];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'not', 'lte', 'gte', 'lt', 'or', 'order', 'limit']) {
      chain[method] = vi.fn((...args: unknown[]) => { calls.push([method, ...args]); return chain; });
    }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
    vi.mocked(db.from).mockReturnValueOnce(chain as never);
    const result = await defaultAnchorListDeps.list({ orgId: ORG, userId: USER, since: '2026-09-26T00:00:00.000Z', until: null, tag: 'acme', tagScope: 'user', limit: 1, cursor: null });
    expect(calls).toEqual(expect.arrayContaining([
      ['eq', 'org_id', ORG], ['is', 'deleted_at', null], ['is', 'metadata->>pipeline_source', null], ['not', 'public_id', 'is', null],
      ['eq', 'anchor_private_tags.scope', 'user'], ['eq', 'anchor_private_tags.normalized_tag', 'acme'],
      ['eq', 'anchor_private_tags.owner_user_id', USER], ['is', 'anchor_private_tags.org_id', null], ['limit', 2],
    ]));
    expect(calls.find(([method]) => method === 'select')?.[1]).toContain('anchor_private_tags!inner');
    expect(result.anchors).toHaveLength(1);
    expect(result.next_cursor).toEqual(expect.any(String));
    const decoded = JSON.parse(Buffer.from(result.next_cursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(decoded).toMatchObject({ publicId: 'ARK-1', filterHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(decoded).not.toHaveProperty('tag');
    expect(decoded).not.toHaveProperty('id');
    expect(result.anchors[0]).not.toHaveProperty('id');
  });

  it('binds organization tags to the authenticated organization', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'not', 'lte', 'gte', 'lt', 'or', 'order', 'limit']) {
      chain[method] = vi.fn((...args: unknown[]) => { calls.push([method, ...args]); return chain; });
    }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    vi.mocked(db.from).mockReturnValueOnce(chain as never);
    await defaultAnchorListDeps.list({ orgId: ORG, userId: USER, since: null, until: null, tag: 'acme', tagScope: 'organization', limit: 50, cursor: null });
    expect(calls).toEqual(expect.arrayContaining([
      ['eq', 'org_id', ORG], ['eq', 'anchor_private_tags.scope', 'organization'],
      ['eq', 'anchor_private_tags.normalized_tag', 'acme'], ['eq', 'anchor_private_tags.org_id', ORG],
    ]));
    expect(calls).not.toContainEqual(['eq', 'anchor_private_tags.owner_user_id', USER]);
  });

  it('rejects absent and unscoped API keys before any database dependency', async () => {
    const deps: AnchorListDeps = { revalidateCaller: vi.fn(), list: vi.fn() };
    const bare = express().use('/anchors', createAnchorListRouter(deps));
    expect((await request(bare).get('/anchors')).status).toBe(401);
    expect((await request(app(deps, ['verify'])).get('/anchors')).status).toBe(403);
    expect(deps.revalidateCaller).not.toHaveBeenCalled();
  });

  it('rejects a cursor whose normalized filters differ or whose row is after its snapshot', async () => {
    const deps: AnchorListDeps = { revalidateCaller: vi.fn(), list: vi.fn() };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const hash = (tag: string) => createHash('sha256').update(JSON.stringify({ since: null, until: null, tag, tagScope: 'organization' })).digest('hex');
    const base = { v: 1, snapshot: '2026-09-27T12:00:00Z', createdAt: '2026-09-27T11:00:00Z', publicId: 'ARK-1', filterHash: hash('acme') };
    const mismatch = await request(app(deps)).get(`/anchors?tag=other&tag_scope=organization&cursor=${encodeURIComponent(encode(base))}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('cursor_filter_mismatch');
    const future = await request(app(deps)).get(`/anchors?tag=acme&tag_scope=organization&cursor=${encodeURIComponent(encode({ ...base, createdAt: '2026-09-28T00:00:00Z' }))}`);
    expect(future.status).toBe(400);
    expect(future.body.error).toBe('invalid_cursor');
    for (const publicId of ['ARK-1),org_id.eq.other', 'ARK-1\npublic_id.gt.0']) {
      const injected = await request(app(deps)).get(`/anchors?tag=acme&tag_scope=organization&cursor=${encodeURIComponent(encode({ ...base, publicId }))}`);
      expect(injected.status).toBe(400);
      expect(injected.body.error).toBe('invalid_cursor');
    }
    expect(deps.revalidateCaller).not.toHaveBeenCalled();
  });
});
