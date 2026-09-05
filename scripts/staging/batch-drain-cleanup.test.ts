import { describe, expect, it } from 'vitest';

import { cleanupSyntheticOrg, type CleanupClient } from './batch-drain-cleanup';

const ORG = '62617463-6864-4261-8969-6e2d72310000';

interface StubOptions {
  /** Per-invocation error for anchor_proofs .delete().in() calls (chunk order). */
  proofDeleteErrors?: Array<{ message: string } | null>;
  anchorsDeleteError?: { message: string } | null;
  creditsDeleteError?: { message: string } | null;
  orgDeleteError?: { message: string } | null;
  /** Residual counts returned by the zero-residual re-assert (default 0). */
  counts?: Partial<Record<'anchors' | 'anchor_proofs' | 'org_credits' | 'organizations', number>>;
  /** Make the residual count query for one table error out. */
  countError?: { table: string; error: { message: string } };
  /** Make the residual count query for one table return no count at all. */
  nullCountTable?: string;
}

function stubClient(opts: StubOptions, calls: string[]): CleanupClient {
  let proofDeleteCall = 0;
  const countFor = (table: string): number =>
    opts.counts?.[table as keyof NonNullable<StubOptions['counts']>] ?? 0;
  const countResult = (table: string) => {
    if (opts.countError?.table === table) {
      return Promise.resolve({ count: null, error: opts.countError.error });
    }
    if (opts.nullCountTable === table) {
      return Promise.resolve({ count: null, error: null });
    }
    return Promise.resolve({ count: countFor(table), error: null });
  };
  return {
    from(table: string) {
      return {
        delete() {
          return {
            in(_column: string, values: readonly string[]) {
              calls.push(`${table}.delete.in(${values.length})`);
              const error = table === 'anchor_proofs'
                ? (opts.proofDeleteErrors?.[proofDeleteCall++] ?? null)
                : null;
              return Promise.resolve({ error });
            },
            eq() {
              calls.push(`${table}.delete.eq`);
              let error: { message: string } | null = null;
              if (table === 'anchors') error = opts.anchorsDeleteError ?? null;
              if (table === 'org_credits') error = opts.creditsDeleteError ?? null;
              if (table === 'organizations') error = opts.orgDeleteError ?? null;
              return Promise.resolve({ error });
            },
          };
        },
        select() {
          return {
            in(_column: string, values: readonly string[]) {
              calls.push(`${table}.count.in(${values.length})`);
              return countResult(table);
            },
            eq() {
              calls.push(`${table}.count.eq`);
              return countResult(table);
            },
          };
        },
      };
    },
  };
}

describe('cleanupSyntheticOrg — every delete is checked (SCRUM-3531)', () => {
  it('deletes proofs first, then anchors, credits, and the org, and re-asserts zero residual', async () => {
    const calls: string[] = [];
    const client = stubClient({}, calls);

    const result = await cleanupSyntheticOrg(client, ORG, ['a1', 'a2', 'a3'], 2);

    expect(result.removedAnchors).toBe(3);
    expect(result.residual).toEqual({ anchors: 0, anchorProofs: 0, orgCredits: 0, organizations: 0 });
    expect(calls).toEqual([
      // FK-safe order: proofs before anchors, chunked.
      'anchor_proofs.delete.in(2)',
      'anchor_proofs.delete.in(1)',
      'anchors.delete.eq',
      'org_credits.delete.eq',
      'organizations.delete.eq',
      // Zero-residual re-assert AFTER all deletes.
      'anchors.count.eq',
      'org_credits.count.eq',
      'organizations.count.eq',
      'anchor_proofs.count.in(2)',
      'anchor_proofs.count.in(1)',
    ]);
  });

  it('fails on ANY anchor_proofs chunk delete error and stops before touching later tables', async () => {
    const calls: string[] = [];
    const client = stubClient(
      { proofDeleteErrors: [null, { message: 'permission denied for table anchor_proofs' }] },
      calls,
    );

    await expect(cleanupSyntheticOrg(client, ORG, ['a1', 'a2', 'a3'], 2))
      .rejects.toThrow(/anchor_proofs delete failed.*permission denied/);
    expect(calls).not.toContain('anchors.delete.eq');
    expect(calls).not.toContain('org_credits.delete.eq');
    expect(calls).not.toContain('organizations.delete.eq');
  });

  it('still fails on the anchors delete (pre-existing contract preserved)', async () => {
    const calls: string[] = [];
    const client = stubClient({ anchorsDeleteError: { message: 'update or delete violates FK' } }, calls);

    await expect(cleanupSyntheticOrg(client, ORG, ['a1'], 50))
      .rejects.toThrow(/anchors delete failed.*violates FK/);
    expect(calls).not.toContain('org_credits.delete.eq');
  });

  it('fails on an org_credits delete error instead of silently continuing', async () => {
    const calls: string[] = [];
    const client = stubClient({ creditsDeleteError: { message: 'transient timeout' } }, calls);

    await expect(cleanupSyntheticOrg(client, ORG, ['a1'], 50))
      .rejects.toThrow(/org_credits delete failed.*transient timeout/);
    expect(calls).not.toContain('organizations.delete.eq');
  });

  it('fails on an organizations delete error instead of silently continuing', async () => {
    const calls: string[] = [];
    const client = stubClient({ orgDeleteError: { message: 'row locked' } }, calls);

    await expect(cleanupSyntheticOrg(client, ORG, ['a1'], 50))
      .rejects.toThrow(/organizations delete failed.*row locked/);
    expect(calls.some((c) => c.includes('.count.'))).toBe(false);
  });

  it('fails when residual rows remain even though every delete reported success', async () => {
    const calls: string[] = [];
    // A delete can "succeed" while removing zero rows (e.g. a policy filtered
    // it) — the re-assert is what actually protects the rig (§1.11A).
    const client = stubClient({ counts: { organizations: 1, anchor_proofs: 2 } }, calls);

    await expect(cleanupSyntheticOrg(client, ORG, ['a1'], 50))
      .rejects.toThrow(/residual rows.*organizations=1/);
  });

  it('fails when a residual count query itself errors — a broken check never passes', async () => {
    const client = stubClient({ countError: { table: 'anchors', error: { message: 'timeout' } } }, []);

    await expect(cleanupSyntheticOrg(client, ORG, ['a1'], 50))
      .rejects.toThrow(/residual count for anchors failed.*timeout/);
  });

  it('fails when a residual count returns no count instead of assuming zero', async () => {
    const client = stubClient({ nullCountTable: 'org_credits' }, []);

    await expect(cleanupSyntheticOrg(client, ORG, ['a1'], 50))
      .rejects.toThrow(/residual count for org_credits returned no count/);
  });

  it('handles zero anchor ids: no proof deletes, org rows still removed and verified', async () => {
    const calls: string[] = [];
    const client = stubClient({}, calls);

    const result = await cleanupSyntheticOrg(client, ORG, [], 50);

    expect(result.removedAnchors).toBe(0);
    expect(calls.filter((c) => c.startsWith('anchor_proofs.delete'))).toEqual([]);
    expect(calls).toContain('anchors.delete.eq');
    expect(calls).toContain('org_credits.delete.eq');
    expect(calls).toContain('organizations.delete.eq');
    expect(calls).toContain('organizations.count.eq');
  });

  it('rejects a missing orgId and a non-positive chunk size', async () => {
    const client = stubClient({}, []);

    await expect(cleanupSyntheticOrg(client, '  ', ['a1'])).rejects.toThrow(/orgId/);
    await expect(cleanupSyntheticOrg(client, ORG, ['a1'], 0)).rejects.toThrow(/chunkSize/);
  });
});
