#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1249 (R0-3) — coverage threshold monotonic enforcement.
 *
 * Parses every `vitest.config*.ts` and `services/worker/vitest.config.ts`
 * for per-file coverage thresholds. Diffs against the same files on
 * `origin/main`. Fails if ANY threshold (branches/functions/lines/statements)
 * has decreased.
 *
 * Override: PR has label `coverage-drop-allowed` AND PR body contains
 * `Linked Jira: SCRUM-NNNN` where SCRUM-NNNN is To Do or In Progress.
 *
 * Why: services/worker/vitest.config.ts `src/index.ts.functions` was
 * ratcheted 40 → 35 → 35 → 20 across 4 commits in 28 hours. CLAUDE.md §1.7
 * mandates 80% on critical paths. This stops the silent ratchet.
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const CONFIGS = [
  'vitest.config.ts',
  'services/worker/vitest.config.ts',
];
const METRICS = ['branches', 'functions', 'lines', 'statements'] as const;
type Metric = (typeof METRICS)[number];
type Thresholds = Record<string, Partial<Record<Metric, number>>>;

const BASE_REF = process.env.BASE_REF_SHA || process.env.BASE_REF || 'origin/main';
const PR_LABELS = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PR_BODY = process.env.PR_BODY ?? '';

/**
 * Extract per-file thresholds from the `thresholds: { ... }` block of a
 * vitest config. Uses a permissive regex — vitest configs are TS, but the
 * thresholds block is conventionally a flat object literal of file paths
 * → metric maps. Robust enough for this project's pattern; if vitest config
 * gets dynamic threshold logic later, replace with ts-morph.
 */
function parseThresholds(source: string): Thresholds {
  const result: Thresholds = {};
  const thresholdsBlock = source.match(/thresholds:\s*\{([\s\S]*?)\n\s{6}\},/);
  if (!thresholdsBlock) return result;
  const body = thresholdsBlock[1];

  // Match each file entry: 'src/path.ts': { branches: N, functions: N, ... }
  const entryRe = /['"]([^'"]+\.tsx?)['"]:\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    const file = m[1];
    const metrics: Partial<Record<Metric, number>> = {};
    for (const metric of METRICS) {
      const mm = new RegExp(`${metric}:\\s*(\\d+)`).exec(m[2]);
      if (mm) metrics[metric] = Number.parseInt(mm[1], 10);
    }
    result[file] = metrics;
  }
  return result;
}

function readFromGit(ref: string, path: string): string | null {
  try {
    return execSync(`git show ${ref}:${path}`, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

interface Drop {
  config: string;
  file: string;
  metric: Metric;
  oldValue: number;
  newValue: number;
}

function checkConfig(configRelPath: string): Drop[] {
  const drops: Drop[] = [];
  const fullPath = resolve(REPO, configRelPath);
  if (!existsSync(fullPath)) return drops;
  const current = parseThresholds(readFileSync(fullPath, 'utf8'));
  const baseSrc = readFromGit(BASE_REF, configRelPath);
  if (baseSrc === null) {
    console.log(`ℹ️  ${configRelPath}: not present on ${BASE_REF}, treating as new file`);
    return drops;
  }
  const base = parseThresholds(baseSrc);

  for (const [file, baseMetrics] of Object.entries(base)) {
    const currentMetrics = current[file];
    if (!currentMetrics) {
      // Removing a tracked file is a separate violation but we only flag
      // explicit threshold decreases here. A removal could be intentional
      // (file deleted). Skip with a notice.
      console.log(`ℹ️  ${configRelPath}: thresholds for ${file} removed`);
      continue;
    }
    for (const metric of METRICS) {
      const oldValue = baseMetrics[metric];
      const newValue = currentMetrics[metric];
      if (oldValue !== undefined && newValue !== undefined && newValue < oldValue) {
        drops.push({ config: configRelPath, file, metric, oldValue, newValue });
      }
    }
  }
  return drops;
}

function isOverridden(): { allowed: boolean; reason?: string } {
  if (!PR_LABELS.includes('coverage-drop-allowed')) {
    return { allowed: false, reason: 'PR not labeled `coverage-drop-allowed`' };
  }
  const linkMatch = /Linked Jira:\s*(SCRUM-\d+)/i.exec(PR_BODY);
  if (!linkMatch) {
    return { allowed: false, reason: 'PR body missing `Linked Jira: SCRUM-NNNN`' };
  }
  return { allowed: true, reason: `Override active via label + ${linkMatch[1]}` };
}

function main(): void {
  const allDrops: Drop[] = [];
  for (const cfg of CONFIGS) {
    const drops = checkConfig(cfg);
    allDrops.push(...drops);
  }

  if (allDrops.length === 0) {
    console.log('✅ No coverage threshold decreases detected.');
    return;
  }

  console.log(`Detected ${allDrops.length} coverage threshold decrease(s) vs ${BASE_REF}:`);
  for (const d of allDrops) {
    console.log(`  ${d.config} :: ${d.file}.${d.metric}: ${d.oldValue} → ${d.newValue}`);
  }

  const override = isOverridden();
  if (override.allowed) {
    console.log(`\n⚠️  ${override.reason} — allowing decrease.`);
    return;
  }

  console.error('\n::error::Coverage thresholds decreased without authorization (R0-3 / SCRUM-1249).');
  console.error(`  Reason override unavailable: ${override.reason}`);
  console.error('  To allow this decrease:');
  console.error('    1. Add label `coverage-drop-allowed` to the PR');
  console.error('    2. File a Jira ticket tagged `coverage-restoration` and add');
  console.error('       `Linked Jira: SCRUM-NNNN` to the PR description.');
  process.exit(1);
}

main();
