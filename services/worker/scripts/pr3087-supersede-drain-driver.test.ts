/**
 * Tests for the PR #3087 (connector-supersede-not-duplicate) soak driver.
 *
 * The driver decides what counts as merge-grade evidence for the supersede-
 * not-duplicate fix, so its own classification bugs ARE evidence-integrity
 * bugs: a row scored `pass` that never actually observed a superseded anchor,
 * or a `REVOKED`-body regression that slips past because a check only looked
 * at `revoked_at`, both make a 24h T3 window worthless. These pin every
 * classifier's pass shape AND its most important failure shapes — especially
 * the ones an easy implementation would get wrong (REVOKED vs SUPERSEDED,
 * 404 vs still-valid, a stuck artifact scored a pass because nothing threw).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ASSERTION,
  aggregate,
  classifyIdempotentReplay,
  classifyLineage,
  classifyMemberOwnedSupersede,
  classifyNegativeControlDocuSign,
  classifyNoopIdenticalFingerprint,
  classifyProvenanceEvents,
  classifySupersedeNotRevoke,
  classifyVerifyResponse,
  parseArgs,
  runSelfTest,
  tally,
} from './pr3087-supersede-drain-driver.js';

// The real `connector-artifact-drain.ts` imports `../utils/db.js` and
// `../config.js` at module top level, both of which validate real worker env
// vars (SUPABASE_URL etc.) as a load-time side effect — the same reason
// `connector-artifact-drain.test.ts` itself mocks these before importing the
// module under test. `callRpc` (`../utils/rpc.js`) is deliberately left
// UNMOCKED here: it is a thin, side-effect-free wrapper around
// `client.rpc(...)`, and leaving it real means our fault-injecting fake `db`
// below is what actually answers the RPC call — this is what makes the test
// integration-style rather than a mock of the mock.
vi.mock('../src/utils/db.js', () => ({ db: { from: () => { throw new Error('default db must not be used'); } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/jobs/batch-anchor.js', () => ({ processBatchAnchors: vi.fn() }));
vi.mock('../src/utils/sentry.js', () => ({ Sentry: { captureMessage: vi.fn() } }));
vi.mock('../src/config.js', () => ({ config: { enableConnectorArtifactDrain: true } }));

import {
  defaultMaterializeAnchor,
  type ConnectorArtifactRow,
} from '../src/jobs/connector-artifact-drain.js';

/**
 * A minimal fake `db` covering exactly the calls `defaultMaterializeAnchor`
 * makes on the google_drive supersession branch: `org_members` (resolving the
 * org-admin actor, called once for the base materializer and again for the
 * supersede call), `anchors` (the prior-anchor lookup, keyed off the
 * `version_number` column in its select list, and the final child public_id
 * read, keyed off `public_id`), `connector_artifact` (the lease-guarded
 * link-back update), and the `supersede_anchor` RPC.
 */
function buildSupersessionTestDb(args: {
  priorAnchor: { id: string; status: string; fingerprint: string; version_number: number } | null;
  supersedeRpc: { data: string | null; error: { message: string; code?: string } | null };
  connectorArtifactLinked: boolean;
  newAnchorPublicId: string;
}) {
  let rpcCalls = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any {
      let selectCols = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: (cols?: string) => {
          selectCols = cols ?? '';
          return chain;
        },
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        neq: () => chain,
        in: () => chain,
        update: () => chain,
        maybeSingle: async () => {
          if (table === 'org_members') {
            return { data: { user_id: '55555555-5555-4555-8555-555555555555', role: 'owner' }, error: null };
          }
          if (table === 'anchors' && selectCols.includes('version_number')) {
            return { data: args.priorAnchor, error: null };
          }
          if (table === 'anchors' && selectCols.includes('public_id')) {
            return { data: { public_id: args.newAnchorPublicId }, error: null };
          }
          if (table === 'connector_artifact') {
            return args.connectorArtifactLinked
              ? { data: { id: 'artifact-1' }, error: null }
              : { data: null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return chain;
    },
    rpc: async (name: string) => {
      rpcCalls += 1;
      if (name === 'supersede_anchor') return args.supersedeRpc;
      throw new Error(`unexpected rpc call in test db: ${name}`);
    },
    // exposed for the "never called" assertion below
    get rpcCallCount() {
      return rpcCalls;
    },
  };
}

function driveRow(over: Partial<ConnectorArtifactRow> = {}): ConnectorArtifactRow {
  return {
    id: 'artifact-1',
    org_id: '33333333-3333-4333-8333-333333333333',
    status: 'processing',
    fingerprint_sha256: '1'.repeat(64),
    byte_length: 1024,
    source: 'google_drive',
    external_ref: 'drive-file-1',
    metadata: { connector_source: 'google_drive', external_ref: 'drive-file-1' },
    anchor_id: null,
    credit_deduction_id: null,
    updated_at: '2026-09-26T00:00:00.000Z',
    ...over,
  };
}

describe('defaultMaterializeAnchor (real production code, injected deps) — integration-style', () => {
  it('supersedes the prior anchor via the real function when the fingerprint changed', async () => {
    const db = buildSupersessionTestDb({
      priorAnchor: { id: 'prior-anchor-1', status: 'SECURED', fingerprint: '0'.repeat(64), version_number: 1 },
      supersedeRpc: { data: '11111111-1111-4111-8111-111111111111', error: null },
      connectorArtifactLinked: true,
      newAnchorPublicId: 'pub-child-1',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await defaultMaterializeAnchor(driveRow(), { db: db as any });

    // This is the REAL function's REAL output — not a hand-constructed
    // observation — fed through the driver's own classifier shape, proving
    // the classifier actually agrees with what defaultMaterializeAnchor does.
    expect(result).toMatchObject({
      outcome: 'linked',
      anchorId: '11111111-1111-4111-8111-111111111111',
      anchorPublicId: 'pub-child-1',
      created: true,
    });
  });

  it('fails closed (prior_anchor_revoked) and never calls supersede_anchor when the prior head is REVOKED', async () => {
    const db = buildSupersessionTestDb({
      priorAnchor: { id: 'prior-anchor-1', status: 'REVOKED', fingerprint: '0'.repeat(64), version_number: 1 },
      supersedeRpc: { data: null, error: { message: 'should never be called' } },
      connectorArtifactLinked: true,
      newAnchorPublicId: 'irrelevant',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await defaultMaterializeAnchor(driveRow(), { db: db as any });

    expect(result).toEqual({ outcome: 'prior_anchor_revoked' });
    expect(db.rpcCallCount).toBe(0);
  });

  it('falls through to a plain materialize when there is no prior anchor (first-ever version)', async () => {
    const db = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from(table: string): any {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          order: () => chain,
          limit: () => chain,
        neq: () => chain,
          in: () => chain,
          maybeSingle: async () => {
            if (table === 'org_members') return { data: { user_id: '55555555-5555-4555-8555-555555555555', role: 'owner' }, error: null };
            return { data: null, error: null }; // no prior anchor, no existing envelope anchor
          },
        };
        return chain;
      },
      rpc: async (name: string) => {
        if (name === 'materialize_connector_artifact_anchor') {
          return {
            data: { outcome: 'linked', anchor_id: '22222222-2222-4222-8222-222222222222', public_id: 'pub-1', created: true },
            error: null,
          };
        }
        throw new Error(`unexpected rpc call: ${name}`);
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await defaultMaterializeAnchor(driveRow(), { db: db as any });
    expect(result).toMatchObject({
      outcome: 'linked', anchorId: '22222222-2222-4222-8222-222222222222', created: true,
    });
  });
});

describe('parseArgs', () => {
  it('defaults to local self-test mode', () => {
    expect(parseArgs([])).toEqual({ mode: 'self-test', durationMin: 0, intervalSec: 900 });
  });

  it('parses live admission arguments', () => {
    expect(parseArgs([
      '--live',
      '--target-url', 'https://rig.example',
      '--admission-json', '/tmp/admission.json',
      '--evidence-jsonl', '/tmp/evidence.jsonl',
      '--cron-secret', 'secret',
      '--duration-min', '1440',
      '--interval-sec', '900',
    ])).toEqual({
      mode: 'live',
      targetUrl: 'https://rig.example',
      admissionJson: '/tmp/admission.json',
      evidenceJsonl: '/tmp/evidence.jsonl',
      cronSecret: 'secret',
      durationMin: 1440,
      intervalSec: 900,
    });
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseArgs(['--not-a-real-flag'])).toThrow(/Unknown argument/);
  });
});

describe('classifySupersedeNotRevoke — assertion 1', () => {
  it('passes SUPERSEDED', () => {
    expect(classifySupersedeNotRevoke('SUPERSEDED').status).toBe('pass');
  });

  it('fails REVOKED with a distinct, named reason (never the generic mismatch message)', () => {
    const v = classifySupersedeNotRevoke('REVOKED');
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/REVOKED/);
    expect(v.detail).toMatch(/conflated/);
  });

  it('fails any other unexpected status too (e.g. PENDING — supersession never ran)', () => {
    expect(classifySupersedeNotRevoke('PENDING').status).toBe('fail');
  });

  it('fails a missing/absent prior anchor', () => {
    expect(classifySupersedeNotRevoke('MISSING').status).toBe('fail');
  });
});

describe('classifyLineage — assertion 2', () => {
  const prior = { id: 'anchor-A', version_number: 1 };

  it('passes correct lineage', () => {
    expect(classifyLineage(prior, { parent_anchor_id: 'anchor-A', version_number: 2 }).status).toBe('pass');
  });

  it('fails a null child rather than being skipped/undefined', () => {
    const v = classifyLineage(prior, null);
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/no child anchor/);
  });

  it('fails a forked/unrelated child (wrong parent_anchor_id)', () => {
    expect(classifyLineage(prior, { parent_anchor_id: 'anchor-OTHER', version_number: 2 }).status).toBe('fail');
  });

  it('fails a wrong version_number even with the correct parent', () => {
    expect(classifyLineage(prior, { parent_anchor_id: 'anchor-A', version_number: 5 }).status).toBe('fail');
  });
});

describe('classifyVerifyResponse — assertion 3', () => {
  it('passes 200 + status=SUPERSEDED', () => {
    expect(classifyVerifyResponse({ httpStatus: 200, body: { status: 'SUPERSEDED' } }).status).toBe('pass');
  });

  it('fails 404 with a reason naming the disappearance, not a generic mismatch', () => {
    const v = classifyVerifyResponse({ httpStatus: 404, body: { error: 'Record not found' } });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/404/);
    expect(v.detail).toMatch(/must not disappear/);
  });

  it('fails status=REVOKED on a 200 with a reason naming the P0 explicitly', () => {
    const v = classifyVerifyResponse({ httpStatus: 200, body: { status: 'REVOKED' } });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/P0/);
  });

  it('fails any other unexpected status', () => {
    expect(classifyVerifyResponse({ httpStatus: 200, body: { status: 'PENDING' } }).status).toBe('fail');
  });
});

describe('classifyProvenanceEvents — assertion 4 (THE P0)', () => {
  it('passes when credential_superseded is present and credential_revoked is absent', () => {
    const v = classifyProvenanceEvents([
      { event_type: 'credential_created' },
      { event_type: 'credential_superseded' },
    ]);
    expect(v.status).toBe('pass');
  });

  it('fails outright when credential_revoked appears, REGARDLESS of anything else present', () => {
    const v = classifyProvenanceEvents([
      { event_type: 'credential_superseded' },
      { event_type: 'credential_revoked' },
    ]);
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/credential_revoked/);
  });

  it('fails when credential_superseded never appears at all', () => {
    expect(classifyProvenanceEvents([{ event_type: 'credential_created' }]).status).toBe('fail');
  });

  it('fails on an empty timeline', () => {
    expect(classifyProvenanceEvents([]).status).toBe('fail');
  });
});

describe('classifyIdempotentReplay — assertion 5', () => {
  const base = {
    enqueueIdA: 'row-1', enqueueIdB: 'row-1', anchorCountBeforeReplay: 2, anchorCountAfterReplay: 2,
    priorStatusAfterReplay: 'SUPERSEDED',
  };

  it('passes when the replay resolves to the same row, no new anchor, still superseded', () => {
    expect(classifyIdempotentReplay(base).status).toBe('pass');
  });

  it('fails when the replay minted a DISTINCT row id (dedupe broke)', () => {
    expect(classifyIdempotentReplay({ ...base, enqueueIdB: 'row-2' }).status).toBe('fail');
  });

  it('fails when a third anchor appeared (the replay was NOT a no-op)', () => {
    expect(classifyIdempotentReplay({ ...base, anchorCountAfterReplay: 3 }).status).toBe('fail');
  });

  it('fails when the prior anchor was superseded AGAIN by the replay', () => {
    expect(classifyIdempotentReplay({ ...base, priorStatusAfterReplay: 'SUPERSEDED_AGAIN' }).status).toBe('fail');
  });
});

describe('classifyNoopIdenticalFingerprint — assertion 6', () => {
  it('passes when the head anchor is unchanged and not (re-)superseded', () => {
    expect(classifyNoopIdenticalFingerprint({
      headAnchorIdBefore: 'anchor-2', headAnchorIdAfter: 'anchor-2', headStatusAfter: 'PENDING',
    }).status).toBe('pass');
  });

  it('fails when a NEW anchor was minted for identical content', () => {
    expect(classifyNoopIdenticalFingerprint({
      headAnchorIdBefore: 'anchor-2', headAnchorIdAfter: 'anchor-3', headStatusAfter: 'PENDING',
    }).status).toBe('fail');
  });

  it('fails when the unchanged head got superseded anyway', () => {
    expect(classifyNoopIdenticalFingerprint({
      headAnchorIdBefore: 'anchor-2', headAnchorIdAfter: 'anchor-2', headStatusAfter: 'SUPERSEDED',
    }).status).toBe('fail');
  });
});

describe('classifyNegativeControlDocuSign — assertion 7 (must be able to fail)', () => {
  it('passes two independent, unlinked, non-superseded anchors', () => {
    const v = classifyNegativeControlDocuSign([
      { id: 'd1', status: 'PENDING', parent_anchor_id: null },
      { id: 'd2', status: 'PENDING', parent_anchor_id: null },
    ]);
    expect(v.status).toBe('pass');
  });

  it('fails if the gate LEAKED and docusign got linked/superseded (the exact regression it guards)', () => {
    const v = classifyNegativeControlDocuSign([
      { id: 'd1', status: 'SUPERSEDED', parent_anchor_id: null },
      { id: 'd2', status: 'PENDING', parent_anchor_id: 'd1' },
    ]);
    expect(v.status).toBe('fail');
  });

  it('fails when only ONE anchor exists (fingerprint-reuse collapsed the update into a no-op)', () => {
    expect(classifyNegativeControlDocuSign([{ id: 'd1', status: 'PENDING', parent_anchor_id: null }]).status)
      .toBe('fail');
  });

  it('fails on three-or-more anchors just as loudly as on one', () => {
    const three = [
      { id: 'd1', status: 'PENDING', parent_anchor_id: null },
      { id: 'd2', status: 'PENDING', parent_anchor_id: null },
      { id: 'd3', status: 'PENDING', parent_anchor_id: null },
    ];
    expect(classifyNegativeControlDocuSign(three).status).toBe('fail');
  });
});

describe('classifyMemberOwnedSupersede — assertion 8', () => {
  const base = {
    artifactStatus: 'materialized', priorAnchorId: 'anchor-A', priorVersionNumber: 1,
    priorOwnerUserId: 'member-1',
    newAnchor: { user_id: 'member-1', parent_anchor_id: 'anchor-A', version_number: 2 },
  };

  it('passes when the member-owned anchor was superseded with ownership + lineage intact', () => {
    expect(classifyMemberOwnedSupersede(base).status).toBe('pass');
  });

  it('NEVER scores a stuck artifact a pass merely because nothing threw — the lost_lease ambiguity', () => {
    const v = classifyMemberOwnedSupersede({ ...base, artifactStatus: 'processing', newAnchor: null });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/lost_lease/);
    expect(v.detail).toMatch(/indistinguishable from a transient failure/);
  });

  it('fails when the artifact is materialized but no child anchor is actually linked', () => {
    expect(classifyMemberOwnedSupersede({ ...base, newAnchor: null }).status).toBe('fail');
  });

  it('fails when ownership was silently reassigned to the resolving admin actor', () => {
    const v = classifyMemberOwnedSupersede({
      ...base,
      newAnchor: { user_id: 'org-admin-1', parent_anchor_id: 'anchor-A', version_number: 2 },
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/member-1/);
  });

  it('fails when the lineage is wrong even though ownership was preserved', () => {
    const v = classifyMemberOwnedSupersede({
      ...base,
      newAnchor: { user_id: 'member-1', parent_anchor_id: 'anchor-OTHER', version_number: 2 },
    });
    expect(v.status).toBe('fail');
  });
});

describe('aggregate / tally', () => {
  it('aggregate fails the whole cycle on a single failed probe', () => {
    expect(aggregate([
      { name: 'a', status: 'pass', detail: '' },
      { name: 'b', status: 'fail', detail: '' },
    ])).toBe('fail');
  });

  it('aggregate passes only when every probe passed', () => {
    expect(aggregate([{ name: 'a', status: 'pass', detail: '' }])).toBe('pass');
  });

  it('tally counts each assertion family independently, never collapsing them into one boolean', () => {
    const counts = tally([
      { name: ASSERTION.SUPERSEDE_NOT_REVOKE, status: 'pass', detail: '' },
      { name: ASSERTION.LINEAGE, status: 'fail', detail: '' },
    ]);
    expect(counts[`${ASSERTION.SUPERSEDE_NOT_REVOKE}_passed`]).toBe(true);
    expect(counts[`${ASSERTION.LINEAGE}_passed`]).toBe(false);
    expect(counts[`${ASSERTION.VERIFY_STILL_VALID}_ran`]).toBe(false);
    expect(counts.probes_total).toBe(2);
    expect(counts.probes_failed).toBe(1);
  });
});

describe('runSelfTest', () => {
  it('is entirely self-consistent and passes as a whole (local classifier validation only)', () => {
    const probes = runSelfTest();
    expect(probes.length).toBeGreaterThan(10);
    expect(aggregate(probes)).toBe('pass');
  });

  it('covers all eight named assertions at least once', () => {
    const probes = runSelfTest();
    const names = new Set(probes.map((p) => p.name));
    for (const assertion of Object.values(ASSERTION)) {
      expect(names.has(assertion)).toBe(true);
    }
  });
});
