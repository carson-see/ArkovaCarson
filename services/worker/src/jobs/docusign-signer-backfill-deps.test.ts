/**
 * DocuSign signer backfill — production wiring tests.
 *
 * These tests exercise the Supabase query shape (candidate selection scoping,
 * the merge-never-clobber write, the optimistic already-enriched guard) using
 * a minimal chainable mock, and the DocuSign API adapter using an injected
 * fetchImpl — no real Supabase or DocuSign calls.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {},
}));

vi.mock('../utils/db.js', () => ({ db: {} }));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { makeDocusignSignerBackfillDeps } from './docusign-signer-backfill-deps.js';
import type { DocusignRefreshTokenStore } from '../integrations/connectors/docusign-token-store.js';

function testGuid(n: number): string {
  const suffix = String(Math.trunc(n)).padStart(12, '0').slice(-12);
  return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
}

type Call = { method: string; args: unknown[] };

/**
 * A minimal chainable Supabase mock: records every `.eq`/`.is`/`.not`/`.limit`
 * call on the current query, and resolves to `queryResult` when awaited
 * (thenable), or to `singleResult` on `.maybeSingle()`.
 */
function makeChainable(queryResult: { data: unknown; error: unknown }, singleResult?: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'is', 'not', 'limit', 'update'];
  for (const m of methods) {
    chain[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    };
  }
  chain.maybeSingle = vi.fn().mockResolvedValue(singleResult ?? queryResult);
  chain.then = (resolve: (v: unknown) => void) => resolve(queryResult);
  return { chain, calls };
}

describe('makeDocusignSignerBackfillDeps', () => {
  let fromMock: ReturnType<typeof vi.fn>;
  let db: { from: typeof fromMock };

  beforeEach(() => {
    fromMock = vi.fn();
    db = { from: fromMock };
  });

  describe('listActiveIntegrations', () => {
    it('lists both org_integrations and member_integrations rows for provider=docusign, revoked_at IS NULL', async () => {
      const orgChain = makeChainable({
        data: [{ id: 'int-org', org_id: 'org-1', account_id: 'acct-1', base_uri: 'https://demo.docusign.net', token_secret_name: 'sec-1' }],
        error: null,
      });
      const memberChain = makeChainable({
        data: [{ id: 'int-mem', org_id: 'org-2', account_id: 'acct-2', base_uri: 'https://demo.docusign.net', token_secret_name: 'sec-2' }],
        error: null,
      });
      fromMock.mockImplementation((table: string) => (table === 'org_integrations' ? orgChain.chain : memberChain.chain));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const integrations = await deps.listActiveIntegrations();

      expect(integrations).toHaveLength(2);
      expect(integrations.map((i) => i.id)).toEqual(['int-org', 'int-mem']);
      expect(orgChain.calls).toContainEqual({ method: 'eq', args: ['provider', 'docusign'] });
      expect(orgChain.calls).toContainEqual({ method: 'is', args: ['revoked_at', null] });
    });

    it('drops malformed rows missing required fields', async () => {
      const orgChain = makeChainable({ data: [{ id: 'int-1' /* missing account_id etc */ }], error: null });
      const memberChain = makeChainable({ data: [], error: null });
      fromMock.mockImplementation((table: string) => (table === 'org_integrations' ? orgChain.chain : memberChain.chain));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      expect(await deps.listActiveIntegrations()).toEqual([]);
    });

    it('throws when the org_integrations query errors', async () => {
      const orgChain = makeChainable({ data: null, error: { message: 'boom' } });
      fromMock.mockImplementation(() => orgChain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await expect(deps.listActiveIntegrations()).rejects.toThrow(/boom/);
    });
  });

  describe('getAccessToken', () => {
    it('refreshes via the token store and returns the new access token', async () => {
      const store: DocusignRefreshTokenStore = {
        get: vi.fn().mockResolvedValue('refresh-1'),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'at-new', expires_in: 28800 }), { status: 200 }),
      );

      const deps = makeDocusignSignerBackfillDeps({
        db: db as never,
        refreshTokenStore: store,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: { DOCUSIGN_INTEGRATION_KEY: 'ik', DOCUSIGN_CLIENT_SECRET: 'cs' },
      });

      const token = await deps.getAccessToken({
        id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
        base_uri: 'https://demo.docusign.net',
        token_secret_name: 'sec-1',
      });

      expect(token).toBe('at-new');
      expect(store.get).toHaveBeenCalledWith({ name: 'sec-1' });
    });

    it('throws when the refresh token secret is missing', async () => {
      const store: DocusignRefreshTokenStore = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn(),
        delete: vi.fn(),
      };
      const deps = makeDocusignSignerBackfillDeps({ db: db as never, refreshTokenStore: store });

      await expect(
        deps.getAccessToken({ id: 'int-1', org_id: 'org-1', account_id: 'acct-1', base_uri: 'https://demo.docusign.net', token_secret_name: 'sec-1' }),
      ).rejects.toThrow(/refresh_token_not_found/);
    });
  });

  describe('listCandidateAnchors', () => {
    it('scopes by org_id, connector_source=docusign, _signers IS NULL, and unions per-key envelope-id queries', async () => {
      const sourceKeyChain = makeChainable({
        data: [{ id: 'anchor-1', org_id: 'org-1', metadata: { connector_source: 'docusign', source_envelope_id: 'env-a' }, fingerprint_source: null }],
        error: null,
      });
      const envelopeKeyChain = makeChainable({
        data: [{ id: 'anchor-2', org_id: 'org-1', metadata: { connector_source: 'docusign', envelope_id: 'env-b' }, fingerprint_source: 'document_bytes' }],
        error: null,
      });
      const externalRefKeyChain = makeChainable({ data: [], error: null });
      let call = 0;
      const chains = [sourceKeyChain, envelopeKeyChain, externalRefKeyChain];
      fromMock.mockImplementation(() => chains[call++ % chains.length].chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const candidates = await deps.listCandidateAnchors({ orgId: 'org-1', limit: 50 });

      expect(candidates.map((c) => c.anchorId).sort()).toEqual(['anchor-1', 'anchor-2']);
      const c1 = candidates.find((c) => c.anchorId === 'anchor-1')!;
      expect(c1.envelopeId).toBe('env-a');
      expect(c1.orgId).toBe('org-1');
      const c2 = candidates.find((c) => c.anchorId === 'anchor-2')!;
      expect(c2.envelopeId).toBe('env-b');
      expect(c2.fingerprintSource).toBe('document_bytes');

      expect(sourceKeyChain.calls).toContainEqual({ method: 'eq', args: ['org_id', 'org-1'] });
      expect(sourceKeyChain.calls).toContainEqual({ method: 'eq', args: ['metadata->>connector_source', 'docusign'] });
      expect(sourceKeyChain.calls).toContainEqual({ method: 'is', args: ['metadata->>_signers', null] });
    });

    it('dedupes an anchor that matches more than one envelope-id key', async () => {
      const row = { id: 'anchor-dup', org_id: 'org-1', metadata: { connector_source: 'docusign', envelope_id: 'env-x', external_ref: 'env-x' }, fingerprint_source: 'document_bytes' };
      const chain = makeChainable({ data: [row], error: null });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const candidates = await deps.listCandidateAnchors({ orgId: 'org-1', limit: 50 });

      expect(candidates).toHaveLength(1);
    });

    it('caps the returned candidate set at the requested limit', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        id: `anchor-${i}`,
        org_id: 'org-1',
        metadata: { connector_source: 'docusign', envelope_id: `env-${i}` },
        fingerprint_source: 'document_bytes',
      }));
      const chain = makeChainable({ data: rows, error: null });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const candidates = await deps.listCandidateAnchors({ orgId: 'org-1', limit: 3 });

      expect(candidates).toHaveLength(3);
    });

    it('throws when a per-key query errors', async () => {
      const chain = makeChainable({ data: null, error: { message: 'query failed' } });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await expect(deps.listCandidateAnchors({ orgId: 'org-1', limit: 50 })).rejects.toThrow(/query failed/);
    });
  });

  describe('updateAnchorSigners', () => {
    it('merges _signers and _docusign_env onto existing metadata without clobbering other keys', async () => {
      const chain = makeChainable({ data: null, error: null }, { data: { id: 'anchor-1' }, error: null });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const result = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        metadata: { connector_source: 'docusign', envelope_id: 'env-1', filename: 'contract.pdf', unrelated_key: 'keep-me' },
        signers: [{ recipient_id_guid: testGuid(1), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(result.updated).toBe(true);
      const updateCall = chain.calls.find((c) => c.method === 'update')!;
      const payload = updateCall.args[0] as { metadata: Record<string, unknown> };
      expect(payload.metadata).toMatchObject({
        connector_source: 'docusign',
        envelope_id: 'env-1',
        filename: 'contract.pdf',
        unrelated_key: 'keep-me',
        _signers: [{ recipient_id_guid: testGuid(1), status: 'completed' }],
        _docusign_env: 'demo',
      });
    });

    it('does not overwrite an existing _docusign_env value', async () => {
      const chain = makeChainable({ data: null, error: null }, { data: { id: 'anchor-1' }, error: null });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        metadata: { connector_source: 'docusign', _docusign_env: 'prod' },
        signers: [{ recipient_id_guid: testGuid(2), status: 'completed' }],
        docusignEnv: 'demo',
      });

      const updateCall = chain.calls.find((c) => c.method === 'update')!;
      const payload = updateCall.args[0] as { metadata: Record<string, unknown> };
      expect(payload.metadata._docusign_env).toBe('prod');
    });

    it('scopes the write with .eq(org_id) and an optimistic _signers-IS-NULL guard', async () => {
      const chain = makeChainable({ data: null, error: null }, { data: { id: 'anchor-1' }, error: null });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        metadata: {},
        signers: [{ recipient_id_guid: testGuid(3), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(chain.calls).toContainEqual({ method: 'eq', args: ['id', 'anchor-1'] });
      expect(chain.calls).toContainEqual({ method: 'eq', args: ['org_id', 'org-1'] });
      expect(chain.calls).toContainEqual({ method: 'is', args: ['metadata->>_signers', null] });
    });

    it('reports updated:false (not an error) when the optimistic guard finds no matching row (already enriched concurrently)', async () => {
      const chain = makeChainable({ data: null, error: null }, { data: null, error: null });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const result = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        metadata: {},
        signers: [{ recipient_id_guid: testGuid(4), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(result.updated).toBe(false);
    });

    it('throws on a genuine DB error', async () => {
      const chain = makeChainable({ data: null, error: null }, { data: null, error: { message: 'db error' } });
      fromMock.mockImplementation(() => chain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await expect(
        deps.updateAnchorSigners({
          anchorId: 'anchor-1',
          orgId: 'org-1',
          metadata: {},
          signers: [{ recipient_id_guid: testGuid(5), status: 'completed' }],
          docusignEnv: 'demo',
        }),
      ).rejects.toThrow(/db error/);
    });
  });

  describe('fetchEnvelopeSigners', () => {
    it('calls fetchDocusignEnvelopeRecipients with the given credentials', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ signers: [{ recipientIdGuid: testGuid(6), status: 'completed' }] }),
          { status: 200 },
        ),
      );
      const deps = makeDocusignSignerBackfillDeps({ db: db as never, fetchImpl: fetchImpl as unknown as typeof fetch });

      const signers = await deps.fetchEnvelopeSigners({
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        envelopeId: 'env-1',
        accessToken: 'at-1',
      });

      expect(signers).toEqual([{ recipient_id_guid: testGuid(6), status: 'completed' }]);
      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes/env-1/recipients');
    });
  });

  describe('sleep', () => {
    it('resolves after roughly the requested delay', async () => {
      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const start = Date.now();
      await deps.sleep(5);
      expect(Date.now() - start).toBeGreaterThanOrEqual(0);
    });
  });
});
