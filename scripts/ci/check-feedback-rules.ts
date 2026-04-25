#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) — feedback rules orchestrator.
 *
 * Loads every `<name>.ts` in scripts/ci/feedback-rules/ as an ES module
 * and invokes its exported `run()`. Runs in-process and in parallel —
 * dropped per-rule child_process spawns from the original implementation
 * (was ~6s wall-clock for 4 rules; now ~1s, single tsx startup).
 *
 * Adding a new rule:
 *   1. Drop a `<rule-name>.ts` file into scripts/ci/feedback-rules/.
 *   2. Export `run(): Promise<RuleResult> | RuleResult` returning
 *      `{ ok: boolean; message: string }`.
 *   3. Use shared helpers from `scripts/ci/lib/ciContext.ts` for env / git.
 *   4. Document the rule in memory/README.md.
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RULES_DIR = resolve(import.meta.dirname, 'feedback-rules');

interface RuleResult {
  ok: boolean;
  message: string;
}

interface RuleModule {
  run: () => Promise<RuleResult> | RuleResult;
}

async function loadRules(): Promise<Array<{ name: string; mod: RuleModule }>> {
  const files = readdirSync(RULES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  return Promise.all(
    files.map(async (f) => ({
      name: f,
      mod: (await import(pathToFileURL(resolve(RULES_DIR, f)).href)) as RuleModule,
    })),
  );
}

async function main(): Promise<void> {
  const rules = await loadRules();
  console.log(`Running ${rules.length} feedback rule(s)...`);

  const results = await Promise.all(
    rules.map(async ({ name, mod }) => {
      try {
        return { name, ...(await mod.run()) };
      } catch (e) {
        return {
          name,
          ok: false,
          message: `Rule threw: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }),
  );

  let failures = 0;
  for (const r of results) {
    const status = r.ok ? '✅' : '❌';
    console.log(`\n${status} ${r.name}`);
    console.log(r.message);
    if (!r.ok) failures++;
  }

  console.log(`\nSummary: ${results.length - failures}/${results.length} rules passed.`);
  if (failures > 0) process.exit(1);
}

void main();
