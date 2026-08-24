/**
 * FeatureFlagRegistry — live refresh contract (DI-736 / SCRUM-3475)
 *
 * Pre-fix, `flagRegistry` was a BOOT-TIME snapshot: `init()` read the
 * switchboard once and `refreshDbFlag()` had zero callers, so flipping
 * `ENABLE_BATCH_ANCHORING` (the nightly 3am drain kill switch) or
 * `ENABLE_EXPIRY_ALERTS` in `switchboard_flags` did nothing until the worker
 * restarted. These tests pin the TTL-refresh contract and, critically, its
 * FAIL DIRECTION — a transient DB blip must never flip a kill switch, and the
 * env var is never a re-open path for a row that was read as false.
 *
 * Separate file from `flagRegistry.test.ts` because the boot-snapshot suite
 * there mocks a fixed `.select().in()` response; the refresh path needs a
 * mutable switchboard plus the `.select().eq().single()` shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  /** Simulated `switchboard_flags` rows: flag_key -> enabled. */
  rows: new Map<string, boolean>(),
  /** Force the boot-time `.in()` load to error (DB down at startup). */
  initFails: false,
  /** Force the per-flag `.single()` refresh to error (transient blip). */
  readFails: false,
  /** Force the per-flag `.single()` refresh to THROW (client-level failure). */
  readThrows: false,
  /** How many per-flag refresh reads the registry issued. */
  singleCalls: 0,
}));

vi.mock('../config.js', () => ({
  config: {
    useMocks: true,
    enableProdNetworkAnchoring: false,
  },
}));

vi.mock('../utils/db.js', () => ({
  db: {
    from: () => ({
      select: () => ({
        // init(): select('flag_key, enabled').in('flag_key', DB_FLAGS)
        in: (_col: string, keys: string[]) => {
          if (state.initFails) {
            return Promise.resolve({ data: null, error: { message: 'switchboard unreachable' } });
          }
          return Promise.resolve({
            data: keys
              .filter((k) => state.rows.has(k))
              .map((k) => ({ flag_key: k, enabled: state.rows.get(k) })),
            error: null,
          });
        },
        // refreshDbFlag(): select('enabled').eq('flag_key', name).single()
        eq: (_col: string, key: string) => ({
          single: () => {
            state.singleCalls += 1;
            if (state.readThrows) {
              throw new Error('supabase client blew up');
            }
            if (state.readFails) {
              return Promise.resolve({ data: null, error: { message: 'transient read failure' } });
            }
            if (!state.rows.has(key)) {
              return Promise.resolve({ data: null, error: { code: 'PGRST116' } });
            }
            return Promise.resolve({ data: { enabled: state.rows.get(key) }, error: null });
          },
        }),
      }),
    }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { flagRegistry } from './flagRegistry.js';

const ENV_KEYS = ['ENABLE_BATCH_ANCHORING', 'ENABLE_EXPIRY_ALERTS'] as const;

describe('FeatureFlagRegistry — live refresh (DI-736 / SCRUM-3475)', () => {
  beforeEach(() => {
    flagRegistry._reset();
    state.rows.clear();
    state.initFails = false;
    state.readFails = false;
    state.readThrows = false;
    state.singleCalls = 0;
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('observes a switchboard flip without a worker restart', async () => {
    state.rows.set('ENABLE_BATCH_ANCHORING', true);
    await flagRegistry.init();
    expect(flagRegistry.getFlag('ENABLE_BATCH_ANCHORING')).toBe(true);

    // Operator flips the kill switch OFF in switchboard_flags.
    state.rows.set('ENABLE_BATCH_ANCHORING', false);

    // The boot snapshot is deliberately still stale — that is what getFlag is.
    expect(flagRegistry.getFlag('ENABLE_BATCH_ANCHORING')).toBe(true);

    flagRegistry._expireLiveCache();
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(false);
    // The refreshed value becomes the snapshot too, so diagnostics stop lying.
    expect(flagRegistry.getFlag('ENABLE_BATCH_ANCHORING')).toBe(false);
    expect(flagRegistry.getAllFlags().ENABLE_BATCH_ANCHORING.source).toBe('db');
  });

  it('serves from the TTL cache inside the refresh window (no per-call DB read)', async () => {
    state.rows.set('ENABLE_EXPIRY_ALERTS', true);
    await flagRegistry.init();

    await expect(flagRegistry.getFlagLive('ENABLE_EXPIRY_ALERTS')).resolves.toBe(true);
    await expect(flagRegistry.getFlagLive('ENABLE_EXPIRY_ALERTS')).resolves.toBe(true);

    // init() just populated the value; nothing is stale yet.
    expect(state.singleCalls).toBe(0);
  });

  it('re-reads at most once per expired window', async () => {
    state.rows.set('ENABLE_EXPIRY_ALERTS', true);
    await flagRegistry.init();

    flagRegistry._expireLiveCache();
    await flagRegistry.getFlagLive('ENABLE_EXPIRY_ALERTS');
    await flagRegistry.getFlagLive('ENABLE_EXPIRY_ALERTS');

    expect(state.singleCalls).toBe(1);
  });

  it('holds the last-known-good DB value through a transient read failure', async () => {
    state.rows.set('ENABLE_BATCH_ANCHORING', true);
    await flagRegistry.init();

    flagRegistry._expireLiveCache();
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(true);

    state.readFails = true;
    flagRegistry._expireLiveCache();
    // A Supabase blip must not halt the nightly drain.
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(true);
  });

  it('never re-opens a killed flag from the env var on a DB read failure', async () => {
    // Cloud Run env says ON, the switchboard kill switch says OFF.
    process.env.ENABLE_BATCH_ANCHORING = 'true';
    state.rows.set('ENABLE_BATCH_ANCHORING', false);
    await flagRegistry.init();

    flagRegistry._expireLiveCache();
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(false);

    state.readFails = true;
    flagRegistry._expireLiveCache();
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(false);
  });

  it('falls back to the boot snapshot when the DB fails before any live read', async () => {
    state.rows.set('ENABLE_EXPIRY_ALERTS', true);
    await flagRegistry.init();

    state.readFails = true;
    flagRegistry._expireLiveCache();
    await expect(flagRegistry.getFlagLive('ENABLE_EXPIRY_ALERTS')).resolves.toBe(true);
  });

  it('recovers the real DB value after a boot-time env fallback', async () => {
    state.initFails = true;
    process.env.ENABLE_EXPIRY_ALERTS = 'true';
    await flagRegistry.init();
    expect(flagRegistry.getAllFlags().ENABLE_EXPIRY_ALERTS.source).toBe('env');

    state.initFails = false;
    state.rows.set('ENABLE_EXPIRY_ALERTS', false);
    flagRegistry._expireLiveCache();

    await expect(flagRegistry.getFlagLive('ENABLE_EXPIRY_ALERTS')).resolves.toBe(false);
    expect(flagRegistry.getAllFlags().ENABLE_EXPIRY_ALERTS.source).toBe('db');
  });

  it('resolves env-backed flags from the snapshot without touching the DB', async () => {
    await flagRegistry.init();
    flagRegistry._expireLiveCache();

    await expect(flagRegistry.getFlagLive('USE_MOCKS')).resolves.toBe(true);
    await expect(flagRegistry.getFlagLive('ENABLE_PROD_NETWORK_ANCHORING')).resolves.toBe(false);
    expect(state.singleCalls).toBe(0);
  });

  it('fails closed for unknown flags', async () => {
    await flagRegistry.init();
    flagRegistry._expireLiveCache();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(flagRegistry.getFlagLive('UNKNOWN_FLAG' as any)).resolves.toBe(false);
    expect(state.singleCalls).toBe(0);
  });

  it('refreshDbFlag updates the snapshot that getFlag and getAllFlags report', async () => {
    state.rows.set('ENABLE_EXPIRY_ALERTS', false);
    await flagRegistry.init();
    expect(flagRegistry.getFlag('ENABLE_EXPIRY_ALERTS')).toBe(false);

    state.rows.set('ENABLE_EXPIRY_ALERTS', true);
    await expect(flagRegistry.refreshDbFlag('ENABLE_EXPIRY_ALERTS')).resolves.toBe(true);

    expect(flagRegistry.getFlag('ENABLE_EXPIRY_ALERTS')).toBe(true);
    expect(flagRegistry.getAllFlags().ENABLE_EXPIRY_ALERTS.source).toBe('db');
  });

  it('serves the cached value for the whole 60s window', async () => {
    vi.useFakeTimers();
    try {
      state.rows.set('ENABLE_BATCH_ANCHORING', true);
      await flagRegistry.init();
      state.rows.set('ENABLE_BATCH_ANCHORING', false);

      vi.advanceTimersByTime(59_000);

      await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(true);
      expect(state.singleCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The whole claim of this change is "a flip takes effect within 60s". Pin the
  // boundary itself, not just the _expireLiveCache test hook.
  it('re-reads the switchboard once the 60s window elapses', async () => {
    vi.useFakeTimers();
    try {
      state.rows.set('ENABLE_BATCH_ANCHORING', true);
      await flagRegistry.init();
      state.rows.set('ENABLE_BATCH_ANCHORING', false);

      vi.advanceTimersByTime(61_000);

      await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(false);
      expect(state.singleCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The deliberate asymmetry with init(): a flag whose row never existed is
  // env-configured, and a refresh that also finds no row must leave it that
  // way. Getting this wrong would dark an env-configured rig's drain.
  it('holds the boot env value when the row is absent at boot and at refresh', async () => {
    process.env.ENABLE_BATCH_ANCHORING = 'true';
    await flagRegistry.init();
    expect(flagRegistry.getAllFlags().ENABLE_BATCH_ANCHORING.source).toBe('env');

    flagRegistry._expireLiveCache();

    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(true);
    expect(state.singleCalls).toBe(1);
  });

  // Same fail direction whether the read resolves an error or throws outright
  // (a client/network-level failure never reaches the `error` field).
  it('applies the same fail direction when the refresh throws', async () => {
    process.env.ENABLE_BATCH_ANCHORING = 'true';
    state.rows.set('ENABLE_BATCH_ANCHORING', false);
    await flagRegistry.init();

    state.readThrows = true;
    flagRegistry._expireLiveCache();

    // last-known-good is false; env saying true is not a re-open path.
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(false);
  });

  it('_reset clears the last-known-good value as well as the snapshot', async () => {
    state.rows.set('ENABLE_BATCH_ANCHORING', true);
    await flagRegistry.init();
    flagRegistry._expireLiveCache();
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(true);

    flagRegistry._reset();
    state.readFails = true;
    // No snapshot and no last-known-good left to lean on ⇒ fail closed.
    await expect(flagRegistry.getFlagLive('ENABLE_BATCH_ANCHORING')).resolves.toBe(false);
  });
});
