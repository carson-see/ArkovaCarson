/**
 * DocuSign signer backfill — pure orchestrator tests.
 *
 * The CRITICAL SAFETY test in this file (`describe('CRITICAL SAFETY ...')`)
 * asserts that `deps.fetchEnvelopeSigners` — the only function in this job
 * that calls the DocuSign API — is NEVER invoked for a candidate classified
 * as inbound, by either signal (`metadata._direction === 'inbound'` or
 * `fingerprintSource === 'issuer_record_attestation'`). See the file header
 * of `docusign-signer-backfill.ts` for the full scope-boundary rationale.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  config: {},
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  runDocusignSignerBackfill,
  isOutboundBackfillCandidate,
  type DocusignSignerBackfillDeps,
  type DocusignSignerBackfillCandidate,
  type DocusignSignerBackfillIntegration,
} from './docusign-signer-backfill.js';
import type { DocusignCapturedSignerT } from '../integrations/connectors/schemas.js';

function testGuid(n: number): string {
  const suffix = String(Math.trunc(n)).padStart(12, '0').slice(-12);
  return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
}

const INTEGRATION: DocusignSignerBackfillIntegration = {
  id: 'int-1',
  org_id: 'org-1',
  account_id: 'acct-1',
  base_uri: 'https://demo.docusign.net',
  token_secret_name: 'projects/x/secrets/y',
};

function outboundCandidate(
  overrides: Partial<DocusignSignerBackfillCandidate> = {},
): DocusignSignerBackfillCandidate {
  return {
    anchorId: 'anchor-1',
    orgId: 'org-1',
    envelopeId: 'env-1',
    metadata: { connector_source: 'docusign', envelope_id: 'env-1' },
    fingerprintSource: 'document_bytes',
    ...overrides,
  };
}

const SIGNERS: DocusignCapturedSignerT[] = [
  { recipient_id_guid: testGuid(1), status: 'completed', signed_at: '2026-08-20T10:00:00Z' },
];

function makeDeps(overrides: Partial<DocusignSignerBackfillDeps> = {}): DocusignSignerBackfillDeps {
  return {
    listActiveIntegrations: vi.fn().mockResolvedValue([INTEGRATION]),
    getAccessToken: vi.fn().mockResolvedValue('at-1'),
    listCandidateAnchors: vi.fn().mockResolvedValue([outboundCandidate()]),
    fetchEnvelopeSigners: vi.fn().mockResolvedValue(SIGNERS),
    updateAnchorSigners: vi.fn().mockResolvedValue({ updated: true }),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('isOutboundBackfillCandidate', () => {
  it('is true when _direction is absent and fingerprintSource is document_bytes', () => {
    expect(
      isOutboundBackfillCandidate({ metadata: { connector_source: 'docusign' }, fingerprintSource: 'document_bytes' }),
    ).toBe(true);
  });

  it('is true when _direction is absent and fingerprintSource is null (pre-migration rows)', () => {
    expect(isOutboundBackfillCandidate({ metadata: {}, fingerprintSource: null })).toBe(true);
  });

  it('is true when _direction is explicitly "outbound"', () => {
    expect(isOutboundBackfillCandidate({ metadata: { _direction: 'outbound' }, fingerprintSource: 'document_bytes' })).toBe(true);
  });

  it('is FALSE when _direction is "inbound"', () => {
    expect(isOutboundBackfillCandidate({ metadata: { _direction: 'inbound' }, fingerprintSource: 'document_bytes' })).toBe(false);
  });

  it('is FALSE when fingerprintSource is issuer_record_attestation, even if _direction is absent', () => {
    expect(isOutboundBackfillCandidate({ metadata: {}, fingerprintSource: 'issuer_record_attestation' })).toBe(false);
  });

  it('is FALSE when both signals independently say inbound', () => {
    expect(
      isOutboundBackfillCandidate({
        metadata: { _direction: 'inbound' },
        fingerprintSource: 'issuer_record_attestation',
      }),
    ).toBe(false);
  });

  it('is FALSE for any _direction value other than "outbound" (fail closed, not just "inbound")', () => {
    expect(isOutboundBackfillCandidate({ metadata: { _direction: 'sideways' }, fingerprintSource: null })).toBe(false);
  });

  it('handles null metadata', () => {
    expect(isOutboundBackfillCandidate({ metadata: null, fingerprintSource: null })).toBe(true);
  });
});

describe('runDocusignSignerBackfill', () => {
  it('enriches an eligible outbound anchor: fetches signers and writes them merged onto existing metadata', async () => {
    const deps = makeDeps();

    const result = await runDocusignSignerBackfill(deps);

    expect(deps.fetchEnvelopeSigners).toHaveBeenCalledWith({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      envelopeId: 'env-1',
      accessToken: 'at-1',
    });
    expect(deps.updateAnchorSigners).toHaveBeenCalledWith({
      anchorId: 'anchor-1',
      orgId: 'org-1',
      metadata: { connector_source: 'docusign', envelope_id: 'env-1' },
      signers: SIGNERS,
      docusignEnv: 'demo',
    });
    expect(result.ok).toBe(true);
    expect(result.anchorsUpdated).toBe(1);
    expect(result.anchorsScanned).toBe(1);
    expect(result.anchorsSkippedInbound).toBe(0);
  });

  describe('CRITICAL SAFETY: never call the DocuSign API for an inbound-classified anchor', () => {
    it('skips a candidate with metadata._direction="inbound" WITHOUT ever calling fetchEnvelopeSigners', async () => {
      const deps = makeDeps({
        listCandidateAnchors: vi.fn().mockResolvedValue([
          outboundCandidate({
            anchorId: 'anchor-inbound',
            metadata: { connector_source: 'docusign', _direction: 'inbound', envelope_id: 'env-foreign' },
          }),
        ]),
      });

      const result = await runDocusignSignerBackfill(deps);

      expect(deps.fetchEnvelopeSigners).not.toHaveBeenCalled();
      expect(deps.updateAnchorSigners).not.toHaveBeenCalled();
      expect(result.anchorsSkippedInbound).toBe(1);
      expect(result.anchorsUpdated).toBe(0);
      expect(result.ok).toBe(true);
    });

    it('skips a candidate whose fingerprintSource is issuer_record_attestation, even with _direction absent, WITHOUT calling fetchEnvelopeSigners', async () => {
      const deps = makeDeps({
        listCandidateAnchors: vi.fn().mockResolvedValue([
          outboundCandidate({ anchorId: 'anchor-declared', fingerprintSource: 'issuer_record_attestation' }),
        ]),
      });

      const result = await runDocusignSignerBackfill(deps);

      expect(deps.fetchEnvelopeSigners).not.toHaveBeenCalled();
      expect(deps.updateAnchorSigners).not.toHaveBeenCalled();
      expect(result.anchorsSkippedInbound).toBe(1);
    });

    it('processes a mixed batch: enriches the outbound anchor, skips the inbound one, API called exactly once', async () => {
      const deps = makeDeps({
        listCandidateAnchors: vi.fn().mockResolvedValue([
          outboundCandidate({ anchorId: 'anchor-out' }),
          outboundCandidate({
            anchorId: 'anchor-in',
            metadata: { connector_source: 'docusign', _direction: 'inbound' },
          }),
        ]),
      });

      const result = await runDocusignSignerBackfill(deps);

      expect(deps.fetchEnvelopeSigners).toHaveBeenCalledTimes(1);
      expect(deps.fetchEnvelopeSigners).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: 'env-1' }));
      expect(result.anchorsUpdated).toBe(1);
      expect(result.anchorsSkippedInbound).toBe(1);
    });
  });

  it('skips a candidate with no envelope id without calling the DocuSign API', async () => {
    const deps = makeDeps({
      listCandidateAnchors: vi.fn().mockResolvedValue([
        outboundCandidate({ envelopeId: '' as unknown as string }),
      ]),
    });

    const result = await runDocusignSignerBackfill(deps);

    expect(deps.fetchEnvelopeSigners).not.toHaveBeenCalled();
    expect(result.anchorsSkippedNoEnvelopeId).toBe(1);
  });

  it('skips 404/403/410 without failing the run (expected for purged/no-access/retention envelopes)', async () => {
    for (const status of [404, 403, 410]) {
      const deps = makeDeps({
        fetchEnvelopeSigners: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { status })),
      });

      const result = await runDocusignSignerBackfill(deps);

      expect(result.ok).toBe(true);
      expect(result.anchorsSkippedNotFound).toBe(1);
      expect(result.errors).toEqual([]);
    }
  });

  it('records a genuine (non-404/403/410) fetch failure as an error and marks the run not-ok, but keeps processing', async () => {
    const deps = makeDeps({
      listCandidateAnchors: vi.fn().mockResolvedValue([
        outboundCandidate({ anchorId: 'anchor-a', envelopeId: 'env-a' }),
        outboundCandidate({ anchorId: 'anchor-b', envelopeId: 'env-b' }),
      ]),
      fetchEnvelopeSigners: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }))
        .mockResolvedValueOnce(SIGNERS),
    });

    const result = await runDocusignSignerBackfill(deps);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ anchor_id: 'anchor-a' });
    // The second candidate still gets processed — one bad row never aborts the run.
    expect(result.anchorsUpdated).toBe(1);
  });

  it('does not write when the envelope has no signers (never persists an empty array)', async () => {
    const deps = makeDeps({ fetchEnvelopeSigners: vi.fn().mockResolvedValue([]) });

    const result = await runDocusignSignerBackfill(deps);

    expect(deps.updateAnchorSigners).not.toHaveBeenCalled();
    expect(result.anchorsUpdated).toBe(0);
  });

  it('treats an update guard trip (concurrently already-enriched) as a no-op, not an error', async () => {
    const deps = makeDeps({ updateAnchorSigners: vi.fn().mockResolvedValue({ updated: false }) });

    const result = await runDocusignSignerBackfill(deps);

    expect(result.ok).toBe(true);
    expect(result.anchorsUpdated).toBe(0);
    expect(result.anchorsAlreadyEnriched).toBe(1);
  });

  it('respects a bounded per-integration page size (candidate query is called with the requested limit)', async () => {
    const deps = makeDeps();

    await runDocusignSignerBackfill(deps, { pageSize: 7 });

    expect(deps.listCandidateAnchors).toHaveBeenCalledWith({ orgId: 'org-1', limit: 7 });
  });

  it('clamps an over-large pageSize to the hard max', async () => {
    const deps = makeDeps();

    await runDocusignSignerBackfill(deps, { pageSize: 100_000 });

    const call = (deps.listCandidateAnchors as ReturnType<typeof vi.fn>).mock.calls[0][0] as { limit: number };
    expect(call.limit).toBeLessThanOrEqual(200);
  });

  it('stops processing once the overall per-run cap is reached, across multiple integrations', async () => {
    const integrationB: DocusignSignerBackfillIntegration = { ...INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INTEGRATION, integrationB]),
      listCandidateAnchors: vi.fn()
        .mockResolvedValueOnce([outboundCandidate({ anchorId: 'a1' }), outboundCandidate({ anchorId: 'a2' })])
        .mockResolvedValueOnce([outboundCandidate({ anchorId: 'a3', orgId: 'org-2' })]),
    });

    const result = await runDocusignSignerBackfill(deps, { runLimit: 2 });

    expect(result.anchorsScanned).toBe(2);
    expect(deps.fetchEnvelopeSigners).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when there are no active DocuSign integrations', async () => {
    const deps = makeDeps({ listActiveIntegrations: vi.fn().mockResolvedValue([]) });

    const result = await runDocusignSignerBackfill(deps);

    expect(result.ok).toBe(true);
    expect(result.integrationsChecked).toBe(0);
    expect(deps.listCandidateAnchors).not.toHaveBeenCalled();
  });

  it('is naturally resumable/idempotent: a second run against the same (now-enriched) candidate set finds nothing, because listCandidateAnchors already filters on _signers IS NULL', async () => {
    // This job trusts the deps-layer candidate query to exclude already-enriched
    // anchors (the watermark); the orchestrator itself has no separate resume
    // state. Simulate the second run's query returning nothing.
    const deps = makeDeps({ listCandidateAnchors: vi.fn().mockResolvedValue([]) });

    const result = await runDocusignSignerBackfill(deps);

    expect(result.anchorsScanned).toBe(0);
    expect(deps.fetchEnvelopeSigners).not.toHaveBeenCalled();
  });

  it('sleeps between per-envelope API calls using the configured delay', async () => {
    const deps = makeDeps({
      listCandidateAnchors: vi.fn().mockResolvedValue([
        outboundCandidate({ anchorId: 'a1', envelopeId: 'env-a' }),
        outboundCandidate({ anchorId: 'a2', envelopeId: 'env-b' }),
      ]),
    });

    await runDocusignSignerBackfill(deps, { requestDelayMs: 123 });

    expect(deps.sleep).toHaveBeenCalledWith(123);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it('continues to the next integration when token refresh fails for one', async () => {
    const integrationB: DocusignSignerBackfillIntegration = { ...INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([INTEGRATION, integrationB]),
      getAccessToken: vi.fn()
        .mockRejectedValueOnce(new Error('refresh_token_not_found'))
        .mockResolvedValueOnce('at-2'),
      listCandidateAnchors: vi.fn().mockResolvedValue([outboundCandidate({ anchorId: 'a-org2', orgId: 'org-2' })]),
    });

    const result = await runDocusignSignerBackfill(deps);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ integration_id: 'int-1' });
    expect(result.integrationsChecked).toBe(2);
    expect(deps.fetchEnvelopeSigners).toHaveBeenCalledTimes(1);
  });

  it('fails closed (ok:false, no integrations processed) when listActiveIntegrations throws', async () => {
    const deps = makeDeps({ listActiveIntegrations: vi.fn().mockRejectedValue(new Error('db down')) });

    const result = await runDocusignSignerBackfill(deps);

    expect(result.ok).toBe(false);
    expect(result.integrationsChecked).toBe(0);
    expect(deps.listCandidateAnchors).not.toHaveBeenCalled();
  });
});
