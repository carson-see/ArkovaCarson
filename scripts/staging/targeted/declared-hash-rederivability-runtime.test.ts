import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRederivabilityDriver, DECLARED_PUBLIC_ID, MEASURED_PUBLIC_ID } from './declared-hash-rederivability-driver';

const mocks = vi.hoisted(() => ({ write: vi.fn(), auth: vi.fn(() => ({})) }));
vi.mock('./runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('./runtime')>(),
  iamAuthHeaders: mocks.auth,
  writeEvidenceFile: mocks.write,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.write.mockClear();
  mocks.auth.mockReset().mockReturnValue({});
});

describe('driver completion status', () => {
  it.each(['clean', 'proof-404', 'false-claim', 'auth-error', 'dry-run'])(
    'preserves the actual %s verdict through the real run loop and evidence writer', async (scenario) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(process, 'argv', 'get').mockReturnValue([
        'node', 'driver', '--duration', '1', ...(scenario === 'dry-run' ? ['--dry-run'] : []),
      ]);
      vi.stubEnv('STAGING_API_BASE', 'https://pr-2499---arkova-worker-test.run.app');
      if (scenario === 'auth-error') mocks.auth.mockImplementation(() => { throw new Error('test auth failure'); });
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const measured = url.includes(MEASURED_PUBLIC_ID);
        const status = scenario === 'proof-404' && url.endsWith('/proof') ? 404 : 200;
        const body = status === 404 ? { error: 'NO_BATCH_PROOF' } : {
          public_id: measured ? MEASURED_PUBLIC_ID : DECLARED_PUBLIC_ID,
          ...(measured || scenario === 'false-claim' ? { fingerprint_rederivability: 'fetch_time_snapshot', fingerprint_rederivability_note: 'Measured: exact fetched bytes.' } : {}),
        };
        return new Response(JSON.stringify(body), { status });
      }));
      const outcome = runRederivabilityDriver().then(() => 'passed', () => 'failed');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toBe(['clean', 'dry-run'].includes(scenario) ? 'passed' : 'failed');
      if (scenario === 'dry-run') {
        expect(mocks.write).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(mocks.write).toHaveBeenCalledOnce();
        expect(mocks.write.mock.calls[0][1].allExpected).toBe(scenario === 'clean');
        if (['false-claim', 'auth-error'].includes(scenario)) {
          expect(mocks.write.mock.calls[0][1].deviations.length).toBeGreaterThan(0);
        }
      }
    },
  );
});
