#!/usr/bin/env tsx
/**
 * SCRUM-1258 (R1-4) — env-var inventory + ENV.md gap report.
 *
 * Walks `services/worker/src/**\/*.ts` (skipping `.test.ts`), extracts
 * every `process.env.X` identifier, then cross-checks against:
 *   1. `docs/reference/ENV.md` (the human-curated reference)
 *   2. `services/worker/src/config.ts` (the Zod schema)
 *
 * Emits a categorized markdown report listing:
 *   - vars referenced in code but undocumented in ENV.md
 *   - vars referenced in code but absent from ConfigSchema
 *   - vars documented in ENV.md but never read in code (dead docs)
 *
 * The full SCRUM-1258 scope (Zod expansion, ad-hoc-read CI lint,
 * Cloud Run cross-check) ships in a follow-up. This script is the
 * inventory tool the rest of the work needs as a baseline.
 *
 * Usage:
 *   npx tsx services/worker/scripts/audit-env-vars.ts
 *   npx tsx services/worker/scripts/audit-env-vars.ts --json   # CI form
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const WORKER_SRC = join(REPO_ROOT, 'services/worker/src');
const ENV_MD = join(REPO_ROOT, 'docs/reference/ENV.md');
const CONFIG_TS = join(REPO_ROOT, 'services/worker/src/config.ts');

const ENV_REGEX = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

async function* walkTs(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkTs(full);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      yield full;
    }
  }
}

async function collectCodeVars(): Promise<Set<string>> {
  const found = new Set<string>();
  for await (const path of walkTs(WORKER_SRC)) {
    const src = await readFile(path, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = ENV_REGEX.exec(src)) !== null) {
      found.add(match[1]);
    }
    ENV_REGEX.lastIndex = 0;
  }
  return found;
}

async function collectEnvMdVars(): Promise<Set<string>> {
  try {
    const md = await readFile(ENV_MD, 'utf8');
    const found = new Set<string>();
    // ENV.md uses two formats: bash blocks of the form `VAR=...` and
    // inline backticks. Catch both.
    for (const match of md.matchAll(/^([A-Z][A-Z0-9_]{2,})\s*=/gm)) {
      found.add(match[1]);
    }
    for (const match of md.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
      found.add(match[1]);
    }
    return found;
  } catch {
    return new Set();
  }
}

async function collectConfigSchemaVars(): Promise<Set<string>> {
  try {
    const src = await readFile(CONFIG_TS, 'utf8');
    const found = new Set<string>();
    for (const match of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      found.add(match[1]);
    }
    return found;
  } catch {
    return new Set();
  }
}

interface Report {
  total_in_code: number;
  total_in_env_md: number;
  total_in_config_schema: number;
  in_code_missing_from_env_md: string[];
  in_code_missing_from_config_schema: string[];
  in_env_md_unused_in_code: string[];
}

async function buildReport(): Promise<Report> {
  const [code, envMd, schema] = await Promise.all([
    collectCodeVars(),
    collectEnvMdVars(),
    collectConfigSchemaVars(),
  ]);

  const missingFromEnvMd = [...code].filter((v) => !envMd.has(v)).sort();
  const missingFromSchema = [...code].filter((v) => !schema.has(v)).sort();
  const deadInEnvMd = [...envMd].filter((v) => !code.has(v)).sort();

  return {
    total_in_code: code.size,
    total_in_env_md: envMd.size,
    total_in_config_schema: schema.size,
    in_code_missing_from_env_md: missingFromEnvMd,
    in_code_missing_from_config_schema: missingFromSchema,
    in_env_md_unused_in_code: deadInEnvMd,
  };
}

function formatMarkdown(report: Report): string {
  const lines: string[] = [
    '# SCRUM-1258 env-var inventory',
    '',
    `- **process.env.X identifiers in worker source**: ${report.total_in_code}`,
    `- **Vars documented in docs/reference/ENV.md**: ${report.total_in_env_md}`,
    `- **Vars present in services/worker/src/config.ts ConfigSchema**: ${report.total_in_config_schema}`,
    '',
    `## ${report.in_code_missing_from_env_md.length} vars referenced in code but missing from ENV.md`,
    '',
  ];
  for (const v of report.in_code_missing_from_env_md) lines.push(`- \`${v}\``);
  lines.push('');
  lines.push(
    `## ${report.in_code_missing_from_config_schema.length} vars referenced in code but absent from ConfigSchema`,
  );
  lines.push('');
  for (const v of report.in_code_missing_from_config_schema) lines.push(`- \`${v}\``);
  lines.push('');
  lines.push(
    `## ${report.in_env_md_unused_in_code.length} vars documented in ENV.md but unreferenced in code (candidate dead docs)`,
  );
  lines.push('');
  for (const v of report.in_env_md_unused_in_code) lines.push(`- \`${v}\``);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const report = await buildReport();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatMarkdown(report));
  }
}

// Direct-execute guard so this file can also be imported by CI scripts
// without auto-running.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('audit-env-vars.ts');
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { buildReport, formatMarkdown };
export type { Report };
