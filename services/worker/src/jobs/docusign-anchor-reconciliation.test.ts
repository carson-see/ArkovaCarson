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
    /**
     * A chainable supabase-query stub that records every filter each query
     * applies. The guard issues ONE query PER metadata key (each hitting its own
     * partial expression index) instead of a single unindexed `.or()`, so the
     * stub resolves each query against `resultsByKey`, keyed on whichever
     * `metadata->>...` column that query filtered on.
     */
    function makeDb(
      resultsByKey:
        | { data: unknown; error: unknown }
        | Record<string, { data: unknown; error: unknown }>,
    ) {
      const queries: Array<{
        eq: Array<[string, unknown]>;
        not: Array<[string, string, unknown]>;
        is: Array<[string, unknown]>;
        neq: Array<[string, unknown]>;
        select: string[];
      }> = [];

      const from = vi.fn(() => {
        const rec = { eq: [], not: [], is: [], neq: [], select: [] } as (typeof queries)[number];
        queries.push(rec);
        const q: Record<string, unknown> = {};
        q.select = vi.fn((cols: string) => {
          rec.select.push(cols);
          return q;
        });
        q.eq = vi.fn((col: string, val: unknown) => {
          rec.eq.push([col, val]);
          return q;
        });
        q.not = vi.fn((col: string, op: string, val: unknown) => {
          rec.not.push([col, op, val]);
          return q;
        });
        q.is = vi.fn((col: string, val: unknown) => {
          rec.is.push([col, val]);
          return q;
        });
        q.neq = vi.fn((col: string, val: unknown) => {
          rec.neq.push([col, val]);
          return q;
        });
        for (const m of ['order', 'limit']) q[m] = vi.fn(() => q);
        q.maybeSingle = vi.fn(async () => {
          if ('data' in resultsByKey || 'error' in resultsByKey) {
            return resultsByKey as { data: unknown; error: unknown };
          }
          const metaCol = rec.eq.find(([col]) => col.startsWith('metadata->>'))?.[0] ?? '';
          const key = metaCol.slice('metadata->>'.length);
          return (
            (resultsByKey as Record<string, { data: unknown; error: unknown }>)[key] ?? {
              data: null,
              error: null,
            }
          );
        });
        return q;
      });

      return { db: { from } as never, from, queries };
    }

    it('returns the existing anchor when one exists for the org+envelope', async () => {
      const { db, from } = makeDb({
        source_envelope_id: {
          data: { id: 'anch-1', public_id: 'pub-1', created_at: '2026-07-01T00:00:00.000Z' },
          error: null,
        },
      });
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'anch-1', publicId: 'pub-1' });
      expect(from).toHaveBeenCalledWith('anchors');
    });

    it('matches across BOTH paths metadata keys (source_envelope_id / envelope_id / external_ref)', async () => {
      for (const key of ENVELOPE_ID_METADATA_KEYS) {
        const { db } = makeDb({
          [key]: {
            data: { id: `anch-${key}`, public_id: 'pub-1', created_at: '2026-07-01T00:00:00.000Z' },
            error: null,
          },
        });
        const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
        expect(found?.id).toBe(`anch-${key}`);
      }
    });

    it('issues one org-scoped equality query per metadata key — never an unindexed OR', async () => {
      // REGRESSION (2026-08-01 prod incident): the single `.or()` across three
      // `metadata->>key` extractions had no usable index, so on the org holding
      // the ~2.97M-row public-records corpus Postgres fell back to a full scan
      // and hit statement_timeout — every real DocuSign envelope failed to
      // materialize. Each key must now be its own equality query so the planner
      // can use that key's dedicated partial expression index.
      const { db, queries } = makeDb({ data: null, error: null });
      await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });

      expect(queries).toHaveLength(ENVELOPE_ID_METADATA_KEYS.length);
      for (const q of queries) {
        expect(q.eq).toContainEqual(['org_id', 'org-1']);
        // Exactly one metadata-key equality per query (no OR fan-out).
        const metaEqs = q.eq.filter(([col]) => col.startsWith('metadata->>'));
        expect(metaEqs).toHaveLength(1);
        expect(metaEqs[0][1]).toBe('env-9');
        // Redundant-but-deliberate IS NOT NULL: makes the partial index's
        // predicate trivially implied by the query quals.
        expect(q.not).toContainEqual([metaEqs[0][0], 'is', null]);
        // Live rows only — same semantics as before.
        expect(q.is).toContainEqual(['deleted_at', null]);
        expect(q.neq).toContainEqual(['status', 'REVOKED']);
      }
      // One query per key, each on a distinct key.
      const cols = queries.map((q) => q.eq.find(([c]) => c.startsWith('metadata->>'))?.[0]);
      expect(new Set(cols).size).toBe(ENVELOPE_ID_METADATA_KEYS.length);
      for (const key of ENVELOPE_ID_METADATA_KEYS) {
        expect(cols).toContain(`metadata->>${key}`);
      }
    });

    it('returns the OLDEST matching anchor when several keys match different anchors', async () => {
      // Preserves the pre-fix `.order(created_at).limit(1)` semantics across the
      // now-split queries: the earliest-created live anchor wins, so a replay
      // always reuses the same anchor rather than flip-flopping between two.
      const { db } = makeDb({
        source_envelope_id: {
          data: { id: 'newer', public_id: 'pub-newer', created_at: '2026-07-02T00:00:00.000Z' },
          error: null,
        },
        envelope_id: {
          data: { id: 'oldest', public_id: 'pub-oldest', created_at: '2026-07-01T00:00:00.000Z' },
          error: null,
        },
        external_ref: {
          data: { id: 'newest', public_id: 'pub-newest', created_at: '2026-07-03T00:00:00.000Z' },
          error: null,
        },
      });
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'oldest', publicId: 'pub-oldest' });
    });

    it('breaks a created_at tie deterministically by anchor id', async () => {
      const at = '2026-07-01T00:00:00.000Z';
      const { db } = makeDb({
        source_envelope_id: { data: { id: 'bbb', public_id: 'pub-b', created_at: at }, error: null },
        envelope_id: { data: { id: 'aaa', public_id: 'pub-a', created_at: at }, error: null },
      });
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'aaa', publicId: 'pub-a' });
    });

    it('returns null (no cross-path identity) when the envelope id is missing — no query', async () => {
      const { db, from } = makeDb({ data: null, error: null });
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: null })).toBeNull();
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: '  ' })).toBeNull();
      expect(from).not.toHaveBeenCalled();
    });

    it('bails (returns null, no query) on an unsafe envelope id', async () => {
      // The charset guard predates the split (it protected the raw `.or()`
      // filter string). `.eq()` passes the value as a bound parameter, so this
      // is now defense-in-depth rather than the sole barrier — kept because a
      // skipped guard is fail-safe (never creates a duplicate) and an envelope
      // id outside this charset is not a real DocuSign identifier.
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

    it('fails closed when only ONE of the per-key queries errors', async () => {
      // A partial failure must not be read as "no existing anchor" — that would
      // insert a duplicate anchor and move a second credit.
      const { db } = makeDb({
        source_envelope_id: { data: null, error: null },
        envelope_id: { data: null, error: { message: 'timeout' } },
        external_ref: { data: null, error: null },
      });
      await expect(
        findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' }),
      ).rejects.toThrow(/envelope anchor lookup failed: timeout/);
    });
  });
});
