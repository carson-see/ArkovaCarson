import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  auditLedgerRows,
  auditLocalFiles,
  parseLedgerPayload,
  type LedgerRow,
} from './check-ledger-numeric-integrity.ts';

// vitest runs from the repo root; reference the script by repo-relative path.
const SCRIPT = 'scripts/ci/check-ledger-numeric-integrity.ts';

/** Run the CLI; return exit status + combined stdout+stderr (warnings go to stderr). */
function runCli(env: Record<string, string>, args: string[] = []): { status: number; out: string } {
  const r = spawnSync('npx', ['tsx', SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}


const BASELINE = '00000000000000_baseline_at_main_HEAD.sql';

describe('auditLedgerRows — prod ledger numeric integrity (SCRUM-2500 / S0-4.2)', () => {
  it('passes a clean numeric ledger', () => {
    const rows: LedgerRow[] = [
      { version: '0322', name: '0322_bump_cloud_logging_retry_counts_rpc' },
      { version: '0330', name: '0330_scrum2203_unembedded_records_query_perf' },
      { version: '0331', name: '0331_scrum1847_1869_public_anchor_cpe_cle_metadata' },
    ];
    expect(auditLedgerRows(rows)).toEqual([]);
  });

  it('FAILS on an injected timestamp-version row for a numeric-named migration (the 2026-06-15 regression class)', () => {
    const rows: LedgerRow[] = [
      { version: '0330', name: '0330_scrum2203_unembedded_records_query_perf' },
      // re-regressed: numeric name, timestamp version
      { version: '20260615120000', name: '0322_bump_cloud_logging_retry_counts_rpc' },
    ];
    const v = auditLedgerRows(rows);
    expect(v.map((x) => x.code)).toContain('ledger-nonnumeric-version');
    expect(v.some((x) => x.message.includes('0322'))).toBe(true);
  });

  it('FAILS on a timestamp_numeric composite version', () => {
    const rows: LedgerRow[] = [
      { version: '20260503192636_0285_api_key_scope_vocabulary', name: '0285_api_key_scope_vocabulary' },
    ];
    expect(auditLedgerRows(rows).map((x) => x.code)).toContain('ledger-nonnumeric-version');
  });

  it('FAILS on a duplicate migration name (the 0302/0303 dup class, SCRUM-2192)', () => {
    const rows: LedgerRow[] = [
      { version: '0302', name: '0302_validate_api_key_rpc_hardening' },
      { version: '0303', name: '0302_validate_api_key_rpc_hardening' },
    ];
    expect(auditLedgerRows(rows).map((x) => x.code)).toContain('ledger-duplicate-name');
  });

  it('FAILS on a duplicate version', () => {
    const rows: LedgerRow[] = [
      { version: '0330', name: '0330_a' },
      { version: '0330', name: '0331_b' },
    ];
    expect(auditLedgerRows(rows).map((x) => x.code)).toContain('ledger-duplicate-version');
  });

  it('SKIPS a documented-exempt prefix even with a timestamp version (the 0287–0310 backlog)', () => {
    const rows: LedgerRow[] = [
      { version: '20260503192636_0285', name: '0302_validate_api_key_rpc_hardening' },
    ];
    // Without the exemption it would fail; with it, the known backlog is skipped.
    expect(auditLedgerRows(rows)).not.toEqual([]);
    expect(auditLedgerRows(rows, new Set(['0302']))).toEqual([]);
  });

  it('STILL fails a NON-exempt numeric row that re-regressed, even when other prefixes are exempt', () => {
    const rows: LedgerRow[] = [
      { version: '20260503192636_0285', name: '0302_validate_api_key_rpc_hardening' }, // exempt
      { version: '20260615120000', name: '0322_bump_cloud_logging' }, // NOT exempt → must fail
    ];
    const v = auditLedgerRows(rows, new Set(['0302']));
    expect(v.map((x) => x.code)).toContain('ledger-nonnumeric-version');
    expect(v.some((x) => x.message.includes('0322'))).toBe(true);
  });

  it('skips exempt rows for the duplicate-name check too (the 0302/0303 dup, SCRUM-2192)', () => {
    const rows: LedgerRow[] = [
      { version: '0302', name: '0302_validate_api_key_rpc_hardening' },
      { version: '0303', name: '0302_validate_api_key_rpc_hardening' },
    ];
    expect(auditLedgerRows(rows, new Set(['0302']))).toEqual([]);
  });

  it('does not require non-numeric-named rows (baseline / operator names) to carry a numeric version', () => {
    const rows: LedgerRow[] = [
      { version: '00000000000000', name: '00000000000000_baseline_at_main_HEAD' },
      { version: 'public_verification_revoked', name: 'public_verification_revoked' },
      { version: '0330', name: '0330_ok' },
    ];
    expect(auditLedgerRows(rows)).toEqual([]);
  });

  it('tolerates missing/null name fields without throwing', () => {
    const rows: LedgerRow[] = [
      { version: '0330', name: null },
      { version: '0331' },
    ];
    expect(() => auditLedgerRows(rows)).not.toThrow();
  });
});

describe('auditLocalFiles — local migration filename grammar (S0-4.2)', () => {
  const grandfathered = new Set<string>(['0022']);

  it('passes the baseline + numeric + grandfathered lettered-suffix files', () => {
    const files = [
      BASELINE,
      '0311_scrum1599_public_anchor_provenance.sql',
      '0055b_seed_alignment_idempotent.sql',
      '0339_get_public_anchor_by_fingerprint.sql',
    ];
    expect(auditLocalFiles(files, grandfathered)).toEqual([]);
  });

  it('FAILS a stray 14-digit timestamp-prefixed local file (non-baseline)', () => {
    const v = auditLocalFiles(['20260617123456_sneaky.sql'], grandfathered);
    expect(v.map((x) => x.code)).toContain('local-nonnumeric-prefix');
  });

  it('FAILS an unrecognized filename with no numeric prefix', () => {
    const v = auditLocalFiles(['fix_the_thing.sql'], grandfathered);
    expect(v.map((x) => x.code)).toContain('local-malformed-prefix');
  });

  it('FAILS a non-grandfathered duplicate numeric prefix', () => {
    const v = auditLocalFiles(['0327_a.sql', '0327_b.sql'], grandfathered);
    expect(v.map((x) => x.code)).toContain('local-duplicate-prefix');
  });

  it('allows a grandfathered duplicate prefix', () => {
    const v = auditLocalFiles(['0022_one.sql', '0022_two.sql'], grandfathered);
    expect(v.map((x) => x.code)).not.toContain('local-duplicate-prefix');
  });
});

describe('parseLedgerPayload — fail-closed boundary (P1)', () => {
  it('throws on a non-array payload', () => {
    expect(() => parseLedgerPayload('{}')).toThrow(/not a JSON array/);
  });
  it('parses an array of rows, coercing version to string', () => {
    expect(parseLedgerPayload('[{"version":330,"name":"x"}]')).toEqual([{ version: '330', name: 'x' }]);
  });
});

describe('CLI exit codes — BLOCK vs WARN vs fail-closed (S0-4.2 main())', () => {
  const dirty = JSON.stringify([{ version: '20260615120000', name: '0322_bump_cloud_logging' }]);

  it('BLOCKS (exit 1) on a non-exempt timestamp-version row in default (blocking) mode', () => {
    const r = runCli({ LEDGER_JSON: dirty });
    expect(r.status).toBe(1);
    expect(r.out).toContain('ledger-nonnumeric-version');
  });

  it('WARNS (exit 0) on the same row with --report-only', () => {
    const r = runCli({ LEDGER_JSON: dirty }, ['--report-only']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('::warning::');
  });

  it('fails closed (exit 1) on an unparseable supplied ledger', () => {
    const r = runCli({ LEDGER_JSON: 'not json' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('ledger-parse-failure');
  });

  it('passes (exit 0) with no ledger payload — local-file pass only', () => {
    const r = runCli({ LEDGER_JSON: '' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('Ledger pass skipped');
  });
});
