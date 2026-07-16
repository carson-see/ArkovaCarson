import { describe, expect, it } from 'vitest';

import {
  FaultDisarmAggregateError,
  orchestrateFaultCase,
  type FaultCaseInput,
  type FaultControlPort,
  type FaultObservation,
  type FaultScenario,
} from './batch-drain-fault-control';
import type { TxidJournalSnapshot } from './batch-drain-journal-crash';

const HEAD_SHA = '1'.repeat(40);
const IMAGE_DIGEST = `sha256:${'2'.repeat(64)}`;
const TX_ID = '3'.repeat(64);
const FOREIGN_TX_ID = '9'.repeat(64);
const ROOT = '4'.repeat(64);
const PRIOR_BLOCK = '5'.repeat(64);
const REORG_BLOCK = '6'.repeat(64);
const ANCHORS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
];

function journal(status: TxidJournalSnapshot['recoveryStatus']): TxidJournalSnapshot {
  const terminal = ['ADOPTED', 'REVERTED', 'PERSISTED'].includes(status);
  return {
    journalId: '30000000-0000-4000-8000-000000000001',
    batchId: 'batch-fault',
    txId: TX_ID,
    fingerprintRoot: ROOT,
    anchorIds: ANCHORS,
    createdAt: '2026-07-15T13:00:01.000Z',
    recoveryStatus: status,
    holdReason: status === 'HELD' ? 'chain_client_unavailable' : null,
    heldAt: status === 'HELD' ? '2026-07-15T13:00:03.000Z' : null,
    resolvedAt: terminal ? '2026-07-15T13:00:05.000Z' : null,
    observedAt: '2026-07-15T13:00:06.000Z',
  };
}

function providerRecoveredJournal(): TxidJournalSnapshot {
  return {
    ...journal('ADOPTED'),
    resolvedAt: '2026-07-15T13:00:07.250Z',
    observedAt: '2026-07-15T13:00:07.500Z',
  };
}

function input(scenario: FaultScenario): FaultCaseInput {
  return {
    schemaVersion: 1,
    runId: `fault-${scenario}`,
    scenario,
    batchId: 'batch-fault',
    schedulerExecutionId: 'scheduler-fault',
    faultWindow: {
      id: 'fault-window',
      startsAt: '2026-07-15T13:00:00.000Z',
      endsAt: '2026-07-15T13:10:00.000Z',
    },
    runtime: { headSha: HEAD_SHA, imageDigest: IMAGE_DIGEST },
    anchorIds: ANCHORS,
    txId: scenario === 'fee-ceiling' ? null : TX_ID,
    fingerprintRoot: scenario === 'fee-ceiling' ? null : ROOT,
    retryLimit: scenario === 'provider-outage' ? 3 : 0,
  };
}

function anchors(status: 'PENDING' | 'BROADCASTING' | 'SUBMITTED' | 'SECURED', chainTxId: string | null) {
  return ANCHORS.map((anchorId) => ({ anchorId, status, chainTxId }));
}

function duringFault(scenario: FaultScenario): FaultObservation {
  const common = {
    schemaVersion: 1 as const,
    runId: `fault-${scenario}`,
    scenario,
    phase: 'fault-active' as const,
    batchId: 'batch-fault',
    schedulerExecutionId: 'scheduler-fault',
    faultWindowId: 'fault-window',
    runtime: { headSha: HEAD_SHA, imageDigest: IMAGE_DIGEST },
    observedAt: '2026-07-15T13:00:06.000Z',
    networkTxIds: [] as string[],
    broadcastAttempts: 0,
    refundAnchorIds: [] as string[],
  };
  if (scenario === 'fee-ceiling') {
    return {
      ...common,
      journal: null,
      anchors: anchors('PENDING', null),
      fee: {
        estimateSatVb: 51,
        ceilingSatVb: 50,
        baseCeilingSatVb: 50,
        oldestPendingAt: '2026-07-15T12:50:00.000Z',
        evaluatedBeforeClaim: true,
      },
      provider: null,
      reorg: null,
    };
  }
  if (scenario === 'provider-outage') {
    return {
      ...common,
      journal: journal('HELD'),
      anchors: anchors('BROADCASTING', TX_ID),
      broadcastAttempts: 1,
      fee: null,
      provider: {
        retryAttempts: 3,
        lookups: [
          { source: 'bitcoin-core-signet-rpc', outcome: 'not-found', txId: TX_ID, confirmations: null, observedAt: '2026-07-15T13:00:02.000Z' },
          { source: 'mempool-space', outcome: 'unavailable', txId: TX_ID, confirmations: null, observedAt: '2026-07-15T13:00:03.000Z' },
        ],
      },
      reorg: null,
    };
  }
  return {
    ...common,
    journal: journal('PERSISTED'),
    anchors: anchors('SECURED', TX_ID),
    networkTxIds: [TX_ID],
    broadcastAttempts: 1,
    fee: null,
    provider: null,
    reorg: {
      priorBlockHash: PRIOR_BLOCK,
      observedBlockHash: REORG_BLOCK,
      proofStatus: 'stale',
      auditEvent: 'anchor.reorg_reverted',
    },
  };
}

function recovered(scenario: FaultScenario): FaultObservation {
  const value = duringFault(scenario);
  value.phase = 'fault-cleared';
  value.observedAt = '2026-07-15T13:00:08.000Z';
  if (scenario === 'fee-ceiling') {
    value.journal = journal('PERSISTED');
    value.anchors = anchors('SUBMITTED', TX_ID);
    value.networkTxIds = [TX_ID];
    value.broadcastAttempts = 1;
    value.fee = {
      estimateSatVb: 49,
      ceilingSatVb: 50,
      baseCeilingSatVb: 50,
      oldestPendingAt: '2026-07-15T12:50:00.000Z',
      evaluatedBeforeClaim: true,
    };
  } else if (scenario === 'provider-outage') {
    value.journal = providerRecoveredJournal();
    value.anchors = anchors('SUBMITTED', TX_ID);
    value.networkTxIds = [TX_ID];
    value.provider = {
      retryAttempts: 3,
      lookups: [{ source: 'bitcoin-core-signet-rpc', outcome: 'found', txId: TX_ID, confirmations: 0, observedAt: '2026-07-15T13:00:07.000Z' }],
    };
  } else {
    value.journal = journal('PERSISTED');
    value.anchors = anchors('SUBMITTED', TX_ID);
  }
  return value;
}

function port(scenario: FaultScenario, overrides: {
  active?: FaultObservation;
  cleared?: FaultObservation;
  armError?: Error;
  disarmError?: Error;
} = {}): { port: FaultControlPort; events: string[] } {
  const events: string[] = [];
  return {
    events,
    port: {
      evidenceMode: 'offline-replay',
      async arm(value) { events.push(`arm:${value.runId}`); if (overrides.armError) throw overrides.armError; },
      async start(value) { events.push(`start:${value.scenario}`); },
      async waitForFault(value) { events.push(`fault:${value.scenario}`); return overrides.active ?? duringFault(scenario); },
      async clear(value) { events.push(`clear:${value.scenario}`); },
      async inspect(value) { events.push(`inspect:${value.scenario}`); return overrides.cleared ?? recovered(scenario); },
      async disarm(value) { events.push(`disarm:${value.runId}`); if (overrides.disarmError) throw overrides.disarmError; },
    },
  };
}

describe('orchestrateFaultCase — SCRUM-2693 fault contracts', () => {
  it.each([
    ['fee-ceiling', 'FEE_DEFERRED_THEN_RECOVERED'],
    ['provider-outage', 'PROVIDER_HELD_THEN_ADOPTED'],
    ['reorg', 'REORG_REVERTED_TO_SUBMITTED'],
  ] as const)('accepts a correlated %s contract and derives %s', async (scenario, resolution) => {
    const { port: adapter, events } = port(scenario);
    await expect(orchestrateFaultCase(input(scenario), adapter)).resolves.toMatchObject({
      scenario,
      resolution,
      verdict: 'pass',
      exactHeadSha: HEAD_SHA,
      exactImageDigest: IMAGE_DIGEST,
    });
    expect(events.at(-1)).toBe(`disarm:fault-${scenario}`);
  });

  it('fee ceiling defers before claim/journal/broadcast and later recovers below the observed ceiling', async () => {
    const bad = duringFault('fee-ceiling');
    bad.fee!.evaluatedBeforeClaim = false;
    await expect(orchestrateFaultCase(input('fee-ceiling'), port('fee-ceiling', { active: bad }).port))
      .rejects.toThrow(/before claim/i);

    const journaled = duringFault('fee-ceiling');
    journaled.journal = journal('PENDING');
    await expect(orchestrateFaultCase(input('fee-ceiling'), port('fee-ceiling', { active: journaled }).port))
      .rejects.toThrow(/defer.*journal|journal.*defer/i);

    const notRecovered = recovered('fee-ceiling');
    notRecovered.fee!.estimateSatVb = 51;
    await expect(orchestrateFaultCase(input('fee-ceiling'), port('fee-ceiling', { cleared: notRecovered }).port))
      .rejects.toThrow(/recover.*ceiling|below.*ceiling/i);

    const wrongConfiguredBase = duringFault('fee-ceiling');
    wrongConfiguredBase.fee = {
      ...wrongConfiguredBase.fee!, estimateSatVb: 50, ceilingSatVb: 49, baseCeilingSatVb: 49,
    };
    const wrongBaseRecovery = recovered('fee-ceiling');
    wrongBaseRecovery.fee = {
      ...wrongBaseRecovery.fee!, estimateSatVb: 48, ceilingSatVb: 49, baseCeilingSatVb: 49,
    };
    await expect(orchestrateFaultCase(
      input('fee-ceiling'),
      port('fee-ceiling', { active: wrongConfiguredBase, cleared: wrongBaseRecovery }).port,
    )).rejects.toThrow(/50 sat\/vB|configured.*ceiling/i);
  });

  it('binds fee recovery network evidence to the exact persisted journal transaction', async () => {
    const foreignNetworkTransaction = recovered('fee-ceiling');
    foreignNetworkTransaction.networkTxIds = [FOREIGN_TX_ID];

    await expect(orchestrateFaultCase(
      input('fee-ceiling'),
      port('fee-ceiling', { cleared: foreignNetworkTransaction }).port,
    )).rejects.toThrow(/network.*journal|exact.*transaction|txid/i);
  });

  it('accepts the aged-backlog dynamic ceiling only when its exact age-derived value is observed', async () => {
    const active = duringFault('fee-ceiling');
    active.fee = {
      estimateSatVb: 101,
      ceilingSatVb: 100,
      baseCeilingSatVb: 50,
      oldestPendingAt: '2026-07-15T12:29:59.000Z',
      evaluatedBeforeClaim: true,
    };
    const cleared = recovered('fee-ceiling');
    cleared.fee = { ...active.fee, estimateSatVb: 100 };
    await expect(orchestrateFaultCase(input('fee-ceiling'), port('fee-ceiling', { active, cleared }).port))
      .resolves.toMatchObject({ observedCeilingSatVb: 100 });

    active.fee.ceilingSatVb = 99;
    await expect(orchestrateFaultCase(input('fee-ceiling'), port('fee-ceiling', { active, cleared }).port))
      .rejects.toThrow(/dynamic ceiling/i);
  });

  it('provider outage/disagreement HOLDs, bounds retries, and never reverts, refunds, secures, or rebroadcasts', async () => {
    const reverted = duringFault('provider-outage');
    reverted.journal = journal('REVERTED');
    await expect(orchestrateFaultCase(input('provider-outage'), port('provider-outage', { active: reverted }).port))
      .rejects.toThrow(/HELD/i);

    const tooMany = duringFault('provider-outage');
    tooMany.provider!.retryAttempts = 4;
    await expect(orchestrateFaultCase(input('provider-outage'), port('provider-outage', { active: tooMany }).port))
      .rejects.toThrow(/retry.*limit/i);

    const rebroadcast = recovered('provider-outage');
    rebroadcast.broadcastAttempts = 2;
    await expect(orchestrateFaultCase(input('provider-outage'), port('provider-outage', { cleared: rebroadcast }).port))
      .rejects.toThrow(/rebroadcast/i);

    const falseSecured = duringFault('provider-outage');
    falseSecured.anchors[0]!.status = 'SECURED';
    await expect(orchestrateFaultCase(input('provider-outage'), port('provider-outage', { active: falseSecured }).port))
      .rejects.toThrow(/false SECURED|SECURED/i);

    const duplicateObserver = duringFault('provider-outage');
    duplicateObserver.provider!.lookups[1]!.source = 'bitcoin-core-signet-rpc';
    await expect(orchestrateFaultCase(
      input('provider-outage'),
      port('provider-outage', { active: duplicateObserver }).port,
    )).rejects.toThrow(/both distinct Signet observers/i);
  });

  it('binds provider recovery to the same journal row and exact transaction across every lookup', async () => {
    const differentJournal = recovered('provider-outage');
    differentJournal.journal!.journalId = '30000000-0000-4000-8000-000000000002';
    await expect(orchestrateFaultCase(
      input('provider-outage'),
      port('provider-outage', { cleared: differentJournal }).port,
    )).rejects.toThrow(/same journal|journal.*row|journal.*identity/i);

    const foreignActiveLookup = duringFault('provider-outage');
    foreignActiveLookup.provider!.lookups[1]!.txId = FOREIGN_TX_ID;
    await expect(orchestrateFaultCase(
      input('provider-outage'),
      port('provider-outage', { active: foreignActiveLookup }).port,
    )).rejects.toThrow(/lookup.*exact.*tx|lookup.*declared.*tx|foreign.*lookup/i);

    const foreignClearedLookup = recovered('provider-outage');
    foreignClearedLookup.provider!.lookups.push({
      source: 'mempool-space',
      outcome: 'unavailable',
      txId: FOREIGN_TX_ID,
      confirmations: null,
      observedAt: '2026-07-15T13:00:07.500Z',
    });
    await expect(orchestrateFaultCase(
      input('provider-outage'),
      port('provider-outage', { cleared: foreignClearedLookup }).port,
    )).rejects.toThrow(/lookup.*exact.*tx|lookup.*declared.*tx|foreign.*lookup/i);
  });

  it('causally orders the HELD observation, exact-tx recovery lookup, resolution, and cleared observations', async () => {
    const resolvedBeforeHeldObservation = recovered('provider-outage');
    resolvedBeforeHeldObservation.journal!.resolvedAt = '2026-07-15T13:00:05.999Z';
    await expect(orchestrateFaultCase(
      input('provider-outage'),
      port('provider-outage', { cleared: resolvedBeforeHeldObservation }).port,
    )).rejects.toThrow(/provider recovery chronology|HELD observation|resolution/i);

    const resolvedBeforeAffirmativeLookup = recovered('provider-outage');
    resolvedBeforeAffirmativeLookup.journal!.resolvedAt = '2026-07-15T13:00:06.500Z';
    await expect(orchestrateFaultCase(
      input('provider-outage'),
      port('provider-outage', { cleared: resolvedBeforeAffirmativeLookup }).port,
    )).rejects.toThrow(/provider recovery chronology|affirmative lookup|resolution/i);
  });

  it('reorg requires a pinned block conflict, stale proof, audit event, and SECURED to SUBMITTED retraction', async () => {
    const sameBlock = duringFault('reorg');
    sameBlock.reorg!.observedBlockHash = PRIOR_BLOCK;
    await expect(orchestrateFaultCase(input('reorg'), port('reorg', { active: sameBlock }).port))
      .rejects.toThrow(/block.*conflict|reorg/i);

    const stillSecured = recovered('reorg');
    stillSecured.anchors[0]!.status = 'SECURED';
    await expect(orchestrateFaultCase(input('reorg'), port('reorg', { cleared: stillSecured }).port))
      .rejects.toThrow(/SUBMITTED|false SECURED/i);

    const rebroadcast = recovered('reorg');
    rebroadcast.broadcastAttempts = 2;
    await expect(orchestrateFaultCase(input('reorg'), port('reorg', { cleared: rebroadcast }).port))
      .rejects.toThrow(/rebroadcast/i);
  });

  it('represents the normal PERSISTED reorg path while preserving immutable ADOPTED recovery evidence', async () => {
    await expect(orchestrateFaultCase(input('reorg'), port('reorg').port)).resolves.toMatchObject({
      resolution: 'REORG_REVERTED_TO_SUBMITTED',
    });

    const adoptedActive = duringFault('reorg');
    adoptedActive.journal = journal('ADOPTED');
    const adoptedCleared = recovered('reorg');
    adoptedCleared.journal = journal('ADOPTED');
    await expect(orchestrateFaultCase(
      input('reorg'),
      port('reorg', { active: adoptedActive, cleared: adoptedCleared }).port,
    )).resolves.toMatchObject({ resolution: 'REORG_REVERTED_TO_SUBMITTED' });

    const mutatedResolution = recovered('reorg');
    mutatedResolution.journal!.resolvedAt = '2026-07-15T13:00:04.000Z';
    await expect(orchestrateFaultCase(
      input('reorg'),
      port('reorg', { cleared: mutatedResolution }).port,
    )).rejects.toThrow(/journal.*mutat|same.*journal|immutable/i);

    const contradictoryTerminalState = recovered('reorg');
    contradictoryTerminalState.journal = journal('ADOPTED');
    await expect(orchestrateFaultCase(
      input('reorg'),
      port('reorg', { cleared: contradictoryTerminalState }).port,
    )).rejects.toThrow(/journal.*mutat|terminal.*state|same.*journal/i);
  });

  it('rejects cross-run runtime/identity and impossible fault chronology', async () => {
    const wrongHead = duringFault('provider-outage');
    wrongHead.runtime.headSha = 'f'.repeat(40);
    await expect(orchestrateFaultCase(input('provider-outage'), port('provider-outage', { active: wrongHead }).port))
      .rejects.toThrow(/exact tested head/i);

    const backwards = recovered('provider-outage');
    backwards.observedAt = '2026-07-15T12:59:59.000Z';
    await expect(orchestrateFaultCase(input('provider-outage'), port('provider-outage', { cleared: backwards }).port))
      .rejects.toThrow(/chronology|fault window/i);

    const futureHold = duringFault('provider-outage');
    futureHold.journal!.heldAt = '2026-07-15T13:00:07.000Z';
    await expect(orchestrateFaultCase(input('provider-outage'), port('provider-outage', { active: futureHold }).port))
      .rejects.toThrow(/journal.*chronology|heldAt/i);

    const futureResolution = recovered('provider-outage');
    futureResolution.journal!.resolvedAt = '2026-07-15T13:00:09.000Z';
    await expect(orchestrateFaultCase(
      input('provider-outage'),
      port('provider-outage', { cleared: futureResolution }).port,
    )).rejects.toThrow(/journal.*chronology|resolvedAt|resolution/i);
  });

  it('preserves both an action failure and a disarm failure', async () => {
    const { port: adapter } = port('fee-ceiling', {
      armError: new Error('arm failed after side effect'),
      disarmError: new Error('disarm failed'),
    });
    await expect(orchestrateFaultCase(input('fee-ceiling'), adapter)).rejects.toBeInstanceOf(FaultDisarmAggregateError);
  });

  it('snapshots and freezes the exact case before yielding to any controller action', async () => {
    const { port: adapter } = port('fee-ceiling');
    const originalArm = adapter.arm;
    adapter.arm = async (captured) => {
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.runtime)).toBe(true);
      expect(Object.isFrozen(captured.faultWindow)).toBe(true);
      expect(Object.isFrozen(captured.anchorIds)).toBe(true);
      expect(() => { captured.runId = 'controller-mutated'; }).toThrow(TypeError);
      await originalArm(captured);
    };
    await expect(orchestrateFaultCase(input('fee-ceiling'), adapter)).resolves.toMatchObject({ verdict: 'pass' });
  });
});
