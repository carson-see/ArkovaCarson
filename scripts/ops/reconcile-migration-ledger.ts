import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGEMENT_API_BASE_URL = 'https://api.supabase.com/v1';
const TIMESTAMP_VERSION_RE = /^\d{14}$/;
const NUMERIC_LOCAL_MIGRATION_RE = /^(\d{4}[a-z]?)_(.+)$/;

export interface LocalMigration {
  basename: string;
  version: string;
  suffix: string;
}

export interface LedgerMigrationRow {
  version: string;
  name?: string | null;
}

export interface LedgerUpdate {
  currentVersion: string;
  currentName: string | null;
  targetVersion: string;
  localBasename: string;
}

export interface ReconciliationPlan {
  updates: LedgerUpdate[];
}

export type CliMode = 'dry-run' | 'apply';

export interface CliOptions {
  mode: CliMode;
  projectRef: string;
  accessToken: string;
  repoRoot: string;
  confirmProjectRef?: string;
}

export interface RunResult {
  updates: LedgerUpdate[];
  sql: string;
  applyResult?: unknown;
}

export interface ReconcileDependencies {
  readLocalMigrations: (repoRoot: string) => Promise<LocalMigration[]>;
  fetchLedger: (projectRef: string, accessToken: string) => Promise<LedgerMigrationRow[]>;
  executeSql: (projectRef: string, accessToken: string, sql: string) => Promise<unknown>;
}

interface ParseEnv {
  SUPABASE_PROJECT_REF?: string;
  SUPABASE_ACCESS_TOKEN?: string;
  SUPABASE_MANAGEMENT_API_TOKEN?: string;
}

function normalizeLedgerRow(row: LedgerMigrationRow): LedgerMigrationRow {
  return {
    version: String(row.version),
    name: row.name == null ? null : String(row.name),
  };
}

function localMigrationFromBasename(basename: string): LocalMigration | null {
  const match = basename.match(NUMERIC_LOCAL_MIGRATION_RE);
  if (!match) {
    return null;
  }

  return {
    basename,
    version: match[1]!,
    suffix: match[2]!,
  };
}

function ledgerNameMatchesLocal(row: LedgerMigrationRow, local: LocalMigration): boolean {
  const name = row.name ?? '';
  return name === local.basename || name === local.suffix;
}

function ledgerNameMatchesFullLocalName(row: LedgerMigrationRow, local: LocalMigration): boolean {
  return (row.name ?? '') === local.basename;
}

function quoteSqlLiteral(value: string | null): string {
  if (value === null) {
    return 'NULL';
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export async function readLocalMigrations(repoRoot: string): Promise<LocalMigration[]> {
  const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');
  const entries = await readdir(migrationsDir);

  return entries
    .filter((entry) => entry.endsWith('.sql'))
    .map((entry) => localMigrationFromBasename(entry.replace(/\.sql$/, '')))
    .filter((migration): migration is LocalMigration => migration !== null)
    .sort((a, b) => a.basename.localeCompare(b.basename));
}

export function buildReconciliationPlan(
  localMigrations: LocalMigration[],
  ledgerRows: LedgerMigrationRow[],
): ReconciliationPlan {
  const rows = ledgerRows.map(normalizeLedgerRow);
  const suffixOwners = new Map<string, LocalMigration>();

  for (const migration of localMigrations) {
    const existing = suffixOwners.get(migration.suffix);
    if (existing) {
      suffixOwners.set(migration.suffix, {
        basename: `${existing.basename}, ${migration.basename}`,
        version: existing.version,
        suffix: migration.suffix,
      });
    } else {
      suffixOwners.set(migration.suffix, migration);
    }
  }

  const updates: LedgerUpdate[] = [];

  for (const migration of localMigrations) {
    const exactVersionRows = rows.filter((row) => row.version === migration.version);
    const exactLocalRow = exactVersionRows.find((row) => ledgerNameMatchesLocal(row, migration));
    if (exactLocalRow) {
      continue;
    }
    if (exactVersionRows.length > 0) {
      throw new Error(
        `Version ${migration.version} already exists in the ledger for a different migration; refusing to reconcile ${migration.basename}.`,
      );
    }

    const matchingTimestampRows = rows.filter((row) => {
      if (!TIMESTAMP_VERSION_RE.test(row.version)) {
        return false;
      }
      if (ledgerNameMatchesFullLocalName(row, migration)) {
        return true;
      }

      const name = row.name ?? '';
      if (name !== migration.suffix) {
        return false;
      }
      const owner = suffixOwners.get(migration.suffix);
      if (owner && owner.basename.includes(', ')) {
        throw new Error(
          `Duplicate local migration suffix "${migration.suffix}" for ${owner.basename}; suffix-only ledger row ${row.version}/${name} is ambiguous.`,
        );
      }
      return true;
    });

    if (matchingTimestampRows.length === 0) {
      continue;
    }
    if (matchingTimestampRows.length > 1) {
      const matches = matchingTimestampRows
        .map((row) => `${row.version}/${row.name ?? ''}`)
        .join(', ');
      throw new Error(`Multiple timestamp ledger rows match ${migration.basename}: ${matches}`);
    }

    const row = matchingTimestampRows[0]!;
    updates.push({
      currentVersion: row.version,
      currentName: row.name ?? null,
      targetVersion: migration.version,
      localBasename: migration.basename,
    });
  }

  return {
    updates: updates.sort((a, b) => a.targetVersion.localeCompare(b.targetVersion)),
  };
}

export function buildLedgerUpdateSql(update: LedgerUpdate): string {
  return [
    `-- ${update.localBasename}`,
    'DO $ledger_reconcile$',
    'DECLARE',
    '  updated_count integer;',
    'BEGIN',
    '  UPDATE supabase_migrations.schema_migrations',
    `  SET version = ${quoteSqlLiteral(update.targetVersion)}`,
    `  WHERE version = ${quoteSqlLiteral(update.currentVersion)}`,
    `    AND name IS NOT DISTINCT FROM ${quoteSqlLiteral(update.currentName)}`,
    `    AND NOT EXISTS (
    SELECT 1
    FROM supabase_migrations.schema_migrations existing
    WHERE existing.version = ${quoteSqlLiteral(update.targetVersion)}
  );`,
    '  GET DIAGNOSTICS updated_count = ROW_COUNT;',
    '  IF updated_count <> 1 THEN',
    `    RAISE EXCEPTION 'Migration ledger reconciliation expected exactly 1 row for %, updated %', ${quoteSqlLiteral(update.localBasename)}, updated_count;`,
    '  END IF;',
    'END;',
    '$ledger_reconcile$;',
  ].join('\n');
}

export function buildTransactionSql(updates: LedgerUpdate[]): string {
  if (updates.length === 0) {
    return '-- No timestamp-format migration ledger rows matched local numeric migrations.';
  }

  return [
    'BEGIN;',
    ...updates.map(buildLedgerUpdateSql),
    'COMMIT;',
  ].join('\n\n');
}

export function parseArgs(argv: string[], env: ParseEnv = process.env): CliOptions {
  let mode: CliMode = 'dry-run';
  let confirmProjectRef: string | undefined;
  let repoRoot = process.cwd();
  let projectRef = env.SUPABASE_PROJECT_REF ?? '';
  const accessToken = env.SUPABASE_ACCESS_TOKEN ?? env.SUPABASE_MANAGEMENT_API_TOKEN ?? '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') {
      mode = 'apply';
    } else if (arg === '--confirm-project-ref') {
      confirmProjectRef = argv[index + 1];
      index += 1;
    } else if (arg === '--project-ref') {
      projectRef = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--repo-root') {
      repoRoot = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (!projectRef) {
    throw new Error('SUPABASE_PROJECT_REF or --project-ref is required.');
  }
  if (!accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN or SUPABASE_MANAGEMENT_API_TOKEN is required.');
  }
  if (!repoRoot) {
    throw new Error('--repo-root must not be empty.');
  }
  if (mode === 'apply') {
    if (!confirmProjectRef) {
      throw new Error('--apply requires --confirm-project-ref <project-ref>.');
    }
    if (confirmProjectRef !== projectRef) {
      throw new Error('--confirm-project-ref does not match SUPABASE_PROJECT_REF / --project-ref.');
    }
  }

  return {
    mode,
    projectRef,
    accessToken,
    repoRoot,
    ...(confirmProjectRef ? { confirmProjectRef } : {}),
  };
}

export async function fetchLedger(projectRef: string, accessToken: string): Promise<LedgerMigrationRow[]> {
  const response = await fetch(
    `${MANAGEMENT_API_BASE_URL}/projects/${encodeURIComponent(projectRef)}/database/migrations`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = await response.json().catch(() => null) as unknown;

  if (!response.ok) {
    throw new Error(`Supabase migration ledger fetch failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  if (!Array.isArray(payload)) {
    throw new Error('Supabase migration ledger fetch returned a non-array payload.');
  }

  return payload.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Invalid migration ledger row: ${JSON.stringify(row)}`);
    }
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.version !== 'string' && typeof candidate.version !== 'number') {
      throw new Error(`Invalid migration ledger row version: ${JSON.stringify(row)}`);
    }
    if (
      candidate.name !== undefined
      && candidate.name !== null
      && typeof candidate.name !== 'string'
    ) {
      throw new Error(`Invalid migration ledger row name: ${JSON.stringify(row)}`);
    }

    return {
      version: String(candidate.version),
      name: candidate.name == null ? null : String(candidate.name),
    };
  });
}

export async function executeSql(projectRef: string, accessToken: string, sql: string): Promise<unknown> {
  const response = await fetch(
    `${MANAGEMENT_API_BASE_URL}/projects/${encodeURIComponent(projectRef)}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const payload = await response.json().catch(() => null) as unknown;

  if (!response.ok) {
    throw new Error(`Supabase SQL execution failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

export async function run(
  options: CliOptions,
  dependencies: ReconcileDependencies = {
    readLocalMigrations,
    fetchLedger,
    executeSql,
  },
): Promise<RunResult> {
  const [localMigrations, ledgerRows] = await Promise.all([
    dependencies.readLocalMigrations(options.repoRoot),
    dependencies.fetchLedger(options.projectRef, options.accessToken),
  ]);
  const plan = buildReconciliationPlan(localMigrations, ledgerRows);
  const sql = buildTransactionSql(plan.updates);

  if (options.mode === 'dry-run' || plan.updates.length === 0) {
    return { updates: plan.updates, sql };
  }

  const applyResult = await dependencies.executeSql(options.projectRef, options.accessToken, sql);
  const verifiedLedgerRows = await dependencies.fetchLedger(options.projectRef, options.accessToken);
  const remainingPlan = buildReconciliationPlan(localMigrations, verifiedLedgerRows);
  if (remainingPlan.updates.length > 0) {
    const remaining = remainingPlan.updates
      .map((update) => update.localBasename)
      .join(', ');
    throw new Error(`Migration ledger reconciliation apply verification failed; pending updates remain: ${remaining}`);
  }

  return { updates: plan.updates, sql, applyResult };
}

function usage(): string {
  return `Usage: tsx scripts/ops/reconcile-migration-ledger.ts [--project-ref <ref>] [--repo-root <path>] [--apply --confirm-project-ref <ref>]

Dry-run is the default. The script reads supabase/migrations/*.sql, fetches the
Supabase production migration ledger, and prints SQL that rewrites timestamp
ledger versions to Arkova's numeric file prefixes when the ledger row name
matches the local migration.`;
}

async function main(): Promise<void> {
  try {
    const result = await run(parseArgs(process.argv.slice(2)));
    console.log(`Migration ledger reconciliation ${result.updates.length === 0 ? 'found no updates.' : `planned ${result.updates.length} update(s).`}`);
    console.log('');
    console.log(result.sql);
    if (result.applyResult) {
      console.log('');
      console.log('Apply completed. Re-run dry-run to verify no updates remain.');
    } else {
      console.log('');
      console.log('Dry run only. Re-run with --apply --confirm-project-ref <ref> to execute.');
    }
  } catch {
    console.error('Migration ledger reconciliation failed. Review the command arguments and Supabase Management API access.');
    process.exit(1);
  }
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  void main();
}
