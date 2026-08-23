/**
 * Regression tests for the 2026-08-17 poison-record incident.
 *
 * A prod `public_records` row (openalex W7159838936) carried a
 * `metadata.abstract` of 1,914 codepoints = 2,000 UTF-16 units including 86
 * astral-plane characters. `publicRecordDescription`'s `.slice(0, 500)` is a
 * UTF-16 CODE-UNIT slice: unit 500 fell in the middle of a surrogate pair,
 * the cut left a lone high surrogate in `description`, PostgREST rejected the
 * insert with PGRST102 "Empty or invalid json", and — because the fetch
 * orders `created_at` ascending with no quarantine — the same oldest row
 * re-poisoned the head of the queue every 10 minutes for 16 days.
 *
 * These tests pin BOTH truncation sites (`description` at 500 units,
 * `buildAnchorFilename`'s title at 180 units) to never emit a lone surrogate,
 * and pin the serial-fallback failure contract that feeds the quarantine
 * defense-in-depth (`public-record-quarantine.ts`).
 *
 * Namespace import is deliberate: on pre-fix code some of these exports do
 * not exist, and a named import would fail at module link time and mask the
 * behavioral failures of the exports that DO exist (red-first proof).
 */

import { describe, it, expect, vi } from 'vitest';

// ---- Module-import mocks (same shape as publicRecordAnchor.test.ts) ----
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
  },
}));
vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../utils/db.js', () => ({
  db: {},
  withDbTimeout: vi.fn((operation: () => Promise<unknown>) => operation()),
}));
vi.mock('../../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: vi.fn() }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: vi.fn() }),
}));
vi.mock('../../utils/sentry.js', () => ({ captureCreditRpcFailureAlert: vi.fn() }));

import * as job from '../publicRecordAnchor.js';

// U+1D54F MATHEMATICAL DOUBLE-STRUCK CAPITAL X — 2 UTF-16 units, same class of
// astral-plane character (mathematical alphanumeric symbols) as the prod row.
const ASTRAL = '\u{1D54F}';
const HIGH_SURROGATE = ASTRAL[0];

/** Manual scanner — no dependency on ES2024 `String.prototype.isWellFormed`. */
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return false; // lone low surrogate
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false; // lone high surrogate
      i++;
    }
  }
  return true;
}

/** Postgres speaks UTF-8: a string survives a UTF-8 round-trip iff it carries no lone surrogates. */
function survivesUtf8RoundTrip(s: string): boolean {
  return Buffer.from(s, 'utf8').toString('utf8') === s;
}

/**
 * The exact poison shape: 2,000 UTF-16 units, 1,914 codepoints, 86 astral
 * characters, with one astral character occupying units 499–500 so that
 * `.slice(0, 500)` splits its surrogate pair.
 */
function buildPoisonAbstract(): string {
  const head = 'a'.repeat(499) + ASTRAL; // units 0–498 ASCII, units 499–500 the pair the cut splits
  const tail = ASTRAL.repeat(85) + 'b'.repeat(1329);
  return head + tail;
}

function makeRecord(metadata: Record<string, unknown>, title: string | null = null) {
  return {
    id: 'e9143d08-9706-4d30-97cb-44f2c1be308b',
    source: 'openalex',
    source_id: 'W7159838936',
    source_url: null,
    record_type: 'publication',
    title,
    content_hash: '18ce56cd'.repeat(8),
    metadata,
  };
}

describe('surrogate-safe truncation (2026-08-17 poison record)', () => {
  it('fixture matches the prod poison shape exactly', () => {
    const abstract = buildPoisonAbstract();
    expect(abstract.length).toBe(2000); // UTF-16 units
    expect([...abstract].length).toBe(1914); // codepoints
    expect([...abstract].filter((ch) => ch.length === 2).length).toBe(86); // astral chars
    // The cut at unit 500 falls inside a surrogate pair on this fixture.
    expect(abstract.charCodeAt(499)).toBeGreaterThanOrEqual(0xd800);
    expect(abstract.charCodeAt(499)).toBeLessThanOrEqual(0xdbff);
    // And naive .slice(0, 500) demonstrably produces the poison.
    expect(isWellFormedUtf16(abstract.slice(0, 500))).toBe(false);
  });

  it('description built from the poison abstract is well-formed and JSON-safe', () => {
    const description = job.publicRecordDescription!(makeRecord({ abstract: buildPoisonAbstract() }));

    expect(description).not.toBeNull();
    expect(description!.length).toBeLessThanOrEqual(500);
    expect(isWellFormedUtf16(description!)).toBe(true);
    expect(survivesUtf8RoundTrip(description!)).toBe(true);
    // JSON round-trip — what the PostgREST request body needs to survive.
    expect(JSON.parse(JSON.stringify({ description }))).toEqual({ description });
  });

  it('the cut DROPS the split surrogate instead of emitting U+FFFD', () => {
    const description = job.publicRecordDescription!(makeRecord({ abstract: buildPoisonAbstract() }));
    // Units 0–498 survive; the orphaned high surrogate at unit 499 is dropped.
    expect(description).toBe('a'.repeat(499));
    expect(description).not.toContain('�');
  });

  it('an abstract ending exactly at the limit on a COMPLETE pair is preserved intact', () => {
    const abstract = 'a'.repeat(498) + ASTRAL; // 500 units, pair occupies 498–499
    const description = job.publicRecordDescription!(makeRecord({ abstract }));
    expect(description).toBe(abstract);
    expect(isWellFormedUtf16(description!)).toBe(true);
  });

  it('short astral-bearing abstracts pass through untouched', () => {
    const abstract = `math symbols ${ASTRAL}${ASTRAL} inline`;
    expect(job.publicRecordDescription!(makeRecord({ abstract }))).toBe(abstract);
  });

  it('buildAnchorFilename never emits a lone surrogate when the title cut splits a pair', () => {
    // Astral char occupies units 179–180 → .slice(0, 180) splits it.
    const title = 'T'.repeat(179) + ASTRAL + ' trailing title overflow beyond the cut';
    const filename = job.buildAnchorFilename(makeRecord({}, title) as Parameters<typeof job.buildAnchorFilename>[0]);

    expect(isWellFormedUtf16(filename)).toBe(true);
    expect(survivesUtf8RoundTrip(filename)).toBe(true);
    expect(JSON.parse(JSON.stringify({ filename }))).toEqual({ filename });
    expect(filename).toBe(`[OA] ${'T'.repeat(179)}`);
    expect(filename).not.toContain(HIGH_SURROGATE);
  });

  it('buildAnchorFilename leaves short titles untouched', () => {
    const title = `Short ${ASTRAL} title`;
    expect(job.buildAnchorFilename(makeRecord({}, title) as Parameters<typeof job.buildAnchorFilename>[0]))
      .toBe(`[OA] ${title}`);
  });
});

// ---- Serial-fallback failure contract (feeds the quarantine) ----

type InsertResult = { data: { id: string; fingerprint: string } | null; error: { code: string; message: string } | null };

function makeSerialClient(resultByFingerprint: Record<string, InsertResult>, existing?: { id: string; fingerprint: string }) {
  const insert = vi.fn((anchor: { fingerprint: string }) => ({
    select: vi.fn(() => ({
      single: vi.fn(async () =>
        resultByFingerprint[anchor.fingerprint]
        ?? { data: { id: `id-${anchor.fingerprint.slice(0, 4)}`, fingerprint: anchor.fingerprint }, error: null }),
    })),
  }));
  const maybeSingle = vi.fn(async () => ({ data: existing ?? null, error: null }));
  const select = vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({
        is: vi.fn(() => ({
          limit: vi.fn(() => ({ maybeSingle })),
        })),
      })),
    })),
  }));
  return {
    client: { from: vi.fn(() => ({ insert, select })) },
    insert,
  };
}

function makeInsert(fingerprint: string, sourceId: string) {
  return {
    user_id: 'owner-id',
    org_id: null,
    fingerprint,
    filename: `[OA] ${sourceId}`,
    credential_type: 'PUBLICATION',
    status: 'PENDING' as const,
    metadata: {
      pipeline_source: 'openalex',
      source_id: sourceId,
      source_url: null,
      record_type: 'publication',
    },
  };
}

describe('insertAnchorSerialFallback failure reporting (quarantine feed)', () => {
  it('reports a non-23505 insert failure instead of silently continuing', async () => {
    const poisoned = 'ff'.repeat(32);
    const healthy = 'aa'.repeat(32);
    const { client } = makeSerialClient({
      [poisoned]: { data: null, error: { code: 'PGRST102', message: 'Empty or invalid json' } },
    });

    const { created, failures } = await job.insertAnchorSerialFallback!(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      [makeInsert(healthy, 'W1'), makeInsert(poisoned, 'W2')],
      'owner-id',
    );

    expect(created.map((a: { fingerprint: string }) => a.fingerprint)).toEqual([healthy]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ fingerprint: poisoned, pgCode: 'PGRST102' });
    expect(typeof failures[0].sourceKey).toBe('string');
    expect(failures[0].sourceKey).toContain('W2');
  });

  it('still resolves a 23505 duplicate to the existing anchor — NOT a failure', async () => {
    const dupe = 'bb'.repeat(32);
    const { client } = makeSerialClient(
      { [dupe]: { data: null, error: { code: '23505', message: 'duplicate key' } } },
      { id: 'existing-id', fingerprint: dupe },
    );

    const { created, failures } = await job.insertAnchorSerialFallback!(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client as any,
      [makeInsert(dupe, 'W3')],
      'owner-id',
    );

    expect(created).toEqual([{ id: 'existing-id', fingerprint: dupe }]);
    expect(failures).toHaveLength(0);
  });
});
