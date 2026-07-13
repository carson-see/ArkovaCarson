import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_EVIDENCE_ENABLE_VALUE,
  SOAK_FLOOR_MINUTES,
  SOAK_REQUIRED_UPTIME_MINUTES,
  KnownSourceCollectorsAdapter,
  collectLiveRawSources,
  createProductionEvidenceEnvelopeVerifier,
  parseRawCaptureSet,
  type KnownLiveSourceCollectors,
} from './batch-drain-live-evidence';

describe('immutable declaration and independent raw evidence sources', () => {
  it('hardcodes the 48h floor and Soak v2 +30m requirement', () => {
    expect(SOAK_FLOOR_MINUTES).toBe(2_880);
    expect(SOAK_REQUIRED_UPTIME_MINUTES).toBe(2_880);
  });

  it('rejects live declaration verification until the CTO signing key is code-configured', () => {
    expect(() => createProductionEvidenceEnvelopeVerifier()).toThrow(/CTO.*not configured/i);
  });

  it('refuses raw-source parsing before a signed declaration is verified', () => {
    expect(() => parseRawCaptureSet({
      scheduler: JSON.stringify({ schemaVersion: 1, source: 'cloud-scheduler', records: [], invented: true }),
      workerLogs: '{}',
      database: '{}',
      signet: '{}',
      cloudRun: '{}',
      supervisor: '{}',
    }, {} as never)).toThrow(/verified signed.*envelope/i);
  });

  it('does not call any known live collector without both gates', async () => {
    const collectScheduler = vi.fn();
    const collectors = {
      collectScheduler,
      collectWorkerLogs: vi.fn(),
      collectDatabase: vi.fn(),
      collectSignet: vi.fn(),
      collectCloudRun: vi.fn(),
      collectSupervisor: vi.fn(),
    } as unknown as KnownLiveSourceCollectors;
    const result = await collectLiveRawSources({} as never, collectors, {});
    expect(result).toEqual({ mode: 'disabled', reason: 'live evidence collection was not explicitly enabled' });
    expect(collectScheduler).not.toHaveBeenCalled();

    const collect = vi.fn();
    const concrete = new KnownSourceCollectorsAdapter({ collect }, {});
    await expect(concrete.collectScheduler({ value: { soakId: 'soak-exact' } } as never)).rejects.toThrow(
      /not explicitly enabled/,
    );
    expect(collect).not.toHaveBeenCalled();
  });

  it('calls all six named collectors only after both exact gates match', async () => {
    const collectors = {
      collectScheduler: vi.fn(async () => 'scheduler'),
      collectWorkerLogs: vi.fn(async () => 'logs'),
      collectDatabase: vi.fn(async () => 'database'),
      collectSignet: vi.fn(async () => 'signet'),
      collectCloudRun: vi.fn(async () => 'cloud-run'),
      collectSupervisor: vi.fn(async () => 'supervisor'),
    };
    const declaration = { value: { soakId: 'soak-exact' } } as never;
    await expect(collectLiveRawSources(declaration, collectors, {
      ARKOVA_LIVE_EVIDENCE_EXECUTION: LIVE_EVIDENCE_ENABLE_VALUE,
      ARKOVA_LIVE_EVIDENCE_SOAK_ID: 'soak-exact',
    })).resolves.toEqual({
      mode: 'captured',
      raw: {
        scheduler: 'scheduler', workerLogs: 'logs', database: 'database', signet: 'signet',
        cloudRun: 'cloud-run', supervisor: 'supervisor',
      },
    });
    expect(Object.values(collectors).every((collector) => collector.mock.calls.length === 1)).toBe(true);
  });
});
