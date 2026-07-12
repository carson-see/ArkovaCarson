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
 * The importer's ONLY write to the `anchors` table is `defaultMaterializeAnchor`,
 * and it is guarded by TWO independent app-level defences, both asserted here:
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
 * fake client that records the insert, and exercises the REAL Zod schema.
 */

import { describe, it, expect, vi } from 'vitest';

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

/**
 * Fake client capturing exactly the two calls `defaultMaterializeAnchor` makes:
 *   - `.from('org_members')...maybeSingle()`  → the actor lookup
 *   - `.from('anchors').insert(v).select().single()` → the anchor insert
 * Records the inserted payload so the test can assert its status.
 */
function makeCapturingClient(opts: { actorUserId?: string | null } = {}) {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];

  const client = {
    from(table: string) {
      if (table === 'org_members') {
        return {
          select() {
            return {
              eq() {
                return {
                  in() {
                    return {
                      order() {
                        return {
                          limit() {
                            return {
                              async maybeSingle() {
                                return {
                                  data:
                                    opts.actorUserId === null
                                      ? null
                                      : { user_id: opts.actorUserId ?? ACTOR, role: 'owner' },
                                  error: null,
                                };
                              },
                            };
                          },
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      // anchors
      return {
        insert(values: Record<string, unknown>) {
          inserts.push({ table, values });
          return {
            select() {
              return {
                async single() {
                  return { data: { id: 'anchor-1', public_id: 'anc_pub1' }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    db: client as unknown as Parameters<typeof defaultMaterializeAnchor>[1]['db'],
    inserts,
  };
}

describe('SCRUM-2486 AC-4: importer materializes PENDING only, never SECURED', () => {
  it('defaultMaterializeAnchor inserts an anchor with status="PENDING"', async () => {
    const { db, inserts } = makeCapturingClient();

    const result = await defaultMaterializeAnchor(artifactRow(), { db });

    expect(result).toEqual({ anchorId: 'anchor-1', anchorPublicId: 'anc_pub1' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('anchors');
    expect(inserts[0].values.status).toBe('PENDING');
    expect(inserts[0].values.status).not.toBe('SECURED');
    expect(inserts[0].values.fingerprint).toBe(FP);
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
      chain_tx_id: 'forged-txid',
    });
    expect(parsed.success).toBe(false);
  });
});
