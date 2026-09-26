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
import { describe, expect, it } from 'vitest';

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
