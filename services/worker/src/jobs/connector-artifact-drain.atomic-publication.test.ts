import { describe, expect, it, vi } from 'vitest';
vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./batch-anchor.js', () => ({ processBatchAnchors: vi.fn() }));
vi.mock('../utils/sentry.js', () => ({ Sentry: { captureMessage: vi.fn() } }));
vi.mock('../config.js', () => ({ config: { enableConnectorArtifactDrain: true } }));
vi.mock('../utils/rpc.js', () => ({
  callRpc: (db: { rpc: (name: string, args: unknown) => unknown }, name: string, args: unknown) => db.rpc(name, args),
}));
const { defaultMaterializeAnchor } = await import('./connector-artifact-drain.js');
type Artifact = import('./connector-artifact-drain.js').ConnectorArtifactRow;
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANCHOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CAPTURED: Artifact = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', org_id: ORG, status: 'processing',
  source: 'docusign', external_ref: 'envelope-1', fingerprint_sha256: 'a'.repeat(64),
  byte_length: 1234, metadata: { _direction: 'inbound' }, anchor_id: null,
  credit_deduction_id: null, updated_at: '2026-09-05T12:00:00.000Z',
};
describe('connector artifact atomic publication', () => {
  it('a heal before publication cannot leave an anchor a concurrent broadcaster can claim', async () => {
    const artifact = structuredClone(CAPTURED);
    const broadcastFingerprints: string[] = [];
    const anchors: Array<Record<string, unknown>> = [];
    const heal = () => {
      artifact.fingerprint_sha256 = 'b'.repeat(64);
      artifact.metadata = {};
      artifact.updated_at = '2026-09-05T12:00:00.001Z';
    };
    const claimPending = () => {
      for (const anchor of anchors) {
        if (anchor.status === 'PENDING' && anchor.deleted_at == null) {
          anchor.status = 'BROADCASTING';
          broadcastFingerprints.push(String(anchor.fingerprint));
        }
      }
    };
    const db = {
      from(table: string) {
        let payload: Record<string, unknown> = {};
        const query = {
          select() { return query; }, eq() { return query; }, in() { return query; },
          is() { return query; }, neq() { return query; }, order() { return query; },
          limit() { return table === 'org_members' ? query : Promise.resolve({ data: [], error: null }); },
          maybeSingle() { return Promise.resolve({ data: { user_id: USER, role: 'owner' }, error: null }); },
          insert(value: Record<string, unknown>) { payload = value; return query; },
          single() {
            // Old order: heal, committed INSERT, broadcaster claim, link CAS.
            heal(); anchors.push({ id: ANCHOR, ...payload }); claimPending();
            return Promise.resolve({ data: { id: ANCHOR, public_id: 'ARK-TEST-1' }, error: null });
          },
        };
        return query;
      },
      rpc: vi.fn(async () => {
        // Acquiring the artifact lock observes the heal. Reject before INSERT.
        // A paired real PostgreSQL test verifies locks and authorization.
        heal(); claimPending();
        return { data: { outcome: 'superseded', anchor_id: null, public_id: null, created: false }, error: null };
      }),
    };
    const result = await defaultMaterializeAnchor(structuredClone(CAPTURED), { db });
    expect(broadcastFingerprints).toEqual([]);
    expect(anchors).toEqual([]);
    expect(result).toMatchObject({ outcome: 'superseded' });
    expect(artifact.anchor_id).toBeNull();
    expect(artifact.fingerprint_sha256).toBe('b'.repeat(64));
  });
});
