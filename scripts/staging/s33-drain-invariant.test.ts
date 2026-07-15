import { describe, expect, it } from 'vitest';

import {
  S33_CTO_R3_DRAIN_CONTRACT,
  S33_DRAIN_CONTRACT_SCHEMA_VERSION,
  getS33DrainTriggerContract,
} from './s33-drain-invariant';

describe('S3.3 CTO R3 canonical drain invariant', () => {
  it('has one frozen Lane 2-owned, Lane 1-co-signed versioned source', () => {
    expect(S33_DRAIN_CONTRACT_SCHEMA_VERSION).toBe(1);
    expect(S33_CTO_R3_DRAIN_CONTRACT).toMatchObject({
      schemaVersion: 1,
      invariantId: 'SCRUM-2795-CTO-R3',
      owner: 'lane-2-platform',
      coSigner: 'lane-1-chain',
    });
    expect(Object.isFrozen(S33_CTO_R3_DRAIN_CONTRACT)).toBe(true);
    expect(Object.isFrozen(S33_CTO_R3_DRAIN_CONTRACT.triggers)).toBe(true);
    expect(Object.isFrozen(S33_CTO_R3_DRAIN_CONTRACT.triggers['org-scheduler'])).toBe(true);
    expect(Object.isFrozen(S33_CTO_R3_DRAIN_CONTRACT.triggers['global-flush'])).toBe(true);
  });

  it('pins both and only both trigger identities and exact worker endpoints', () => {
    expect(Object.keys(S33_CTO_R3_DRAIN_CONTRACT.triggers).sort()).toEqual([
      'global-flush',
      'org-scheduler',
    ]);
    expect(getS33DrainTriggerContract('org-scheduler')).toMatchObject({
      schedulerJobSuffix: 'org-queue-scheduler',
      endpoint: {
        method: 'POST',
        path: '/jobs/org-queue-scheduler',
        organizationSelector: 'claimed-by-scheduler',
      },
    });
    expect(getS33DrainTriggerContract('global-flush')).toMatchObject({
      schedulerJobSuffix: 'batch-anchors-forced-flush',
      endpoint: {
        method: 'POST',
        path: '/jobs/batch-anchors?force=true',
        organizationSelector: 'forbidden',
      },
    });
  });

  it('encodes the binding per-trigger pair without weakening either side', () => {
    expect(getS33DrainTriggerContract('org-scheduler').invariant).toEqual({
      transactionsPerClaimedOrgPerPass: 1,
      remainingPendingRule: 'ceil(pending/BATCH_SIZE)-across-passes',
      crossOrgLeakageAllowed: false,
      ledgerDeltaRequiredPerOrg: true,
    });
    expect(getS33DrainTriggerContract('global-flush').invariant).toEqual({
      transactionsPerPass: 1,
      organizationMix: 'mixed-org',
      maximumLeavesPerTransaction: 10_000,
      remainingPendingRule: 'remainder-next-tick',
      crossOrgLeakageAllowed: false,
      ledgerDeltaRequiredPerOrg: true,
    });
    expect(S33_CTO_R3_DRAIN_CONTRACT.evidenceWindow).toEqual({
      exactlyOneArmedTrigger: true,
      armedTriggerDeclarationRequired: true,
      inProcessNodeCron: 'disabled-or-observed',
    });
  });
});
