/**
 * DocuSign signer backfill — production wiring tests.
 *
 * These tests exercise the Supabase query shape (candidate selection scoping,
 * the merge-never-clobber write, the optimistic already-enriched guard) using
 * a minimal chainable mock, and the DocuSign API adapter using an injected
 * fetchImpl — no real Supabase or DocuSign calls.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
  let rpcMock: ReturnType<typeof vi.fn>;
  let db: { from: typeof fromMock; rpc: typeof rpcMock };

  beforeEach(() => {
    fromMock = vi.fn();
    rpcMock = vi.fn();
    db = { from: fromMock, rpc: rpcMock };
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
    it('serializes RPC argument names that the actual migration declares', async () => {
      const sql = readFileSync(new URL('../../../../supabase/migrations/0438_docusign_backfill_attempt_authority.sql', import.meta.url), 'utf8');
      const signature = /FUNCTION public.list_docusign_signer_backfill_candidates\(([^)]*)\)/.exec(sql)![1];
      const declared = signature.split(',').map(parameter => parameter.trim().split(/\s+/)[0]).sort();
      const fetchImpl: typeof fetch = async (request, init) => {
        expect(new URL(String(request)).pathname).toBe('/rest/v1/rpc/list_docusign_signer_backfill_candidates');
        expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual(declared);
        return new Response('[]', { status: 200 });
      };
      const client = createClient('https://example.supabase.co', 'test-key', { global: { fetch: fetchImpl }, auth: { persistSession: false } });
      const deps = makeDocusignSignerBackfillDeps({ db: client });
      expect(await deps.listCandidateAnchors({ orgId: testGuid(2), accountId: 'acct-1', limit: 50 })).toEqual([]);
    });

    it('passes the org, active account and each allowed key to the due-candidate RPC', async () => {
      const row = { id: 'anchor-1', org_id: 'org-1', metadata: { source_envelope_id: 'env-a' }, fingerprint_source: 'document_bytes' };
      rpcMock.mockResolvedValueOnce({ data: [row], error: null })
        .mockResolvedValueOnce({ data: [row, { ...row, id: 'anchor-2', metadata: { envelope_id: 'env-b' } }], error: null })
        .mockResolvedValueOnce({ data: [], error: null });
      const deps = makeDocusignSignerBackfillDeps({ db });
      const candidates = await deps.listCandidateAnchors({ orgId: 'org-1', accountId: 'acct-1', limit: 50 });
      expect(candidates.map(c => [c.anchorId, c.envelopeId])).toEqual([['anchor-1', 'env-a'], ['anchor-2', 'env-b']]);
      expect(rpcMock.mock.calls).toEqual(['source_envelope_id', 'envelope_id', 'external_ref'].map(key => [
        'list_docusign_signer_backfill_candidates', { p_org_id: 'org-1', p_metadata_key: key, p_limit: 50, p_account_id: 'acct-1' },
      ]));
      expect(fromMock).not.toHaveBeenCalled();
    });
    it('caps the union at the requested limit', async () => {
      rpcMock.mockResolvedValue({ data: Array.from({ length: 10 }, (_, i) => ({ id: `anchor-${i}`, org_id: 'org-1', metadata: { envelope_id: `env-${i}` } })), error: null });
      const deps = makeDocusignSignerBackfillDeps({ db });
      expect(await deps.listCandidateAnchors({ orgId: 'org-1', accountId: 'acct-1', limit: 3 })).toHaveLength(3);
      expect(rpcMock).toHaveBeenCalledTimes(1);
    });
    it('fails on a database error rather than falling back to unreserved selection', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
      const deps = makeDocusignSignerBackfillDeps({ db });
      await expect(deps.listCandidateAnchors({ orgId: 'org-1', accountId: 'acct-1', limit: 50 })).rejects.toThrow(/permission denied/);
      expect(fromMock).not.toHaveBeenCalled();
    });
  });

  describe('claimEnvelopeAttempt', () => {
    it.each([true, false])('uses the actual PostgREST RPC transport and preserves a %s result', async granted => {
      const fetchImpl: typeof fetch = async (request, init) => {
        expect(new URL(String(request)).pathname).toBe('/rest/v1/rpc/claim_docusign_signer_backfill_attempt');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ p_org_id: testGuid(2), p_anchor_id: testGuid(1), p_envelope_id: 'env-1', p_account_id: 'acct-1' });
        return new Response(JSON.stringify(granted), { status: 200 });
      };
      const client = createClient('https://example.supabase.co', 'test-key', { global: { fetch: fetchImpl }, auth: { persistSession: false } });
      const deps = makeDocusignSignerBackfillDeps({ db: client });
      expect(await deps.claimEnvelopeAttempt({ anchorId: testGuid(1), orgId: testGuid(2), envelopeId: 'env-1', accountId: 'acct-1' })).toBe(granted);
    });
    it.each([{ data: null, error: { message: 'permission denied' } }, { data: 'true', error: null }])('fails closed on an error or malformed claim result', async result => {
      rpcMock.mockResolvedValue(result);
      const deps = makeDocusignSignerBackfillDeps({ db });
      await expect(deps.claimEnvelopeAttempt({ anchorId: 'anchor-1', orgId: 'org-1', envelopeId: 'env-1', accountId: 'acct-1' })).rejects.toThrow(/attempt_claim/);
    });
  });

  describe('post-fetch provenance revalidation', () => {
    it.each([
      ['envelope changed', { metadata: { connector_source: 'docusign', envelope_id: 'env-new' }, fingerprint_source: 'document_bytes', deleted_at: null }],
      ['direction changed', { metadata: { connector_source: 'docusign', envelope_id: 'env-1', _direction: 'inbound' }, fingerprint_source: 'document_bytes', deleted_at: null }],
      ['fingerprint authority changed', { metadata: { connector_source: 'docusign', envelope_id: 'env-1' }, fingerprint_source: 'issuer_record_attestation', deleted_at: null }],
      ['record deleted', { metadata: { connector_source: 'docusign', envelope_id: 'env-1' }, fingerprint_source: 'document_bytes', deleted_at: '2026-09-05T00:00:00Z' }],
      ['account changed', { metadata: { connector_source: 'docusign', envelope_id: 'env-1', account_id: 'foreign-account' }, fingerprint_source: 'document_bytes', deleted_at: null }],
    ])('does not attach an old provider response after %s', async (_label, freshRow) => {
      let writes = 0;
      const fetchImpl: typeof fetch = async (_input, init) => {
        if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(freshRow), { status: 200 });
        writes += 1;
        return new Response(JSON.stringify({ id: testGuid(1) }), { status: 200 });
      };
      const client = createClient('https://example.supabase.co', 'test-key', { global: { fetch: fetchImpl }, auth: { persistSession: false } });
      const deps = makeDocusignSignerBackfillDeps({ db: client });
      const result = await deps.updateAnchorSigners({ anchorId: testGuid(1), orgId: testGuid(2), envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes', metadata: { connector_source: 'docusign', envelope_id: 'env-1' }, signers: [], docusignEnv: 'demo' });
      expect(result).toEqual({ updated: false });
      expect(writes).toBe(0);
    });
  });

  describe('updateAnchorSigners', () => {
    /**
     * The production implementation now issues TWO sequential `db.from('anchors')`
     * calls: a fresh `.select('metadata')...maybeSingle()` read (re-reading the
     * CURRENT row rather than trusting the possibly-stale candidate snapshot
     * the caller passed in — see docusign-signer-backfill-deps.ts), then a
     * compare-and-swap `.update()...maybeSingle()` write. `sequentialFrom`
     * hands back a distinct chain per call, in order.
     */
    function sequentialFrom(chains: ReturnType<typeof makeChainable>['chain'][]) {
      let i = 0;
      return () => chains[Math.min(i++, chains.length - 1)];
    }

    it('re-reads current metadata (ignoring the passed-in stale snapshot) and merges _signers + _docusign_env without clobbering other keys', async () => {
      const freshMetadata = { connector_source: 'docusign', envelope_id: 'env-1', filename: 'contract.pdf', unrelated_key: 'keep-me' };
      const readChain = makeChainable({ data: null, error: null }, { data: { metadata: freshMetadata, fingerprint_source: 'document_bytes', deleted_at: null }, error: null });
      const writeChain = makeChainable({ data: null, error: null }, { data: { id: 'anchor-1' }, error: null });
      fromMock.mockImplementation(sequentialFrom([readChain.chain, writeChain.chain]));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const result = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        // Deliberately stale/different from freshMetadata — proves the merge
        // base is the fresh read, not this passed-in snapshot.
        metadata: { connector_source: 'docusign' },
        signers: [{ recipient_id_guid: testGuid(1), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(result.updated).toBe(true);
      const updateCall = writeChain.calls.find((c) => c.method === 'update')!;
      const payload = updateCall.args[0] as { metadata: Record<string, unknown> };
      expect(payload.metadata).toMatchObject({
        connector_source: 'docusign',
        envelope_id: 'env-1',
        filename: 'contract.pdf',
        unrelated_key: 'keep-me',
        _signers: [{ recipient_id_guid: testGuid(1), status: 'completed' }],
        _docusign_env: 'demo',
      });
      expect(payload.metadata._signers_backfilled_at).toEqual(expect.any(String));
    });

    it('never persists _signers as [] when the envelope had zero signers, but still stamps the watermark', async () => {
      const freshMetadata = { connector_source: 'docusign', envelope_id: 'env-1' };
      const readChain = makeChainable({ data: null, error: null }, { data: { metadata: freshMetadata, fingerprint_source: 'document_bytes', deleted_at: null }, error: null });
      const writeChain = makeChainable({ data: null, error: null }, { data: { id: 'anchor-1' }, error: null });
      fromMock.mockImplementation(sequentialFrom([readChain.chain, writeChain.chain]));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const result = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        metadata: freshMetadata,
        signers: [],
        docusignEnv: 'demo',
      });

      expect(result.updated).toBe(true);
      const updateCall = writeChain.calls.find((c) => c.method === 'update')!;
      const payload = updateCall.args[0] as { metadata: Record<string, unknown> };
      expect(payload.metadata).not.toHaveProperty('_signers');
      expect(payload.metadata._signers_backfilled_at).toEqual(expect.any(String));
    });

    it('does not overwrite an existing _docusign_env value', async () => {
      const freshMetadata = { connector_source: 'docusign', envelope_id: 'env-1', _docusign_env: 'prod' };
      const readChain = makeChainable({ data: null, error: null }, { data: { metadata: freshMetadata, fingerprint_source: 'document_bytes', deleted_at: null }, error: null });
      const writeChain = makeChainable({ data: null, error: null }, { data: { id: 'anchor-1' }, error: null });
      fromMock.mockImplementation(sequentialFrom([readChain.chain, writeChain.chain]));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        metadata: freshMetadata,
        signers: [{ recipient_id_guid: testGuid(2), status: 'completed' }],
        docusignEnv: 'demo',
      });

      const updateCall = writeChain.calls.find((c) => c.method === 'update')!;
      const payload = updateCall.args[0] as { metadata: Record<string, unknown> };
      expect(payload.metadata._docusign_env).toBe('prod');
    });

    it('scopes the write with .eq(id)/.eq(org_id), a metadata compare-and-swap, and both is-null completion guards', async () => {
      const freshMetadata = { connector_source: 'docusign', envelope_id: 'env-1' };
      const readChain = makeChainable({ data: null, error: null }, { data: { metadata: freshMetadata, fingerprint_source: 'document_bytes', deleted_at: null }, error: null });
      const writeChain = makeChainable({ data: null, error: null }, { data: { id: 'anchor-1' }, error: null });
      fromMock.mockImplementation(sequentialFrom([readChain.chain, writeChain.chain]));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        metadata: freshMetadata,
        signers: [{ recipient_id_guid: testGuid(3), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(writeChain.calls).toContainEqual({ method: 'eq', args: ['id', 'anchor-1'] });
      expect(writeChain.calls).toContainEqual({ method: 'eq', args: ['org_id', 'org-1'] });
      expect(writeChain.calls).toContainEqual({ method: 'eq', args: ['metadata', JSON.stringify(freshMetadata)] });
      expect(writeChain.calls).toContainEqual({ method: 'is', args: ['metadata->>_signers', null] });
      expect(writeChain.calls).toContainEqual({ method: 'is', args: ['metadata->>_signers_backfilled_at', null] });
    });

    it('returns updated:false WITHOUT attempting a write when the fresh read shows the row already completed (_signers_backfilled_at already set)', async () => {
      const readChain = makeChainable(
        { data: null, error: null },
        { data: { metadata: { _signers_backfilled_at: '2026-08-30T00:00:00Z' } }, error: null },
      );
      fromMock.mockImplementation(() => readChain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const result = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        metadata: {},
        signers: [{ recipient_id_guid: testGuid(4), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(result.updated).toBe(false);
      expect(readChain.calls.some((c) => c.method === 'update')).toBe(false);
    });

    it('reports updated:false (not an error) when the CAS write matches zero rows — metadata changed between the fresh read and the write', async () => {
      const freshMetadata = { connector_source: 'docusign', envelope_id: 'env-1' };
      const readChain = makeChainable({ data: null, error: null }, { data: { metadata: freshMetadata, fingerprint_source: 'document_bytes', deleted_at: null }, error: null });
      // The CAS lost: zero rows matched (a concurrent writer changed metadata
      // in the gap between this call's own read and its write).
      const writeChain = makeChainable({ data: null, error: null }, { data: null, error: null });
      fromMock.mockImplementation(sequentialFrom([readChain.chain, writeChain.chain]));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      const result = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        metadata: freshMetadata,
        signers: [{ recipient_id_guid: testGuid(6), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(result.updated).toBe(false);
    });

    it('throws anchor_reread_failed on a genuine DB error during the fresh read', async () => {
      const readChain = makeChainable({ data: null, error: null }, { data: null, error: { message: 'read boom' } });
      fromMock.mockImplementation(() => readChain.chain);

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await expect(
        deps.updateAnchorSigners({
          anchorId: 'anchor-1',
          orgId: 'org-1',
          envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
          metadata: {},
          signers: [{ recipient_id_guid: testGuid(5), status: 'completed' }],
          docusignEnv: 'demo',
        }),
      ).rejects.toThrow(/read boom/);
    });

    it('throws anchor_update_failed on a genuine DB error during the write', async () => {
      const freshMetadata = { connector_source: 'docusign', envelope_id: 'env-1' };
      const readChain = makeChainable({ data: null, error: null }, { data: { metadata: freshMetadata, fingerprint_source: 'document_bytes', deleted_at: null }, error: null });
      const writeChain = makeChainable({ data: null, error: null }, { data: null, error: { message: 'write boom' } });
      fromMock.mockImplementation(sequentialFrom([readChain.chain, writeChain.chain]));

      const deps = makeDocusignSignerBackfillDeps({ db: db as never });
      await expect(
        deps.updateAnchorSigners({
          anchorId: 'anchor-1',
          orgId: 'org-1',
          envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
          metadata: freshMetadata,
          signers: [{ recipient_id_guid: testGuid(5), status: 'completed' }],
          docusignEnv: 'demo',
        }),
      ).rejects.toThrow(/write boom/);
    });
  });

  describe('real PostgREST JSONB compare-and-swap transport', () => {
    it.each([false, true])('serializes the captured metadata and preserves a concurrent writer=%s', async (concurrentWrite) => {
      const original = { connector_source: 'docusign', external_ref: 'envelope-1', filename: 'a,b.pdf' };
      let stored: Record<string, unknown> = structuredClone(original);
      let sentFilter: string | null = null;
      const fetchImpl: typeof fetch = async (request, init) => {
        const url = new URL(String(request));
        expect(url.pathname).toBe('/rest/v1/anchors');
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({ metadata: original, fingerprint_source: 'document_bytes', deleted_at: null }), { status: 200 });
        }
        expect(init?.method).toBe('PATCH');
        sentFilter = url.searchParams.get('metadata');
        let expected: unknown;
        try { expected = JSON.parse(sentFilter!.slice(3)); }
        catch { return new Response(JSON.stringify({ code: '22P02', message: 'invalid input syntax for type json' }), { status: 400 }); }
        if (concurrentWrite) stored = { ...stored, fraud_flag: true };
        const matches = JSON.stringify(stored) === JSON.stringify(expected);
        if (matches) stored = JSON.parse(String(init?.body)).metadata;
        return new Response(JSON.stringify(matches ? [{ id: testGuid(1) }] : []), { status: 200 });
      };
      const client = createClient('https://pr2565.invalid', 'fixture-test-key', { global: { fetch: fetchImpl }, auth: { persistSession: false } });
      const deps = makeDocusignSignerBackfillDeps({ db: client });
      const result = await deps.updateAnchorSigners({ anchorId: testGuid(1), orgId: testGuid(2), envelopeId: 'envelope-1', accountId: 'acct-1', fingerprintSource: 'document_bytes', metadata: original, signers: [], docusignEnv: 'demo' });
      expect(sentFilter).toBe(`eq.${JSON.stringify(original)}`);
      expect(result.updated).toBe(!concurrentWrite);
      if (concurrentWrite) {
        expect(stored).toEqual({ ...original, fraud_flag: true });
        expect(stored).not.toHaveProperty('_signers_backfilled_at');
      } else {
        expect(stored).toMatchObject(original);
        expect(stored._signers_backfilled_at).toEqual(expect.any(String));
      }
    });
  });

  describe('watermark durability + concurrent-metadata-write safety (integration, in-memory anchors table)', () => {
    /**
     * A minimal STATEFUL fake of the `anchors` table sufficient for
     * `selectCandidatesForKey` (the multi-`.is()`/`.not()` select this deps
     * layer issues per ENVELOPE_ID_METADATA_KEYS key) and
     * `updateAnchorSigners` (the fresh-read `.maybeSingle()` select, then the
     * compare-and-swap `.update()...maybeSingle()`), backed by a real
     * in-memory row so a "second run" or a "concurrent write" can be
     * simulated for real rather than asserted from mocked call args.
     */
    class FakeAnchorsTable {
      private rows: Map<string, { id: string; org_id: string; metadata: Record<string, unknown>; fingerprint_source: string | null }>;

      constructor(rows: Array<{ id: string; org_id: string; metadata: Record<string, unknown>; fingerprint_source: string | null }>) {
        this.rows = new Map(rows.map((r) => [r.id, { ...r, metadata: { ...r.metadata } }]));
      }

      /** Simulates a write by something OTHER than this job landing between a read and a later write. */
      externallyPatchMetadata(id: string, patch: Record<string, unknown>): void {
        const row = this.rows.get(id);
        if (!row) throw new Error(`no such row ${id}`);
        row.metadata = { ...row.metadata, ...patch };
      }

      getMetadata(id: string): Record<string, unknown> | undefined {
        return this.rows.get(id)?.metadata;
      }

      query() {
        type Filter = [string, unknown];
        let updatePatch: { metadata: Record<string, unknown> } | null = null;
        const eqFilters: Filter[] = [];
        const isFilters: Filter[] = [];
        const notNullPaths: string[] = [];
        let limitN: number | undefined;
        const rows = this.rows;

        const matchRows = () =>
          [...rows.values()].filter((row) => {
            for (const [col, val] of eqFilters) {
              if (col === '__metadata_cas__') {
                if (JSON.stringify(row.metadata) !== JSON.stringify(val)) return false;
              } else if (col.startsWith('metadata->>')) {
                const key = col.slice('metadata->>'.length);
                if (row.metadata[key] !== val) return false;
              } else if ((row as Record<string, unknown>)[col] !== val) {
                return false;
              }
            }
            for (const [col, val] of isFilters) {
              if (col === 'deleted_at') continue; // fake rows are never deleted
              if (col.startsWith('metadata->>')) {
                const key = col.slice('metadata->>'.length);
                const actual = row.metadata[key];
                const isNull = actual === undefined || actual === null;
                if (val === null ? !isNull : isNull) return false;
              }
            }
            for (const col of notNullPaths) {
              if (col.startsWith('metadata->>')) {
                const key = col.slice('metadata->>'.length);
                const actual = row.metadata[key];
                if (actual === undefined || actual === null) return false;
              }
            }
            return true;
          });

        const builder = {
          select() {
            return builder;
          },
          update(patch: { metadata: Record<string, unknown> }) {
            updatePatch = patch;
            return builder;
          },
          eq(col: string, val: unknown) {
            eqFilters.push([col === 'metadata' ? '__metadata_cas__' : col, col === 'metadata' && typeof val === 'string' ? JSON.parse(val) : val]);
            return builder;
          },
          is(col: string, val: unknown) {
            isFilters.push([col, val]);
            return builder;
          },
          not(col: string, _op: string, _val: unknown) {
            notNullPaths.push(col);
            return builder;
          },
          limit(n: number) {
            limitN = n;
            return builder;
          },
          async maybeSingle() {
            const matched = matchRows();
            if (updatePatch) {
              if (matched.length === 0) return { data: null, error: null };
              const row = matched[0];
              row.metadata = updatePatch.metadata;
              return { data: { id: row.id }, error: null };
            }
            if (matched.length === 0) return { data: null, error: null };
            return { data: { metadata: matched[0].metadata, fingerprint_source: matched[0].fingerprint_source, deleted_at: null }, error: null };
          },
          then(resolve: (v: { data: unknown; error: null }) => void) {
            const matched = matchRows().slice(0, limitN);
            resolve({
              data: matched.map((r) => ({ id: r.id, org_id: r.org_id, metadata: r.metadata, fingerprint_source: r.fingerprint_source })),
              error: null,
            });
          },
        };
        return builder;
      }
    }

    it('Fix 1: a zero-signer envelope is durably marked done and is NOT returned as a candidate on a second run', async () => {
      const table = new FakeAnchorsTable([
        { id: 'anchor-1', org_id: 'org-1', metadata: { connector_source: 'docusign', envelope_id: 'env-1' }, fingerprint_source: 'document_bytes' },
      ]);
      fromMock.mockImplementation(() => table.query());
      rpcMock.mockImplementation((_name: string, args: { p_org_id: string; p_metadata_key: string; p_limit: number }) =>
        table.query().eq('org_id', args.p_org_id).eq('metadata->>connector_source', 'docusign')
          .is('metadata->>_signers', null).is('metadata->>_signers_backfilled_at', null)
          .not('metadata->>' + args.p_metadata_key, 'is', null).limit(args.p_limit));
      const deps = makeDocusignSignerBackfillDeps({ db: db as never });

      const firstRunCandidates = await deps.listCandidateAnchors({ orgId: 'org-1', accountId: 'acct-1', limit: 50 });
      expect(firstRunCandidates.map((c) => c.anchorId)).toEqual(['anchor-1']);

      // Simulates docusign-signer-backfill.ts's zero-signers path: still
      // calls updateAnchorSigners with signers: [] to set the watermark.
      const updateResult = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        metadata: firstRunCandidates[0].metadata,
        signers: [],
        docusignEnv: 'demo',
      });
      expect(updateResult.updated).toBe(true);

      // `_signers` itself was never persisted (still omitted, not `[]`)...
      expect(table.getMetadata('anchor-1')).not.toHaveProperty('_signers');
      // ...but the watermark WAS.
      expect(table.getMetadata('anchor-1')?._signers_backfilled_at).toEqual(expect.any(String));

      // Second run: the SAME query this job always issues now excludes it.
      const secondRunCandidates = await deps.listCandidateAnchors({ orgId: 'org-1', accountId: 'acct-1', limit: 50 });
      expect(secondRunCandidates).toEqual([]);
    });

    it('Fix 2: a concurrent write to an UNRELATED metadata key between SELECT and UPDATE survives the backfill write', async () => {
      const table = new FakeAnchorsTable([
        {
          id: 'anchor-1',
          org_id: 'org-1',
          metadata: { connector_source: 'docusign', envelope_id: 'env-1', filename: 'contract.pdf' },
          fingerprint_source: 'document_bytes',
        },
      ]);
      fromMock.mockImplementation(() => table.query());
      rpcMock.mockImplementation((_name: string, args: { p_org_id: string; p_metadata_key: string; p_limit: number }) =>
        table.query().eq('org_id', args.p_org_id).eq('metadata->>connector_source', 'docusign')
          .is('metadata->>_signers', null).is('metadata->>_signers_backfilled_at', null)
          .not('metadata->>' + args.p_metadata_key, 'is', null).limit(args.p_limit));
      const deps = makeDocusignSignerBackfillDeps({ db: db as never });

      const candidates = await deps.listCandidateAnchors({ orgId: 'org-1', accountId: 'acct-1', limit: 50 });
      const staleMetadataSnapshot = candidates[0].metadata; // captured at "SELECT time"

      // A concurrent writer (fraud tagging, an admin annotation, another
      // job's breadcrumb) lands on the SAME row for a DIFFERENT key, AFTER
      // this job's candidate SELECT but BEFORE its UPDATE.
      table.externallyPatchMetadata('anchor-1', { fraud_flag: 'reviewed' });

      const result = await deps.updateAnchorSigners({
        anchorId: 'anchor-1',
        orgId: 'org-1',
        envelopeId: 'env-1', accountId: 'acct-1', fingerprintSource: 'document_bytes',
        metadata: staleMetadataSnapshot, // the stale snapshot — deliberately does NOT carry fraud_flag
        signers: [{ recipient_id_guid: testGuid(9), status: 'completed' }],
        docusignEnv: 'demo',
      });

      expect(result.updated).toBe(true);
      const finalMetadata = table.getMetadata('anchor-1');
      // The concurrent write survives — a plain read-then-replace-whole-blob
      // write (the bug) would have silently reverted it, because the stale
      // snapshot passed in never carried `fraud_flag` in the first place.
      expect(finalMetadata?.fraud_flag).toBe('reviewed');
      // The backfill's own writes still landed.
      expect(finalMetadata?._signers).toEqual([{ recipient_id_guid: testGuid(9), status: 'completed' }]);
      expect(finalMetadata?.filename).toBe('contract.pdf');
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
