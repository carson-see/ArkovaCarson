import { describe, expect, it, vi } from 'vitest';
import {
  buildLedgerUpdateSql,
  buildReconciliationPlan,
  buildTransactionSql,
  parseArgs,
  run,
  type LedgerMigrationRow,
  type LocalMigration,
} from './reconcile-migration-ledger';

const local = (basename: string): LocalMigration => ({
  basename,
  version: basename.split('_')[0] ?? basename,
  suffix: basename.replace(/^\d{4}[a-z]?_/, '').replace(/^\d{14}_/, ''),
});

describe('buildReconciliationPlan', () => {
  it('plans timestamp-version ledger updates for local numeric migrations with matching names', () => {
    const plan = buildReconciliationPlan(
      [
        local('0290_suborg_suspension_audit_and_service_role_fix'),
        local('0307_fix_anchors_rls_statement_timeout'),
      ],
      [
        { version: '20260504130753', name: '0290_suborg_suspension_audit_and_service_role_fix' },
        { version: '20260516114615', name: '0307_fix_anchors_rls_statement_timeout' },
      ],
    );

    expect(plan.updates).toEqual([
      {
        currentVersion: '20260504130753',
        currentName: '0290_suborg_suspension_audit_and_service_role_fix',
        targetVersion: '0290',
        localBasename: '0290_suborg_suspension_audit_and_service_role_fix',
      },
      {
        currentVersion: '20260516114615',
        currentName: '0307_fix_anchors_rls_statement_timeout',
        targetVersion: '0307',
        localBasename: '0307_fix_anchors_rls_statement_timeout',
      },
    ]);
  });

  it('matches timestamp rows whose name is only the local suffix', () => {
    const plan = buildReconciliationPlan(
      [local('0316_sweep_webhook_nonces_rpc')],
      [{ version: '20260528145100', name: 'sweep_webhook_nonces_rpc' }],
    );

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.targetVersion).toBe('0316');
  });

  it('does not update migrations that already have a numeric ledger version', () => {
    const plan = buildReconciliationPlan(
      [local('0317_connector_alert_state')],
      [{ version: '0317', name: 'connector_alert_state' }],
    );

    expect(plan.updates).toEqual([]);
  });

  it('allows duplicate local suffixes when ledger rows use full migration names', () => {
    const plan = buildReconciliationPlan(
      [
        local('0302_validate_api_key_rpc_hardening'),
        local('0303_validate_api_key_rpc_hardening'),
      ],
      [
        { version: '20260501030200', name: '0302_validate_api_key_rpc_hardening' },
        { version: '20260501030300', name: '0303_validate_api_key_rpc_hardening' },
      ],
    );

    expect(plan.updates.map((update) => update.targetVersion)).toEqual(['0302', '0303']);
  });

  it('refuses duplicate local migration suffixes when a suffix-only ledger row is ambiguous', () => {
    expect(() => buildReconciliationPlan(
      [
        local('0316_connector_alert_state'),
        local('0317_connector_alert_state'),
      ],
      [{ version: '20260528145100', name: 'connector_alert_state' }],
    )).toThrow('Duplicate local migration suffix');
  });

  it('refuses multiple timestamp ledger rows for the same local migration', () => {
    expect(() => buildReconciliationPlan(
      [local('0308_seed_arkova_org_credits')],
      [
        { version: '20260516114733', name: '0308_seed_arkova_org_credits' },
        { version: '20260516120000', name: 'seed_arkova_org_credits' },
      ],
    )).toThrow('Multiple timestamp ledger rows match');
  });

  it('refuses to collide with an existing different row that already owns the target version', () => {
    expect(() => buildReconciliationPlan(
      [local('0307_fix_anchors_rls_statement_timeout')],
      [
        { version: '0307', name: 'some_other_migration' },
        { version: '20260516114615', name: '0307_fix_anchors_rls_statement_timeout' },
      ],
    )).toThrow('already exists in the ledger');
  });
});

describe('SQL builders', () => {
  it('escapes string literals and updates by exact version and name', () => {
    const sql = buildLedgerUpdateSql({
      currentVersion: '20260516114615',
      currentName: "0307_fix_o'clock",
      targetVersion: '0307',
      localBasename: "0307_fix_o'clock",
    });

    expect(sql).toContain("SET version = '0307'");
    expect(sql).toContain("version = '20260516114615'");
    expect(sql).toContain("name IS NOT DISTINCT FROM '0307_fix_o''clock'");
    expect(sql).toContain('GET DIAGNOSTICS updated_count = ROW_COUNT;');
    expect(sql).toContain('IF updated_count <> 1 THEN');
    expect(sql).toContain('RAISE EXCEPTION');
  });

  it('wraps dry-run SQL in a transaction that operators can inspect', () => {
    const sql = buildTransactionSql([
      {
        currentVersion: '20260516114615',
        currentName: '0307_fix_anchors_rls_statement_timeout',
        targetVersion: '0307',
        localBasename: '0307_fix_anchors_rls_statement_timeout',
      },
    ]);

    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).toContain('-- 0307_fix_anchors_rls_statement_timeout');
    expect(sql).toContain('GET DIAGNOSTICS updated_count = ROW_COUNT;');
  });
});

describe('parseArgs', () => {
  const env = {
    SUPABASE_PROJECT_REF: 'vzwyaatejekddvltxyye',
    SUPABASE_ACCESS_TOKEN: 'sbp_token',
  };

  it('defaults to dry-run mode', () => {
    expect(parseArgs([], env)).toMatchObject({
      mode: 'dry-run',
      projectRef: 'vzwyaatejekddvltxyye',
      accessToken: 'sbp_token',
    });
  });

  it('requires exact project-ref confirmation for apply mode', () => {
    expect(() => parseArgs(['--apply'], env)).toThrow('--confirm-project-ref');
    expect(() => parseArgs(['--apply', '--confirm-project-ref', 'wrong'], env)).toThrow(
      'does not match SUPABASE_PROJECT_REF',
    );

    expect(parseArgs(['--apply', '--confirm-project-ref', 'vzwyaatejekddvltxyye'], env).mode).toBe('apply');
  });
});

describe('run', () => {
  it('dry-runs without executing SQL', async () => {
    const fetchLedger = vi.fn(async (): Promise<LedgerMigrationRow[]> => [
      { version: '20260516114615', name: '0307_fix_anchors_rls_statement_timeout' },
    ]);
    const executeSql = vi.fn(async () => []);
    const readLocalMigrations = vi.fn(async () => [local('0307_fix_anchors_rls_statement_timeout')]);

    const result = await run(
      {
        mode: 'dry-run',
        projectRef: 'project-ref',
        accessToken: 'token',
        repoRoot: '/repo',
      },
      { fetchLedger, executeSql, readLocalMigrations },
    );

    expect(result.updates).toHaveLength(1);
    expect(result.sql).toContain("SET version = '0307'");
    expect(executeSql).not.toHaveBeenCalled();
  });

  it('applies the same transaction SQL only in apply mode', async () => {
    const fetchLedger = vi.fn()
      .mockResolvedValueOnce([
        { version: '20260516114615', name: '0307_fix_anchors_rls_statement_timeout' },
      ] satisfies LedgerMigrationRow[])
      .mockResolvedValueOnce([
        { version: '0307', name: '0307_fix_anchors_rls_statement_timeout' },
      ] satisfies LedgerMigrationRow[]);
    const executeSql = vi.fn(async () => [{ version: '0307', name: '0307_fix_anchors_rls_statement_timeout' }]);
    const readLocalMigrations = vi.fn(async () => [local('0307_fix_anchors_rls_statement_timeout')]);

    await run(
      {
        mode: 'apply',
        projectRef: 'project-ref',
        accessToken: 'token',
        repoRoot: '/repo',
        confirmProjectRef: 'project-ref',
      },
      { fetchLedger, executeSql, readLocalMigrations },
    );

    expect(executeSql).toHaveBeenCalledOnce();
    expect(fetchLedger).toHaveBeenCalledTimes(2);
    const executeCall = executeSql.mock.calls[0] as unknown[] | undefined;
    expect(executeCall?.[2]).toContain("SET version = '0307'");
  });

  it('fails closed when apply verification still finds pending ledger updates', async () => {
    const fetchLedger = vi.fn(async (): Promise<LedgerMigrationRow[]> => [
      { version: '20260516114615', name: '0307_fix_anchors_rls_statement_timeout' },
    ]);
    const executeSql = vi.fn(async () => []);
    const readLocalMigrations = vi.fn(async () => [local('0307_fix_anchors_rls_statement_timeout')]);

    await expect(run(
      {
        mode: 'apply',
        projectRef: 'project-ref',
        accessToken: 'token',
        repoRoot: '/repo',
        confirmProjectRef: 'project-ref',
      },
      { fetchLedger, executeSql, readLocalMigrations },
    )).rejects.toThrow('apply verification failed');

    expect(executeSql).toHaveBeenCalledOnce();
    expect(fetchLedger).toHaveBeenCalledTimes(2);
  });
});
