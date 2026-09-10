/**
 * IMPORTER-CANNOT-SET-SECURED guard test (SCRUM-2486 AC-4, Lane 1).
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────────
 * Per CLAUDE.md §1.4, `anchor.status = 'SECURED'` is WORKER-ONLY via service_role
 * AFTER on-chain broadcast + confirmation. The connector/importer path (a
 * DocuSign/Drive-fetched document draining through `connector-artifact-drain.ts`)
 * must NEVER be able to reach a SECURED write on `anchors` — it may only
 * MATERIALIZE a fresh `PENDING` anchor and then hand off to the worker-owned
 * batch-anchor + confirmation path, which is the sole SECURED producer
 * (`check-confirmations.ts`).
 *
 * ── WHAT PROVES IT ───────────────────────────────────────────────────────────
 * `defaultMaterializeAnchor` proposes a payload to the atomic SQL transaction.
 * Two app-level defences are asserted here; SQL also revalidates locked source:
 *
 *   1. A hard-coded `status: 'PENDING' as const` on the insert payload — the
 *      importer literally cannot ask for any other status.
 *   2. A `.strict()` Zod schema `AnchorInsertPayload` whose `status` is
 *      `z.literal('PENDING')` — so even a hypothetical future edit that tried to
 *      pass `status: 'SECURED'` (or let attacker-influenced metadata smuggle one
 *      in) is REJECTED before the row reaches Postgres.
 *
 * Together with the DB `anchors_chain_data_consistency` CHECK (status='SECURED'
 * ⇒ chain_tx_id NOT NULL) and the fact that `check-confirmations.ts` is the sole
 * SECURED writer, this makes an importer-set SECURED structurally impossible.
 *
 * Mocks only — NO real DB. Drives the REAL `defaultMaterializeAnchor` against a
 * fake RPC that records the proposed payload, and exercises the REAL Zod schema.
 */

import { describe, it, expect, vi } from 'vitest';
import { callRpc } from '../utils/rpc.js';

// The module transitively imports the eager `utils/db.js` singleton + worker
// config; mock every side-effecting dep so this pure-guard test loads without
// prod env (mirrors `connector-artifact-drain.test.ts`). Every DB call in this
// test is on an INJECTED client, so the default `db` must never be used.
vi.mock('../utils/db.js', () => ({
  db: {
    from: () => {
      throw new Error('default db must not be used');
    },
  },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./batch-anchor.js', () => ({ processBatchAnchors: vi.fn() }));
vi.mock('../utils/sentry.js', () => ({ Sentry: { captureMessage: vi.fn() } }));
vi.mock('../utils/rpc.js', () => ({ callRpc: vi.fn() }));
vi.mock('../config.js', () => ({ config: { enableConnectorArtifactDrain: true } }));

import {
  defaultMaterializeAnchor,
  AnchorInsertPayload,
  type ConnectorArtifactRow,
} from './connector-artifact-drain.js';

const FP = 'a'.repeat(64);
// Valid v4-shaped UUIDs (version nibble 4, variant nibble 8) so the schema's
// `.uuid()` accepts them.
const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

function artifactRow(overrides: Partial<ConnectorArtifactRow> = {}): ConnectorArtifactRow {
  return {
    id: 'artifact-1',
    org_id: ORG,
    source: 'docusign',
    external_ref: 'envelope-1',
    fingerprint_sha256: FP,
    metadata: { filename: 'contract.pdf' },
    status: 'pending',
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as ConnectorArtifactRow;
}

/** Capture the RPC's proposed payload; client-side inserts/updates are forbidden. */
function makeCapturingClient(opts: { actorUserId?: string | null } = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  vi.mocked(callRpc).mockImplementation(async (_db, name, args) => {
    expect(name).toBe('materialize_connector_artifact_anchor');
    inserts.push({ table: 'anchors', values: args!.p_anchor_payload as Record<string, unknown> });
    return { data: { outcome: 'linked', anchor_id: ACTOR, public_id: 'anc_pub1', created: true }, error: null };
  });
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'is', 'neq', 'or', 'order', 'limit']) {
        chain[method] = () => chain;
      }
      const result = { data: table === 'org_members'
        ? (opts.actorUserId === null ? null : { user_id: opts.actorUserId ?? ACTOR, role: 'owner' })
        : null, error: null };
      chain.maybeSingle = async () => result;
      chain.then = (resolve: (value: unknown) => void) => Promise.resolve(result).then(resolve);
      return chain;
    },
  };
  return { db: client as unknown as Parameters<typeof defaultMaterializeAnchor>[1]['db'], inserts };
}

describe('SCRUM-2486 AC-4: importer materializes PENDING only, never SECURED', () => {
  it('defaultMaterializeAnchor requests atomic publication with status="PENDING"', async () => {
    const { db, inserts } = makeCapturingClient();

    const result = await defaultMaterializeAnchor(artifactRow(), { db });

    // The successful RPC reply confirms creation and linking committed together.
    expect(result).toEqual({ outcome: 'linked', anchorId: ACTOR, anchorPublicId: 'anc_pub1', created: true });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('anchors');
    expect(inserts[0].values.status).toBe('PENDING');
    expect(inserts[0].values.status).not.toBe('SECURED');
    expect(inserts[0].values.fingerprint).toBe(FP);
    // R2: every row here was fetched + hashed server-side (§1.6A) — 'document_bytes'.
    expect(inserts[0].values.fingerprint_source).toBe('document_bytes');
    // The importer never writes chain data — that's the worker's job post-broadcast.
    expect(inserts[0].values.chain_tx_id).toBeUndefined();
    expect(inserts[0].values.chain_block_height).toBeUndefined();
  });

  it('attacker-influenced metadata cannot smuggle a status/chain field into the insert', async () => {
    const { db, inserts } = makeCapturingClient();

    // A hostile connector row tries to inject status + chain provenance via metadata.
    await defaultMaterializeAnchor(
      artifactRow({
        metadata: {
          filename: 'contract.pdf',
          status: 'SECURED',
          chain_tx_id: 'forged-txid',
          chain_block_height: 999,
        },
      }),
      { db },
    );

    const v = inserts[0].values;
    // Top-level status stays PENDING; the smuggled values live only inside the
    // nested `metadata` object and never become real anchor columns.
    expect(v.status).toBe('PENDING');
    expect(v.chain_tx_id).toBeUndefined();
    expect(v.chain_block_height).toBeUndefined();
  });

  it('AnchorInsertPayload Zod schema REJECTS a status="SECURED" payload', () => {
    const secured = {
      fingerprint: FP,
      status: 'SECURED',
      org_id: ORG,
      user_id: ACTOR,
      filename: 'contract.pdf',
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: {},
    };
    const parsed = AnchorInsertPayload.safeParse(secured);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The failure is specifically on the `status` field.
      expect(parsed.error.issues.some((i) => i.path.includes('status'))).toBe(true);
    }
  });

  it('AnchorInsertPayload Zod schema REJECTS every non-PENDING anchor_status literal', () => {
    const nonPending = [
      'BROADCASTING',
      'SUBMITTED',
      'SECURED',
      'REVOKED',
      'EXPIRED',
      'SUPERSEDED',
      'PENDING_RESOLUTION',
    ];
    for (const status of nonPending) {
      const parsed = AnchorInsertPayload.safeParse({
        fingerprint: FP,
        status,
        org_id: ORG,
        user_id: ACTOR,
        filename: 'contract.pdf',
        credential_type: 'CONTRACT_POSTSIGNING',
        metadata: {},
      });
      expect(parsed.success, `status=${status} must be rejected`).toBe(false);
    }
  });

  it('AnchorInsertPayload Zod schema ACCEPTS the canonical PENDING payload', () => {
    const parsed = AnchorInsertPayload.safeParse({
      fingerprint: FP,
      status: 'PENDING',
      org_id: ORG,
      user_id: ACTOR,
      filename: 'contract.pdf',
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: {},
      fingerprint_source: 'document_bytes',
    });
    expect(parsed.success).toBe(true);
  });

  it('AnchorInsertPayload is .strict() — an extra chain_tx_id key is rejected (no chain smuggling)', () => {
    const parsed = AnchorInsertPayload.safeParse({
      fingerprint: FP,
      status: 'PENDING',
      org_id: ORG,
      user_id: ACTOR,
      filename: 'contract.pdf',
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: {},
      fingerprint_source: 'document_bytes',
      chain_tx_id: 'forged-txid',
    });
    expect(parsed.success).toBe(false);
  });
});

// R2 (CTO Decision Record, docusign-bilateral-2026-08): the outbound fetched-
// document path (this drain) always fingerprints real bytes it fetched
// server-side — never a declared/asserted hash — so it must always classify
// as anchors.fingerprint_source='document_bytes' (migration 0376/0384).
describe('R2: connector-artifact-drain sets fingerprint_source=document_bytes', () => {
  it('defaultMaterializeAnchor stamps fingerprint_source=document_bytes on the proposed atomic RPC payload', async () => {
    const { db, inserts } = makeCapturingClient();

    await defaultMaterializeAnchor(artifactRow(), { db });

    expect(inserts).toHaveLength(1);
    expect(inserts[0].values.fingerprint_source).toBe('document_bytes');
  });

  it('is unconditional across connector sources — google_drive rows get the same class', async () => {
    const { db, inserts } = makeCapturingClient();

    await defaultMaterializeAnchor(artifactRow({ source: 'google_drive', external_ref: 'file-1' }), { db });

    expect(inserts[0].values.fingerprint_source).toBe('document_bytes');
  });

  it('attacker-influenced metadata cannot override fingerprint_source (top-level field, not spread from metadata)', async () => {
    const { db, inserts } = makeCapturingClient();

    await defaultMaterializeAnchor(
      artifactRow({
        metadata: {
          filename: 'contract.pdf',
          fingerprint_source: 'issuer_record_attestation',
        },
      }),
      { db },
    );

    // The metadata sub-key is a distinct, unrelated JSONB field (free text,
    // no CHECK constraint) — it never reaches the top-level typed column,
    // which is always set by this path, never derived from metadata.
    expect(inserts[0].values.fingerprint_source).toBe('document_bytes');
  });

  it('AnchorInsertPayload rejects declared evidence without inbound provenance', () => {
    const parsed = AnchorInsertPayload.safeParse({
      fingerprint: FP,
      status: 'PENDING',
      org_id: ORG,
      user_id: ACTOR,
      filename: 'contract.pdf',
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: {},
      fingerprint_source: 'issuer_record_attestation',
    });
    expect(parsed.success).toBe(false);
  });

  it('AnchorInsertPayload Zod schema REJECTS a missing fingerprint_source', () => {
    const parsed = AnchorInsertPayload.safeParse({
      fingerprint: FP,
      status: 'PENDING',
      org_id: ORG,
      user_id: ACTOR,
      filename: 'contract.pdf',
      credential_type: 'CONTRACT_POSTSIGNING',
      metadata: {},
    });
    expect(parsed.success).toBe(false);
  });
});

describe('atomic publication RPC boundary', () => {
  it('preserves declared provenance for the explicitly inbound branch', async () => {
    const { db, inserts } = makeCapturingClient();
    await defaultMaterializeAnchor(artifactRow({ metadata: { filename: 'inbound.pdf', _direction: 'inbound' } }), { db });
    expect(inserts[0].values.fingerprint_source).toBe('issuer_record_attestation');
  });

  it('passes the complete captured source and retains an already linked anchor id', async () => {
    const { db } = makeCapturingClient();
    const row = artifactRow({ status: 'processing', updated_at: '2026-09-05T10:00:00Z',
      anchor_id: ORG, metadata: { _direction: 'inbound', filename: 'contract.pdf' } });
    await defaultMaterializeAnchor(row, { db });
    expect(callRpc).toHaveBeenLastCalledWith(db, 'materialize_connector_artifact_anchor', expect.objectContaining({
      p_artifact_id: row.id, p_org_id: ORG, p_expected_updated_at: row.updated_at,
      p_expected_fingerprint: FP, p_expected_metadata: row.metadata, p_existing_anchor_id: ORG,
    }));
  });

  it.each([
    { data: null, error: { message: 'connection lost' } },
    { data: null, error: null },
    { data: { outcome: 'linked', anchor_id: ACTOR, public_id: 'pub' }, error: null },
    { data: { outcome: 'linked', anchor_id: 'invalid', public_id: 'pub', created: true }, error: null },
    { data: { outcome: 'unknown' }, error: null },
  ])('unconfirmed or malformed reply never licenses a debit: %j', async (reply) => {
    const { db } = makeCapturingClient();
    vi.mocked(callRpc).mockResolvedValueOnce(reply);
    await expect(defaultMaterializeAnchor(artifactRow(), { db })).resolves.toEqual({ outcome: 'lost_lease' });
  });

  it.each(['superseded', 'lost_lease'] as const)('passes through the SQL %s rejection without a write', async (outcome) => {
    const { db, inserts } = makeCapturingClient();
    vi.mocked(callRpc).mockResolvedValueOnce({ data: { outcome }, error: null });
    await expect(defaultMaterializeAnchor(artifactRow(), { db })).resolves.toEqual({ outcome });
    expect(inserts).toEqual([]);
  });
});
