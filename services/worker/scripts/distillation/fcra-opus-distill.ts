#!/usr/bin/env tsx
/**
 * NVI-07 — FCRA Opus distillation driver (SCRUM-811).
 *
 * Reads FCRA query templates, expands to variations, calls Claude Opus
 * via `createOpusTeacher`, validates against the NVI-01..04 verified-
 * source registry, and writes accepted Q&A pairs to a training JSONL.
 *
 * Usage:
 *   # Dry-run (no API calls — structure-only validation):
 *   npx tsx scripts/distillation/fcra-opus-distill.ts --dry-run
 *
 *   # Live run (spends Anthropic budget):
 *   ANTHROPIC_API_KEY=... npx tsx scripts/distillation/fcra-opus-distill.ts \
 *     --out training-output/nessie-v28-fcra-distilled-train.jsonl \
 *     --limit 50
 *
 * Budget guardrails:
 *   - `--limit N` caps the number of variations sent to the teacher.
 *     Set small for smoke tests; lift for full runs.
 *   - Estimated cost @ Opus 4.7 pricing: ~$0.04 per Q&A pair (system
 *     prompt ~400 tokens + RAG ~800 + answer ~1200). 5,000 pairs ≈ $200.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { DistillationReport, DistilledScenario, TeacherModel } from './types';
import { expandTemplates } from './variation-generator';
import { validateTeacherAnswer, summariseValidations } from './validation-pipeline';
import { FCRA_DISTILL_TEMPLATES } from './fcra-templates';
import { FCRA_SOURCES } from '../intelligence-dataset/sources/fcra-sources';
import { loadRegistry, defaultRegistryPath } from '../intelligence-dataset/validators/verification-registry';
import { toTogetherRow } from '../common/together';
import { pLimit } from '../common/p-limit';

// O(1) lookup — avoids a 91-source linear scan per RAG context build.
const FCRA_SOURCES_BY_ID = new Map(FCRA_SOURCES.map((s) => [s.id, s]));

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Args {
  dryRun: boolean;
  out: string;
  limit: number;
  teacher: 'opus' | 'mock';
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const outIdx = argv.indexOf('--out');
  const limitIdx = argv.indexOf('--limit');
  const concIdx = argv.indexOf('--concurrency');
  return {
    dryRun: argv.includes('--dry-run'),
    out: outIdx >= 0 ? argv[outIdx + 1] : resolve(__dirname, '..', '..', 'training-output', 'nessie-v28-fcra-distilled-train.jsonl'),
    limit: limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : Number.POSITIVE_INFINITY,
    teacher: argv.includes('--dry-run') ? 'mock' : 'opus',
    concurrency: concIdx >= 0 ? parseInt(argv[concIdx + 1], 10) : 8,
  };
}

/** Build RAG context string from the sources referenced by a variation. */
function buildRagContext(sourceIds: string[]): string {
  const lines: string[] = [];
  for (const id of sourceIds) {
    const src = FCRA_SOURCES_BY_ID.get(id);
    if (!src) {
      lines.push(`- ${id}: (not found in FCRA_SOURCES)`);
      continue;
    }
    lines.push(`- record_id: ${src.id}`);
    lines.push(`  source: ${src.source}`);
    lines.push(`  quote: ${src.quote}`);
    if (src.url) lines.push(`  url: ${src.url}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadRegistry(defaultRegistryPath(resolve(__dirname, '..', 'intelligence-dataset')));

  const variations = expandTemplates(FCRA_DISTILL_TEMPLATES);
  const capped = Number.isFinite(args.limit) ? variations.slice(0, args.limit) : variations;

  console.log(`\n🎓 NVI-07 FCRA Opus distillation`);
  console.log(`   templates:    ${FCRA_DISTILL_TEMPLATES.length}`);
  console.log(`   variations:   ${variations.length}`);
  console.log(`   capped to:    ${capped.length}`);
  console.log(`   teacher:      ${args.teacher}${args.dryRun ? ' (dry-run)' : ''}`);
  console.log(`   out:          ${args.out}`);

  // Dry-run uses a stub teacher that echoes the variation back with a
  // well-formed IntelligenceAnswer keyed off the expected sources.
  const teacher: TeacherModel = args.dryRun
    ? {
        name: 'mock-opus-dryrun',
        async infer(v) {
          const primary = v.expectedSources[0] ?? 'fcra-604-a';
          return {
            analysis: `[DRY-RUN] Would call Opus for: ${v.query}`,
            citations: v.expectedSources.map((id) => ({ record_id: id, quote: '(dry-run)', source: id })),
            risks: ['[dry-run risk]'],
            recommendations: ['[dry-run recommendation]'],
            confidence: 0.8,
            jurisdiction: 'federal',
            applicable_law: primary,
          };
        },
      }
    : (await import('./opus-teacher')).createOpusTeacher();

  // Bounded-concurrency fan-out. A 5,000-variation run at ~5s/call is
  // ~7h serial; with 8 concurrent calls it's under an hour. Provider
  // rate limits are the real ceiling — tune via --concurrency.
  const limit = pLimit(args.concurrency);
  const tasks = capped.map((v) =>
    limit(async () => {
      const rag = buildRagContext(v.expectedSources);
      try {
        const answer = await teacher.infer(v, rag);
        return validateTeacherAnswer(v, answer, { registry });
      } catch (err) {
        return {
          variationId: v.id,
          accepted: false,
          reasons: [`teacher error: ${(err as Error).message}`],
          answer: {} as never,
        } as ReturnType<typeof validateTeacherAnswer>;
      }
    }),
  );
  const results = await Promise.all(tasks);
  const accepted: DistilledScenario[] = [];
  for (const [i, r] of results.entries()) {
    if (!r.accepted) continue;
    const v = capped[i];
    accepted.push({
      id: `distilled::${v.id}`,
      category: v.category,
      query: v.query,
      expected: r.answer,
      provenance: 'distilled',
      teacher: teacher.name,
    });
  }

  const summary = summariseValidations(results);
  console.log(`\n📊 Validation:`);
  console.log(`   accepted:  ${summary.accepted}`);
  console.log(`   rejected:  ${results.length - summary.accepted}`);
  for (const [bucket, n] of Object.entries(summary.rejectedByReason)) {
    console.log(`     - ${bucket}: ${n}`);
  }

  const outDir = dirname(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const rows = accepted.map((s) => toTogetherRow(s.query, s.expected));
  writeFileSync(args.out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));

  const report: DistillationReport = {
    generatedAt: new Date().toISOString(),
    teacherModel: teacher.name,
    templateCount: FCRA_DISTILL_TEMPLATES.length,
    variationCount: capped.length,
    accepted: summary.accepted,
    rejectedByReason: summary.rejectedByReason,
    outPath: args.out,
  };
  const reportPath = args.out.replace(/\.jsonl$/, '.report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n✅ Wrote ${rows.length} rows → ${args.out}`);
  console.log(`   report → ${reportPath}`);
}

if (process.argv[1] && process.argv[1].endsWith('fcra-opus-distill.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
