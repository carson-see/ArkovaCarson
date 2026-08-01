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
    // A chainable supabase-query stub. SCRUM-2904-perf: the guard now issues
    // ONE targeted `.eq('metadata->>KEY', envelopeId)` lookup PER metadata key
    // (each backed by its own migration-0381 partial expression index) instead
    // of a single `.or()` scan across all three — so the stub records every
    // `.eq()` call (column, value) pair and lets each `from('anchors')` call
    // resolve to its own queued result, keyed by call order (one call per
    // ENVELOPE_ID_METADATA_KEYS entry, in order).
    function makeDb(results: Array<{ data: unknown; error: unknown }>) {
      const eqSpy = vi.fn();
      let call = 0;
      const from = vi.fn(() => {
        const result = results[call] ?? { data: null, error: null };
        call += 1;
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'is', 'neq', 'order', 'limit']) {
          q[m] = vi.fn(() => q);
        }
        q.eq = vi.fn((col: string, val: unknown) => {
          eqSpy(col, val);
          return q;
        });
        q.maybeSingle = vi.fn(async () => result);
        return q;
      });
      return { db: { from } as never, from, eqSpy };
    }

    it('returns the existing anchor when the FIRST key (source_envelope_id) matches', async () => {
      const { db, from } = makeDb([
        { data: { id: 'anch-1', public_id: 'pub-1', created_at: '2026-01-01T00:00:00Z' }, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ]);
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'anch-1', publicId: 'pub-1' });
      expect(from).toHaveBeenCalledWith('anchors');
      // Every key is still looked up (needed to find the globally-earliest
      // match across paths), not short-circuited on the first hit.
      expect(from).toHaveBeenCalledTimes(ENVELOPE_ID_METADATA_KEYS.length);
    });

    it('issues one targeted eq() lookup per metadata key — no .or() filter string', async () => {
      const { db, eqSpy } = makeDb([
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ]);
      await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      const metadataCalls = eqSpy.mock.calls.filter(([col]) => typeof col === 'string' && col.startsWith('metadata->>'));
      expect(metadataCalls).toHaveLength(ENVELOPE_ID_METADATA_KEYS.length);
      for (const key of ENVELOPE_ID_METADATA_KEYS) {
        expect(metadataCalls).toContainEqual([`metadata->>${key}`, 'env-9']);
      }
      // org_id is still applied on every lookup (org-scoped guard).
      for (const call of eqSpy.mock.calls) {
        if (call[0] === 'org_id') expect(call[1]).toBe('org-1');
      }
    });

    it('when BOTH paths raced and each created an anchor, reuses the EARLIER one by created_at (cross-key tie-break)', async () => {
      // source_envelope_id (checked first) matches a LATER anchor; envelope_id
      // (checked second) matches an EARLIER one. The earlier anchor must win —
      // preserving the original single-query `order by created_at asc limit 1`
      // semantics now that the union happens in application code.
      const { db } = makeDb([
        { data: { id: 'later', public_id: 'pub-later', created_at: '2026-02-01T00:00:00Z' }, error: null },
        { data: { id: 'earlier', public_id: 'pub-earlier', created_at: '2026-01-01T00:00:00Z' }, error: null },
        { data: null, error: null },
      ]);
      const found = await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' });
      expect(found).toEqual({ id: 'earlier', publicId: 'pub-earlier' });
    });

    it('returns null (no cross-path identity) when the envelope id is missing — no query', async () => {
      const { db, from } = makeDb([]);
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: null })).toBeNull();
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: '  ' })).toBeNull();
      expect(from).not.toHaveBeenCalled();
    });

    it('bails (returns null, no query) on an unsafe envelope id', async () => {
      const { db, from } = makeDb([]);
      for (const bad of ['env,evil', 'env)or(1', 'a,b.eq.c']) {
        expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: bad })).toBeNull();
      }
      expect(from).not.toHaveBeenCalled();
    });

    it('accepts GUID-shaped envelope ids (the DocuSign format)', async () => {
      const { db, from } = makeDb([
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ]);
      await findExistingEnvelopeAnchor({
        db,
        orgId: 'org-1',
        envelopeId: 'a1b2c3d4-e5f6-4789-8abc-def012345678',
      });
      expect(from).toHaveBeenCalledWith('anchors');
    });

    it('returns null when no key matches for any of the three metadata keys', async () => {
      const { db } = makeDb([
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
      ]);
      expect(await findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' })).toBeNull();
    });

    it('throws (fail-closed) on a lookup error rather than silently inserting a duplicate', async () => {
      const { db } = makeDb([{ data: null, error: { message: 'boom' } }]);
      await expect(
        findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' }),
      ).rejects.toThrow(/envelope anchor lookup failed.*boom/);
    });

    it('stops at the first erroring key lookup rather than issuing the remaining two', async () => {
      const { db, from } = makeDb([
        { data: null, error: null },
        { data: null, error: { message: 'boom' } },
      ]);
      await expect(
        findExistingEnvelopeAnchor({ db, orgId: 'org-1', envelopeId: 'env-9' }),
      ).rejects.toThrow(/envelope anchor lookup failed.*boom/);
      // source_envelope_id (no match) + envelope_id (error) = 2 calls; the
      // third (external_ref) is never issued once we've failed closed.
      expect(from).toHaveBeenCalledTimes(2);
    });
  });
});
