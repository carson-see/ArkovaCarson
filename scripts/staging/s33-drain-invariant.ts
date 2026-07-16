/**
 * Canonical S3.3 drain invariant adopted by the CTO in ruling R3.
 *
 * This is a data-only contract. It cannot invoke either worker endpoint and is
 * safe for Lane 1 evidence producers and Lane 2 topology checks to share.
 */

export const S33_DRAIN_CONTRACT_SCHEMA_VERSION = 1 as const;

export type S33DrainTrigger = 'org-scheduler' | 'global-flush';

export interface S33OrgSchedulerInvariant {
  readonly transactionsPerClaimedOrgPerPass: 1;
  readonly remainingPendingRule: 'ceil(pending/BATCH_SIZE)-across-passes';
  readonly crossOrgLeakageAllowed: false;
  readonly ledgerDeltaRequiredPerOrg: true;
}

export interface S33GlobalFlushInvariant {
  readonly transactionsPerPass: 1;
  readonly organizationMix: 'mixed-org';
  readonly maximumLeavesPerTransaction: 10_000;
  readonly remainingPendingRule: 'remainder-next-tick';
  readonly crossOrgLeakageAllowed: false;
  readonly ledgerDeltaRequiredPerOrg: true;
}

export interface S33DrainTriggerContracts {
  readonly 'org-scheduler': {
    readonly schedulerJobSuffix: 'org-queue-scheduler';
    readonly endpoint: {
      readonly method: 'POST';
      readonly path: '/jobs/org-queue-scheduler';
      readonly organizationSelector: 'claimed-by-scheduler';
    };
    readonly invariant: S33OrgSchedulerInvariant;
  };
  readonly 'global-flush': {
    readonly schedulerJobSuffix: 'batch-anchors-forced-flush';
    readonly endpoint: {
      readonly method: 'POST';
      readonly path: '/jobs/batch-anchors?force=true';
      readonly organizationSelector: 'forbidden';
    };
    readonly invariant: S33GlobalFlushInvariant;
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export const S33_CTO_R3_DRAIN_CONTRACT = deepFreeze({
  schemaVersion: S33_DRAIN_CONTRACT_SCHEMA_VERSION,
  invariantId: 'SCRUM-2795-CTO-R3' as const,
  owner: 'lane-2-platform' as const,
  coSigner: 'lane-1-chain' as const,
  triggers: {
    'org-scheduler': {
      schedulerJobSuffix: 'org-queue-scheduler' as const,
      endpoint: {
        method: 'POST' as const,
        path: '/jobs/org-queue-scheduler' as const,
        organizationSelector: 'claimed-by-scheduler' as const,
      },
      invariant: {
        transactionsPerClaimedOrgPerPass: 1 as const,
        remainingPendingRule: 'ceil(pending/BATCH_SIZE)-across-passes' as const,
        crossOrgLeakageAllowed: false as const,
        ledgerDeltaRequiredPerOrg: true as const,
      },
    },
    'global-flush': {
      schedulerJobSuffix: 'batch-anchors-forced-flush' as const,
      endpoint: {
        method: 'POST' as const,
        path: '/jobs/batch-anchors?force=true' as const,
        organizationSelector: 'forbidden' as const,
      },
      invariant: {
        transactionsPerPass: 1 as const,
        organizationMix: 'mixed-org' as const,
        maximumLeavesPerTransaction: 10_000 as const,
        remainingPendingRule: 'remainder-next-tick' as const,
        crossOrgLeakageAllowed: false as const,
        ledgerDeltaRequiredPerOrg: true as const,
      },
    },
  } satisfies S33DrainTriggerContracts,
  evidenceWindow: {
    exactlyOneArmedTrigger: true as const,
    armedTriggerDeclarationRequired: true as const,
    inProcessNodeCron: 'disabled-or-observed' as const,
  },
});

export function getS33DrainTriggerContract<T extends S33DrainTrigger>(
  trigger: T,
): S33DrainTriggerContracts[T] {
  return S33_CTO_R3_DRAIN_CONTRACT.triggers[trigger];
}
