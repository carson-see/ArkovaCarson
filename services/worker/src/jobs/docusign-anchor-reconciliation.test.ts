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
    // A chainable supabase-query stub. The query is now ARRAY-terminal
    // (`.limit()` resolves) rather than `.maybeSingle()`-terminal — see the
    // ORDER BY regression test below for why. `rows` accepts either a single
    // row (wrapped) or an array.
    // The guard now issues ONE indexed point lookup PER key in
    // ENVELOPE_ID_METADATA_KEYS instead of a single `.or()`. Each is
    // array-terminal on `.limit()`. `eqSpy` captures the metadata column each
    // lookup filtered on.
    function makeDb(result: { data: unknown; error: unknown }) {
      const eqSpy = vi.fn();
      const calls: string[] = [];
      const rows = result.data == null
        ? []
        : (Array.isArray(result.data) ? result.data : [result.data]);
      let served = false;
      const makeQ = () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'is', 'neq', 'or', 'order']) {
          q[m] = vi.fn(() => { calls.push(m); return q; });
        }
        q.eq = vi.fn((col: string) => {
          if (col.startsWith('metadata->>')) eqSpy(col);
          return q;
        });
        // Serve the injected rows once so a single logical match is not
        // multiplied across the three per-key lookups.
        q.limit = vi.fn(async () => {
          calls.push('limit');
          if (result.error) return { data: null, error: result.error };
          if (served) return { data: [], error: null };
          served = true;
          return { data: rows, error: null };
        });
        return q;
      };
      const from = vi.fn(() => makeQ());
      return { db: { from } as never, from, eqSpy, calls };
    }

    // Regression — PROD, org 40383eb2 (3.15M anchors), artifact 921347cc.
    // The guard used a single 3-branch `.or()` and timed out. The cause is a
    // COSTING error, not a missing index: the planner estimates 51,038 matching
    // rows when the truth is 0, so with a small LIMIT it takes a scan. Measured
    // on prod with a value matching nothing:
    //   OR + ORDER BY LIMIT 1 -> Index Scan Backward,        cost 2,209,325
    //   OR + LIMIT 1          -> Seq Scan,                   cost 1,845,309
    //   single-key .eq        -> Index Scan on its own index, cost 1.23,
    //                            ACTUAL 0.064 ms, rows=0
    // No index can beat a wrong estimate, so the OR has to go.
    it('issues one indexed point lookup per metadata key — never a combined OR', async () => {
      const { db, from, eqSpy, calls } = makeDb({ data: null, error: null });
      await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });

      expect(from).toHaveBeenCalledTimes(ENVELOPE_ID_METADATA_KEYS.length);
      expect(calls).not.toContain('or');
      expect(calls).not.toContain('order');
      const columns = eqSpy.mock.calls.map((c) => c[0] as string);
      for (const key of ENVELOPE_ID_METADATA_KEYS) {
        expect(columns).toContain(`metadata->>${key}`);
      }
    });

    it('still returns the OLDEST match deterministically, tie-broken in application code', async () => {
      const { db } = makeDb({
        data: [
          { id: 'anch-new', public_id: 'pub-new', created_at: '2026-05-02T00:00:00.000Z' },
          { id: 'anch-old', public_id: 'pub-old', created_at: '2026-05-01T00:00:00.000Z' },
        ],
        error: null,
      });
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'anch-old', publicId: 'pub-old' });
    });

    it('returns the existing anchor when one exists for the org+envelope', async () => {
      const { db, from } = makeDb({ data: { id: 'anch-1', public_id: 'pub-1' }, error: null });
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'anch-1', publicId: 'pub-1' });
      expect(from).toHaveBeenCalledWith('anchors');
    });

    it('matches across BOTH paths metadata keys (source_envelope_id / envelope_id / external_ref)', async () => {
      const { db, eqSpy } = makeDb({ data: null, error: null });
      await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      const columns = eqSpy.mock.calls.map((c) => c[0] as string);
      for (const key of ENVELOPE_ID_METADATA_KEYS) {
        expect(columns).toContain(`metadata->>${key}`);
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
