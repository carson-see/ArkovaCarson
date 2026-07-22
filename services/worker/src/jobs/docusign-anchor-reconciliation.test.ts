import { describe, it, expect, vi } from 'vitest';
import {
  CONNECTOR_FETCH_SOURCES,
  connectorPathIsAuthoritative,
  isConnectorFetchSource,
  envelopeReconciliationKey,
  findExistingEnvelopeAnchor,
  ENVELOPE_ID_METADATA_KEYS,
} from './docusign-anchor-reconciliation.js';

const BOTH_ON = {
  enableConnectorArtifactEnqueue: true,
  enableConnectorArtifactDrain: true,
} as const;

describe('docusign-anchor-reconciliation — precedence decision (SCRUM-2904)', () => {
  describe('isConnectorFetchSource', () => {
    it('recognizes docusign (case/space-insensitive) as a server-fetch source', () => {
      expect(isConnectorFetchSource('docusign')).toBe(true);
      expect(isConnectorFetchSource('DocuSign')).toBe(true);
      expect(isConnectorFetchSource('  docusign ')).toBe(true);
    });

    it('does not treat a non-fetch vendor as a server-fetch source', () => {
      expect(isConnectorFetchSource('connector')).toBe(false);
      expect(isConnectorFetchSource('manual_upload')).toBe(false);
      expect(isConnectorFetchSource(null)).toBe(false);
      expect(isConnectorFetchSource(undefined)).toBe(false);
      expect(isConnectorFetchSource('')).toBe(false);
    });

    it('docusign is a member of the exported source set', () => {
      expect(CONNECTOR_FETCH_SOURCES.has('docusign')).toBe(true);
    });
  });

  describe('connectorPathIsAuthoritative', () => {
    it('connector path WINS for docusign only when BOTH connector flags are on', () => {
      expect(connectorPathIsAuthoritative({ source: 'docusign', ...BOTH_ON })).toBe(true);
    });

    it('declared-hash path stays authoritative when the ENQUEUE (producer) flag is off', () => {
      // Prod default today: the connector producer is gated off, so the
      // declared-hash rules path must remain the anchor writer.
      expect(
        connectorPathIsAuthoritative({
          source: 'docusign',
          enableConnectorArtifactEnqueue: false,
          enableConnectorArtifactDrain: true,
        }),
      ).toBe(false);
    });

    it('declared-hash path stays authoritative when the DRAIN (consumer) flag is off', () => {
      // pre-mortem #1: deferring into an enqueue-but-no-drain path would strand
      // the envelope in `pending` forever (anchors via NEITHER path). The
      // declared-hash path MUST remain the writer.
      expect(
        connectorPathIsAuthoritative({
          source: 'docusign',
          enableConnectorArtifactEnqueue: true,
          enableConnectorArtifactDrain: false,
        }),
      ).toBe(false);
    });

    it('declared-hash path stays authoritative when BOTH flags are off', () => {
      expect(
        connectorPathIsAuthoritative({
          source: 'docusign',
          enableConnectorArtifactEnqueue: false,
          enableConnectorArtifactDrain: false,
        }),
      ).toBe(false);
    });

    it('connector path is NOT authoritative for a non-fetch source even when both flags are on', () => {
      // A generic/manual source has no server-fetch mechanism, so the
      // declared-hash path is the only writer regardless of the flags.
      expect(connectorPathIsAuthoritative({ source: 'connector', ...BOTH_ON })).toBe(false);
      expect(connectorPathIsAuthoritative({ source: null, ...BOTH_ON })).toBe(false);
    });

    it('is case/space-insensitive on the source', () => {
      expect(connectorPathIsAuthoritative({ source: '  DOCUSIGN ', ...BOTH_ON })).toBe(true);
    });
  });

  describe('envelopeReconciliationKey', () => {
    it('builds a stable per-envelope key from source + envelope id', () => {
      expect(envelopeReconciliationKey('docusign', 'env-123')).toBe('docusign:env-123');
      // Normalized so the two paths (which may differ in casing/whitespace)
      // resolve the SAME key for the same envelope.
      expect(envelopeReconciliationKey('DocuSign', ' env-123 ')).toBe('docusign:env-123');
    });

    it('returns null when the envelope id is missing (no envelope-level identity)', () => {
      expect(envelopeReconciliationKey('docusign', null)).toBeNull();
      expect(envelopeReconciliationKey('docusign', '')).toBeNull();
      expect(envelopeReconciliationKey('docusign', '   ')).toBeNull();
    });
  });

  describe('findExistingEnvelopeAnchor (envelope-level guard)', () => {
    // A chainable supabase-query stub whose terminal `.maybeSingle()` resolves
    // to the injected result. `.or()` capture lets us assert the cross-path
    // metadata filter.
    function makeDb(result: { data: unknown; error: unknown }) {
      const orSpy = vi.fn();
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'neq', 'order', 'limit']) {
        q[m] = vi.fn(() => q);
      }
      q.or = vi.fn((arg: string) => {
        orSpy(arg);
        return q;
      });
      q.maybeSingle = vi.fn(async () => result);
      const from = vi.fn(() => q);
      return { db: { from } as never, from, orSpy };
    }

    it('returns the existing anchor when one exists for the org+envelope', async () => {
      const { db, from } = makeDb({ data: { id: 'anch-1', public_id: 'pub-1' }, error: null });
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'anch-1', publicId: 'pub-1' });
      expect(from).toHaveBeenCalledWith('anchors');
    });

    it('matches across BOTH paths metadata keys (source_envelope_id / envelope_id / external_ref)', async () => {
      const { db, orSpy } = makeDb({ data: null, error: null });
      await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      const orArg = orSpy.mock.calls[0][0] as string;
      for (const key of ENVELOPE_ID_METADATA_KEYS) {
        expect(orArg).toContain(`metadata->>${key}.eq.env-9`);
      }
    });

    it('returns null (no cross-path identity) when the envelope id is missing — no query', async () => {
      const { db, from } = makeDb({ data: null, error: null });
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: null })).toBeNull();
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: '  ' })).toBeNull();
      expect(from).not.toHaveBeenCalled();
    });

    it('bails (returns null, no query) on an unsafe envelope id — no PostgREST filter injection', async () => {
      // A comma/paren would corrupt the .or() filter grammar; bail to the
      // fingerprint-index fallback rather than issue a corrupted query.
      const { db, from } = makeDb({ data: null, error: null });
      for (const bad of ['env,evil', 'env)or(1', 'a,b.eq.c']) {
        expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: bad })).toBeNull();
      }
      expect(from).not.toHaveBeenCalled();
    });

    it('accepts GUID-shaped envelope ids (the DocuSign format)', async () => {
      const { db, from } = makeDb({ data: null, error: null });
      await findExistingEnvelopeAnchor({
        db,
        orgId: 'org-1',
        envelopeId: 'a1b2c3d4-e5f6-4789-8abc-def012345678',
      });
      expect(from).toHaveBeenCalledWith('anchors');
    });

    it('returns null when no anchor matches', async () => {
      const { db } = makeDb({ data: null, error: null });
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' })).toBeNull();
    });

    it('throws (fail-closed) on a lookup error rather than silently inserting a duplicate', async () => {
      const { db } = makeDb({ data: null, error: { message: 'boom' } });
      await expect(
        findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' }),
      ).rejects.toThrow(/envelope anchor lookup failed: boom/);
    });
  });
});
