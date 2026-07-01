import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  auditLedgerRows,
  auditLedgerVsRepo,
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

describe('auditLedgerVsRepo — prod-ahead-of-repo orphan rows (0347 incident, 2026-06-29)', () => {
  const FILES = [BASELINE, '0345_a.sql', '0346_b.sql', '0347_lane1_i4_chain_block_hash_reorg.sql', '0348_c.sql'];

  it('passes when every numeric prod ledger row has a matching repo file', () => {
    const rows: LedgerRow[] = [
      { version: '0346', name: '0346_b' },
      { version: '0347', name: '0347_lane1_i4_chain_block_hash_reorg' },
      { version: '0348', name: '0348_c' },
    ];
    expect(auditLedgerVsRepo(rows, FILES)).toEqual([]);
  });

  it('FAILS on a clean numeric prod row with no repo file — the exact 0347-applied-out-of-band shape', () => {
    // Repo is missing 0347 (PR #1307 unmerged); prod ledger has it. auditLedgerRows
    // would pass this row (numeric version, no dup) — only the repo cross-check catches it.
    const filesWithout0347 = [BASELINE, '0345_a.sql', '0346_b.sql', '0348_c.sql'];
    const rows: LedgerRow[] = [
      { version: '0347', name: '0347_lane1_i4_chain_block_hash_reorg' },
    ];
    expect(auditLedgerRows(rows)).toEqual([]); // format-valid, slips the existing pass
    const v = auditLedgerVsRepo(rows, filesWithout0347);
    expect(v.map((x) => x.code)).toContain('ledger-orphan-prod-row');
    expect(v.some((x) => x.message.includes('0347'))).toBe(true);
  });

  it('does NOT flag a repo file that is not yet in the prod ledger (normal pre-RTE-apply window)', () => {
    // Repo has 0349 (merged), prod ledger does not yet (awaiting post-merge apply). No violation.
    const files = [...FILES, '0349_new_merged.sql'];
    const rows: LedgerRow[] = [{ version: '0348', name: '0348_c' }];
    expect(auditLedgerVsRepo(rows, files)).toEqual([]);
  });

  it('honors the exemption set for a documented orphan prefix', () => {
    const filesWithout0347 = [BASELINE, '0346_b.sql', '0348_c.sql'];
    const rows: LedgerRow[] = [{ version: '0347', name: '0347_lane1_i4_chain_block_hash_reorg' }];
    expect(auditLedgerVsRepo(rows, filesWithout0347)).not.toEqual([]);
    expect(auditLedgerVsRepo(rows, filesWithout0347, new Set(['0347']))).toEqual([]);
  });

  it('FAILS on a descriptive-named orphan (numeric version, free-text MCP name) — the version-keyed catch', () => {
    // An MCP apply_migration records a free-text name over a numeric version.
    // A name-keyed check would miss this; the version-keyed check catches it.
    const filesWithout0292 = [BASELINE, '0290_a.sql', '0293_c.sql'];
    const rows: LedgerRow[] = [{ version: '0292', name: 'microsoft_graph_webhook_nonces' }];
    expect(auditLedgerRows(rows)).toEqual([]); // descriptive name → existing pass ignores it
    const v = auditLedgerVsRepo(rows, filesWithout0292);
    expect(v.map((x) => x.code)).toContain('ledger-orphan-prod-row');
    expect(v.some((x) => x.message.includes('0292'))).toBe(true);
  });

  it('ignores baseline / operator-named ledger rows (not repo-file-tracked)', () => {
    const rows: LedgerRow[] = [
      { version: '00000000000000', name: '00000000000000_baseline_at_main_HEAD' },
      { version: 'public_verification_revoked', name: 'public_verification_revoked' },
    ];
    expect(auditLedgerVsRepo(rows, FILES)).toEqual([]);
  });

  it('matches a lettered-suffix repo file (0055b_) against a 0055_ ledger prefix', () => {
    const rows: LedgerRow[] = [{ version: '0055', name: '0055_seed_alignment' }];
    expect(auditLedgerVsRepo(rows, [BASELINE, '0055b_seed_alignment_idempotent.sql'])).toEqual([]);
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
