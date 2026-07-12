/**
 * Tests for the SECURED-chain-integrity back-catalogue AUDIT (SCRUM-2486 AC-2).
 *
 * This is a READ-ONLY audit. It NEVER writes / mutates / inserts / backfills.
 * Mocks only — NO real DB, NO real chain. Pins the invariant + safety guarantees:
 *
 *   Invariant (per SCRUM-2486 / CLAUDE.md §1.4): every anchor with
 *   status='SECURED' MUST have
 *     - a non-null `chain_tx_id`,
 *     - a 64-hex `fingerprint`,
 *     - and (WHERE the column is populated) a positive `chain_block_height`.
 *
 *   Safety:
 *     1. The audit issues ZERO write/update/insert/delete/rpc calls (read-only).
 *     2. Only status='SECURED' rows are considered (the SELECT filters SECURED;
 *        non-SECURED rows are never fetched, so they can't be flagged).
 *     3. Cursor-paginated + resumable over the ~2.97M back-catalogue.
 *     4. Violations are REPORTED with bounded sample ids — never fabricated,
 *        never repaired.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runSecuredChainIntegrityAudit,
  classifyAnchorRow,
  type SecuredAnchorAuditRow,
  type AuditLogger,
} from './auditSecuredChainIntegrity.js';

// The audit library takes an injected client, so tests never load prod config.
// Mock it defensively in case a transitive import pulls it in.
vi.mock('../config.js', () => ({ config: {} }));

const silentLogger: AuditLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const VALID_FP = 'a'.repeat(64);
const VALID_FP_2 = 'b'.repeat(64);

/** A well-formed, invariant-satisfying SECURED row. */
function goodRow(overrides: Partial<SecuredAnchorAuditRow> = {}): SecuredAnchorAuditRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    public_id: 'anc_good1',
    status: 'SECURED',
    fingerprint: VALID_FP,
    chain_tx_id: 'txid-abc',
    chain_block_height: 800001,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Read-only fake client: serves paginated `.from('anchors').select().eq('status',
 * 'SECURED').gt('created_at', cursor).order().limit(n)`. Records EVERY call to any
 * mutating method so a read-only assertion can prove zero writes.
 */
function makeReadOnlyClient(allRows: SecuredAnchorAuditRow[]) {
  const forbiddenCalls: string[] = [];
  const sorted = [...allRows].sort((a, b) => a.created_at.localeCompare(b.created_at));

  const forbid =
    (name: string) =>
    (..._args: unknown[]) => {
      forbiddenCalls.push(name);
      throw new Error(`READ-ONLY VIOLATION: audit called ${name}()`);
    };

  const client = {
    from(_table: string) {
      return {
        select(_cols: string, _opts?: unknown) {
          return {
            eq(_col: string, _val: string) {
              return {
                gt(_gcol: string, cursor: string) {
                  return {
                    order(_oc: string, _opts2: { ascending: boolean }) {
                      return {
                        async limit(n: number) {
                          const page = sorted.filter((r) => r.created_at > cursor).slice(0, n);
                          return { data: page, error: null };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        // Any of these being invoked is a read-only violation.
        insert: forbid('insert'),
        update: forbid('update'),
        upsert: forbid('upsert'),
        delete: forbid('delete'),
      };
    },
    rpc: forbid('rpc'),
  };

  return {
    client: client as unknown as Parameters<typeof runSecuredChainIntegrityAudit>[0]['client'],
    forbiddenCalls,
  };
}

describe('classifyAnchorRow (pure invariant check)', () => {
  it('passes a well-formed SECURED row', () => {
    expect(classifyAnchorRow(goodRow())).toEqual({ ok: true, violations: [] });
  });

  it('flags a SECURED row with null chain_tx_id', () => {
    const r = classifyAnchorRow(goodRow({ chain_tx_id: null }));
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('missing_chain_tx_id');
  });

  it('flags a SECURED row with whitespace-only chain_tx_id', () => {
    const r = classifyAnchorRow(goodRow({ chain_tx_id: '   ' }));
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('missing_chain_tx_id');
  });

  it('flags a SECURED row with a non-64-hex fingerprint', () => {
    const r = classifyAnchorRow(goodRow({ fingerprint: 'not-hex' }));
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('bad_fingerprint');
  });

  it('flags a 63-char fingerprint (wrong length)', () => {
    const r = classifyAnchorRow(goodRow({ fingerprint: 'A'.repeat(63) }));
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('bad_fingerprint');
  });

  it('accepts a mixed-case valid 64-hex fingerprint (char(64) CHECK is case-insensitive)', () => {
    const r = classifyAnchorRow(goodRow({ fingerprint: 'AbCdEf' + '0'.repeat(58) }));
    expect(r.ok).toBe(true);
  });

  it('flags a present-but-non-positive chain_block_height', () => {
    const r = classifyAnchorRow(goodRow({ chain_block_height: 0 }));
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('bad_block_height');
  });

  it('does NOT flag a null chain_block_height (column optional / not-yet-confirmed)', () => {
    const r = classifyAnchorRow(goodRow({ chain_block_height: null }));
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('reports MULTIPLE violations on a doubly-bad row', () => {
    const r = classifyAnchorRow(goodRow({ chain_tx_id: null, fingerprint: 'zzz' }));
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(
      expect.arrayContaining(['missing_chain_tx_id', 'bad_fingerprint']),
    );
  });
});

describe('runSecuredChainIntegrityAudit (read-only scan)', () => {
  it('reports zero violations for an all-clean back-catalogue', async () => {
    const { client, forbiddenCalls } = makeReadOnlyClient([
      goodRow({ id: 'id-1', created_at: '2026-01-01T00:00:00.000Z' }),
      goodRow({ id: 'id-2', created_at: '2026-01-02T00:00:00.000Z' }),
    ]);

    const summary = await runSecuredChainIntegrityAudit({
      client,
      logger: silentLogger,
      batchSize: 50,
    });

    expect(forbiddenCalls).toEqual([]);
    expect(summary.securedScanned).toBe(2);
    expect(summary.violations).toBe(0);
    expect(summary.violationsByType).toEqual({
      missing_chain_tx_id: 0,
      bad_fingerprint: 0,
      bad_block_height: 0,
    });
    expect(summary.sampleOffendingIds).toEqual([]);
    expect(summary.clean).toBe(true);
  });

  it('counts + samples violations, tallied by type, WITHOUT writing anything', async () => {
    const { client, forbiddenCalls } = makeReadOnlyClient([
      goodRow({ id: 'ok-1', created_at: '2026-01-01T00:00:00.000Z' }),
      goodRow({ id: 'bad-txid', chain_tx_id: null, created_at: '2026-01-02T00:00:00.000Z' }),
      goodRow({ id: 'bad-fp', fingerprint: 'nope', created_at: '2026-01-03T00:00:00.000Z' }),
      goodRow({ id: 'bad-height', chain_block_height: -5, created_at: '2026-01-04T00:00:00.000Z' }),
    ]);

    const summary = await runSecuredChainIntegrityAudit({
      client,
      logger: silentLogger,
      batchSize: 2, // force multiple pages
    });

    expect(forbiddenCalls).toEqual([]);
    expect(summary.securedScanned).toBe(4);
    expect(summary.violations).toBe(3);
    expect(summary.violationsByType.missing_chain_tx_id).toBe(1);
    expect(summary.violationsByType.bad_fingerprint).toBe(1);
    expect(summary.violationsByType.bad_block_height).toBe(1);
    expect(summary.sampleOffendingIds).toEqual(
      expect.arrayContaining(['bad-txid', 'bad-fp', 'bad-height']),
    );
    expect(summary.clean).toBe(false);
  });

  it('bounds sampleOffendingIds to sampleLimit even with many violations', async () => {
    const many: SecuredAnchorAuditRow[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(
        goodRow({
          id: `bad-${i}`,
          chain_tx_id: null,
          created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      );
    }
    const { client } = makeReadOnlyClient(many);

    const summary = await runSecuredChainIntegrityAudit({
      client,
      logger: silentLogger,
      batchSize: 10,
      sampleLimit: 5,
    });

    expect(summary.violations).toBe(40);
    expect(summary.sampleOffendingIds).toHaveLength(5);
  });

  it('paginates via the created_at cursor and terminates (no infinite loop)', async () => {
    const rows: SecuredAnchorAuditRow[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(
        goodRow({
          id: `id-${i}`,
          fingerprint: i % 2 === 0 ? VALID_FP : VALID_FP_2,
          created_at: `2026-02-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        }),
      );
    }
    const { client } = makeReadOnlyClient(rows);

    const summary = await runSecuredChainIntegrityAudit({
      client,
      logger: silentLogger,
      batchSize: 7,
    });

    expect(summary.securedScanned).toBe(25);
    expect(summary.violations).toBe(0);
    expect(summary.batchesScanned).toBe(Math.ceil(25 / 7) + 1); // +1 for the final short/empty page
    expect(summary.finalCursor).toBe('2026-02-01T00:00:24.000Z');
  });

  it('surfaces a read error loudly (does not silently report clean)', async () => {
    const client = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  gt() {
                    return {
                      order() {
                        return {
                          async limit() {
                            return { data: null, error: { message: 'boom' } };
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
    } as unknown as Parameters<typeof runSecuredChainIntegrityAudit>[0]['client'];

    await expect(
      runSecuredChainIntegrityAudit({ client, logger: silentLogger, batchSize: 10 }),
    ).rejects.toThrow(/boom/);
  });
});
