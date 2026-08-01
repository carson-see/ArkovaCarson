import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildReconciliation,
  formatSummary,
  KPI2_TARGET_PCT,
  loadConfig,
  parseCliArgs,
  type AnchorRow,
  type VerificationEventRow,
} from './haki-weekly-reconciliation.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const FP = (seed: string) => seed.repeat(64).slice(0, 64);
const NOW = () => '2026-07-28T12:00:00.000Z';
const WINDOW = { windowStart: '2026-07-21', windowEnd: '2026-07-28' };

function anchor(overrides: Partial<AnchorRow> = {}): AnchorRow {
  return {
    id: overrides.id ?? 'a1',
    public_id: overrides.public_id ?? `PUB-${overrides.id ?? 'a1'}`,
    status: overrides.status ?? 'SECURED',
    fingerprint: overrides.fingerprint ?? FP('a'),
    created_at: overrides.created_at ?? '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

function verifiedEvent(overrides: Partial<VerificationEventRow> = {}): VerificationEventRow {
  return {
    anchor_id: overrides.anchor_id ?? 'a1',
    public_id: overrides.public_id ?? `PUB-${overrides.anchor_id ?? 'a1'}`,
    result: 'verified',
    created_at: overrides.created_at ?? '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildReconciliation — pure KPI-2 logic (mocked rows, no network)', () => {
  it('all-complete: every anchor clears fingerprint+anchor+verification → 100%, meets target', () => {
    const anchors = [
      anchor({ id: 'a1' }),
      anchor({ id: 'a2' }),
      anchor({ id: 'a3' }),
    ];
    const verificationEvents = [
      verifiedEvent({ anchor_id: 'a1', public_id: 'PUB-a1' }),
      verifiedEvent({ anchor_id: 'a2', public_id: 'PUB-a2' }),
      verifiedEvent({ anchor_id: 'a3', public_id: 'PUB-a3' }),
    ];

    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents, now: NOW });

    expect(result.totalIssued).toBe(3);
    expect(result.completedFullCycle).toBe(3);
    expect(result.completionPct).toBe(100);
    expect(result.meetsTarget).toBe(true);
    expect(result.incomplete).toHaveLength(0);
    expect(result.byStatus).toEqual({ SECURED: 3 });
  });

  it('below-threshold: completion below 95% → meetsTarget is false', () => {
    // 18/20 complete = 90% < 95%
    const anchors = Array.from({ length: 20 }, (_, i) => anchor({ id: `a${i}` }));
    const verificationEvents = anchors
      .slice(0, 18)
      .map((a) => verifiedEvent({ anchor_id: a.id, public_id: a.public_id ?? undefined }));

    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents, now: NOW });

    expect(result.totalIssued).toBe(20);
    expect(result.completedFullCycle).toBe(18);
    expect(result.completionPct).toBe(90);
    expect(result.meetsTarget).toBe(false);
    expect(result.incomplete).toHaveLength(2);
    expect(KPI2_TARGET_PCT).toBe(95);
  });

  it('anchor stuck mid-cycle: SUBMITTED (never reached SECURED) stops at "anchor"', () => {
    const anchors = [anchor({ id: 'a1', status: 'SUBMITTED' })];
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents: [], now: NOW });

    expect(result.incomplete).toHaveLength(1);
    expect(result.incomplete[0].stoppedAt).toBe('anchor');
    expect(result.incomplete[0].anchored).toBe(false);
    expect(result.incomplete[0].fingerprinted).toBe(true); // has a valid fingerprint already
    expect(result.completionPct).toBe(0);
  });

  it('anchor SECURED but never verified stops at "verification"', () => {
    const anchors = [anchor({ id: 'a1', status: 'SECURED' })];
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents: [], now: NOW });

    expect(result.incomplete).toHaveLength(1);
    expect(result.incomplete[0].stoppedAt).toBe('verification');
    expect(result.incomplete[0].anchored).toBe(true);
    expect(result.incomplete[0].verified).toBe(false);
  });

  it('missing/malformed fingerprint stops at "fingerprint" (defensive — schema guarantees NOT NULL, but never trust blindly)', () => {
    const anchors = [anchor({ id: 'a1', fingerprint: null })];
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents: [], now: NOW });

    expect(result.incomplete[0].stoppedAt).toBe('fingerprint');
    expect(result.incomplete[0].fingerprinted).toBe(false);
  });

  it('verification event matched via public_id when anchor_id is null on the event row', () => {
    const anchors = [anchor({ id: 'a1', public_id: 'PUB-a1', status: 'SECURED' })];
    const verificationEvents = [verifiedEvent({ anchor_id: null, public_id: 'PUB-a1' })];
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents, now: NOW });

    expect(result.completedFullCycle).toBe(1);
    expect(result.incomplete).toHaveLength(0);
  });

  it('non-"verified" result rows do not count as verification (defensive filter)', () => {
    const anchors = [anchor({ id: 'a1', status: 'SECURED' })];
    const verificationEvents: VerificationEventRow[] = [
      { anchor_id: 'a1', public_id: 'PUB-a1', result: 'not_found', created_at: '2026-07-23T00:00:00.000Z' },
    ];
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents, now: NOW });

    expect(result.incomplete[0].stoppedAt).toBe('verification');
  });

  it('delta vs HakiChain reported count: computed only when supplied, labeled as self-report', () => {
    const anchors = Array.from({ length: 4 }, (_, i) => anchor({ id: `a${i}` }));
    const verificationEvents = anchors.map((a) => verifiedEvent({ anchor_id: a.id, public_id: a.public_id ?? undefined }));

    const withCount = buildReconciliation({
      orgId: 'org-1',
      ...WINDOW,
      anchors,
      verificationEvents,
      hakiReportedIssuedCount: 15,
      now: NOW,
    });
    expect(withCount.hakiChain.reportedIssuedCount).toBe(15);
    expect(withCount.hakiChain.arkovaIssuedCount).toBe(4);
    expect(withCount.hakiChain.delta).toBe(4 - 15);
    expect(withCount.hakiChain.note).toMatch(/self-report/i);

    const withoutCount = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents, now: NOW });
    expect(withoutCount.hakiChain.reportedIssuedCount).toBeNull();
    expect(withoutCount.hakiChain.delta).toBeNull();
    expect(withoutCount.hakiChain.note).toMatch(/not supplied/i);
  });

  it('empty window: totalIssued 0, completionPct 0, meetsTarget false, explicit note (not silently 100%)', () => {
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors: [], verificationEvents: [], now: NOW });

    expect(result.totalIssued).toBe(0);
    expect(result.completionPct).toBe(0);
    expect(result.meetsTarget).toBe(false);
    expect(result.completionNote).toMatch(/no anchors issued/i);
  });

  it('measurementNote is always present and states the asserted-vs-measured boundary', () => {
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors: [], verificationEvents: [], now: NOW });
    expect(result.measurementNote).toMatch(/ASSERTED vs MEASURED/);
    expect(result.measurementNote).toMatch(/not.*independently verified|NOT observable/i);
  });

  it('formatSummary renders the incomplete list with stopped-at stage and the measurement note', () => {
    const anchors = [anchor({ id: 'a1', status: 'SUBMITTED' })];
    const result = buildReconciliation({ orgId: 'org-1', ...WINDOW, anchors, verificationEvents: [], now: NOW });
    const text = formatSummary(result);
    expect(text).toContain('BELOW TARGET');
    expect(text).toContain('stopped at: anchor');
    expect(text).toContain('ASSERTED vs MEASURED');
  });
});

describe('parseCliArgs', () => {
  const argv = (overrides: Record<string, string> = {}) => [
    'node',
    'script',
    `--org-id=${overrides.orgId ?? 'f52cd07a-6d8a-4387-9346-23babec84e5c'}`,
    `--window-start=${overrides.windowStart ?? '2026-07-21'}`,
    `--window-end=${overrides.windowEnd ?? '2026-07-28'}`,
  ];

  it('accepts a valid invocation', () => {
    const args = parseCliArgs(argv());
    expect(args.orgId).toBe('f52cd07a-6d8a-4387-9346-23babec84e5c');
    expect(args.windowStart).toBe('2026-07-21');
    expect(args.windowEnd).toBe('2026-07-28');
    expect(args.hakiIssuedCount).toBeUndefined();
  });

  it('rejects a non-UUID org id', () => {
    expect(() => parseCliArgs(argv({ orgId: 'not-a-uuid' }))).toThrow();
  });

  it('rejects window-start after window-end', () => {
    expect(() => parseCliArgs(argv({ windowStart: '2026-07-29', windowEnd: '2026-07-28' }))).toThrow(
      /on or before/,
    );
  });

  it('coerces --haki-issued-count to a number', () => {
    const args = parseCliArgs([...argv(), '--haki-issued-count=15']);
    expect(args.hakiIssuedCount).toBe(15);
  });

  it('reads --haki-issued-count-file (bare number)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haki-kpi-'));
    const file = join(dir, 'count.json');
    writeFileSync(file, '15');
    try {
      const args = parseCliArgs([...argv(), `--haki-issued-count-file=${file}`]);
      expect(args.hakiIssuedCount).toBe(15);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads --haki-issued-count-file ({ issuedCount } shape)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haki-kpi-'));
    const file = join(dir, 'count.json');
    writeFileSync(file, JSON.stringify({ issuedCount: 22 }));
    try {
      const args = parseCliArgs([...argv(), `--haki-issued-count-file=${file}`]);
      expect(args.hakiIssuedCount).toBe(22);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // SonarCloud tssecurity:S8707 regression: --haki-issued-count-file must be
  // validated (resolved + confirmed to be an existing regular file) BEFORE
  // any filesystem read is attempted — a faulty/malicious value must fail
  // closed with a clear error, not silently read an arbitrary path.
  it('rejects a --haki-issued-count-file path that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haki-kpi-'));
    const missing = join(dir, 'does-not-exist.json');
    try {
      expect(() => parseCliArgs([...argv(), `--haki-issued-count-file=${missing}`])).toThrow(
        /does not resolve to an existing regular file/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a --haki-issued-count-file path that is a directory, not a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haki-kpi-'));
    // Named `*.json` so this exercises the "exists but isn't a regular file"
    // check specifically, not the (separately tested) extension allow-list.
    const dirLooksLikeJson = join(dir, 'looks-like-a-file.json');
    mkdirSync(dirLooksLikeJson);
    try {
      expect(() => parseCliArgs([...argv(), `--haki-issued-count-file=${dirLooksLikeJson}`])).toThrow(
        /does not resolve to an existing regular file/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a --haki-issued-count-file path that does not end in .json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haki-kpi-'));
    const file = join(dir, 'count.txt');
    writeFileSync(file, '15');
    try {
      expect(() => parseCliArgs([...argv(), `--haki-issued-count-file=${file}`])).toThrow(
        /must be a \.json file/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // SonarCloud tssecurity:S8707 — a traversal/absolute-path escape out of the
  // repo checkout and the OS temp dir must be rejected before any filesystem
  // call, even when it happens to end in `.json`.
  it('rejects a --haki-issued-count-file path that resolves outside the repo checkout and the OS temp dir', () => {
    expect(() => parseCliArgs([...argv(), '--haki-issued-count-file=/etc/passwd.json'])).toThrow(
      /must resolve inside the repo checkout or the OS temp dir/,
    );
  });

  it('throws a TypeError when --haki-issued-count-file contains neither a number nor {issuedCount}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'haki-kpi-'));
    const file = join(dir, 'count.json');
    writeFileSync(file, JSON.stringify({ notIssuedCount: 22 }));
    try {
      expect(() => parseCliArgs([...argv(), `--haki-issued-count-file=${file}`])).toThrow(TypeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--fail-below-target and --json default to false', () => {
    const args = parseCliArgs(argv());
    expect(args.failBelowTarget).toBe(false);
    expect(args.json).toBe(false);
  });
});

describe('loadConfig (read-only — no embedded credentials)', () => {
  it('reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from env', () => {
    const cfg = loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' } as NodeJS.ProcessEnv);
    expect(cfg.url).toBe('https://x.supabase.co');
    expect(cfg.readKey).toBe('srk');
  });

  it('falls back to SUPABASE_ANON_KEY when service role key is absent', () => {
    const cfg = loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' } as NodeJS.ProcessEnv);
    expect(cfg.readKey).toBe('anon');
  });

  it('throws when SUPABASE_URL is missing', () => {
    expect(() => loadConfig({ SUPABASE_SERVICE_ROLE_KEY: 'srk' } as NodeJS.ProcessEnv)).toThrow(/SUPABASE_URL/);
  });

  it('throws when no read key is available', () => {
    expect(() => loadConfig({ SUPABASE_URL: 'https://x.supabase.co' } as NodeJS.ProcessEnv)).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});

describe('module is read-only: no write path, no embedded credentials', () => {
  const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), 'haki-weekly-reconciliation.ts');

  it('contains no INSERT/UPDATE/DELETE/PATCH/POST SQL or REST verbs, and every fetch is method: GET', () => {
    const src = readFileSync(SRC_PATH, 'utf8');
    expect(src).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(src).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(src).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(src).not.toMatch(/method:\s*['"]POST['"]/);
    expect(src).not.toMatch(/method:\s*['"]PATCH['"]/);
    expect(src).not.toMatch(/method:\s*['"]DELETE['"]/);
  });

  it('never hardcodes a Supabase URL, key, or secret literal', () => {
    const src = readFileSync(SRC_PATH, 'utf8');
    expect(src).not.toMatch(/https:\/\/[a-z0-9]+\.supabase\.co/);
    expect(src).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}/); // JWT-shaped literal (service role / anon keys are JWTs)
  });
});
