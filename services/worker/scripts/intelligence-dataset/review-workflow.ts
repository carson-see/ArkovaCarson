/**
 * NVI-05 — Attorney-review workflow (SCRUM-809).
 *
 * Reads the NVI verification registry (verification-status.json produced by
 * `validators/verify-sources.ts`) and classifies every failing or orphaned
 * source into one of three review tiers:
 *
 *   Tier 1 — Mechanical fix, no attorney needed.
 *     A dataset maintainer can fix by pasting the canonical statute section
 *     text or by substituting the missing section-number reference. Soft
 *     failures (missing reporter cite etc.) also land here.
 *
 *   Tier 2 — LLM-assisted review (Claude Opus + GPT-4o consensus).
 *     Agency-bulletin hard-fails and similar format-level failures where
 *     the judgement call ("is this really a CFPB bulletin?") can be made
 *     from the source text without attorney expertise.
 *
 *   Tier 3 — Attorney review.
 *     Case-law interpretation, state overlay edge cases, and any source
 *     that no validator claimed (orphans) — a lawyer must decide whether
 *     the citation is valid, proposed-fix wording is accurate, and the
 *     scenario analysis built on top is defensible.
 *
 * The CLI emits a directory of packets:
 *
 *   out/
 *     tier1-mechanical.md         — single-file summary, one line per source
 *     tier2-llm-assisted.md       — single-file summary, grouped by validator
 *     tier3-attorney/
 *       <source-id>.md            — one packet per Tier-3 source
 *     index.md                    — counts + routing summary
 *
 * The Tier 3 packets are designed to be uploaded to Google Docs or Notion
 * for the external FCRA compliance attorney to review. Each packet has:
 *   - the source ID and original registry entry
 *   - every failing validator's notes
 *   - the proposed fix (if mechanical substitution would work)
 *   - the attorney question ("Does this cite support the training
 *     scenarios it anchors?")
 *
 * See `docs/plans/nessie-attorney-review-process.md` for the full process
 * (tier definitions, attorney engagement scope, budget, SLA).
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { RegistryEntry, Registry } from './validators/verification-registry';
import { loadRegistry, defaultRegistryPath } from './validators/verification-registry';
import type { VerificationResult, ValidatorKind } from './validators/types';

export type ReviewTier = 1 | 2 | 3;

export interface ReviewDecision {
  sourceId: string;
  tier: ReviewTier | null; // null = passes, no routing
  reasons: string[];
  results: VerificationResult[];
}

/** Validators whose hard-failures need attorney judgement. */
const TIER3_VALIDATORS: ReadonlySet<ValidatorKind> = new Set(['case-law', 'state-statute']);

/**
 * Decide the review tier for a single source given its registry entry.
 * Pure function; no I/O. Tested in review-workflow.test.ts.
 */
export function classifyEntry(sourceId: string, entry: RegistryEntry): ReviewDecision {
  // Passing entries don't need routing.
  if (entry.overallPassed && !entry.orphaned) {
    return { sourceId, tier: null, reasons: ['verified — no routing needed'], results: entry.results };
  }

  const reasons: string[] = [];

  // Orphans always need human eyes — no validator claimed them, so the
  // source type itself is ambiguous.
  if (entry.orphaned) {
    reasons.push('orphan: no validator claimed this source');
    return { sourceId, tier: 3, reasons, results: entry.results };
  }

  const failing = entry.results.filter((r) => !r.passed);
  const hardFails = failing.filter((r) => r.hardFail);

  // Soft-fail-only: mechanical. Missing reporter cite on a case that
  // otherwise checks out, trailing whitespace, etc.
  if (hardFails.length === 0 && failing.length > 0) {
    reasons.push(`${failing.length} soft warning(s): ${summarise(failing)}`);
    return { sourceId, tier: 1, reasons, results: entry.results };
  }

  // Any case-law / state-statute hard-fail → Tier 3.
  const needsAttorney = hardFails.some((r) => TIER3_VALIDATORS.has(r.validator));
  if (needsAttorney) {
    reasons.push(`attorney-scope validator hard-failed: ${summarise(hardFails)}`);
    return { sourceId, tier: 3, reasons, results: entry.results };
  }

  // Statute-quote hard-fails are mechanical — substitute real statute text.
  const onlyStatuteQuote = hardFails.every((r) => r.validator === 'statute-quote');
  if (onlyStatuteQuote) {
    reasons.push(`statute-quote hard fail (mechanical fix): ${summarise(hardFails)}`);
    return { sourceId, tier: 1, reasons, results: entry.results };
  }

  // Everything else (agency-bulletin etc.) → Tier 2.
  reasons.push(`LLM-assisted review candidate: ${summarise(hardFails)}`);
  return { sourceId, tier: 2, reasons, results: entry.results };
}

function summarise(results: VerificationResult[]): string {
  return results.map((r) => `[${r.validator}] ${truncate(r.notes, 100)}`).join('; ');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export interface ReviewBuckets {
  tier1: ReviewDecision[];
  tier2: ReviewDecision[];
  tier3: ReviewDecision[];
  passed: string[];
}

/** Classify every entry in a registry and bucket into tiers. */
export function classifyRegistry(reg: Registry): ReviewBuckets {
  const buckets: ReviewBuckets = { tier1: [], tier2: [], tier3: [], passed: [] };
  for (const [id, entry] of Object.entries(reg.sources)) {
    const decision = classifyEntry(id, entry);
    if (decision.tier === null) {
      buckets.passed.push(id);
      continue;
    }
    if (decision.tier === 1) buckets.tier1.push(decision);
    else if (decision.tier === 2) buckets.tier2.push(decision);
    else buckets.tier3.push(decision);
  }
  return buckets;
}

/** Render a one-line Tier 1 summary entry. */
export function renderTier1Summary(d: ReviewDecision): string {
  return `- \`${d.sourceId}\` — Tier 1 (mechanical): ${d.reasons.join(' | ')}`;
}

/** Render a one-line Tier 2 summary entry (includes validator name). */
export function renderTier2Summary(d: ReviewDecision): string {
  const validators = Array.from(new Set(d.results.filter((r) => !r.passed).map((r) => r.validator))).join(', ');
  return `- \`${d.sourceId}\` — Tier 2 (LLM-assisted, ${validators || 'none'}): ${d.reasons.join(' | ')}`;
}

/** Render a full attorney-packet markdown for a Tier 3 decision. */
export function renderTier3Packet(d: ReviewDecision): string {
  const lines: string[] = [];
  lines.push(`# Attorney Review — ${d.sourceId}`);
  lines.push('');
  lines.push(`**Tier 3** — attorney review required.`);
  lines.push('');
  lines.push('## Why this source was routed');
  for (const r of d.reasons) lines.push(`- ${r}`);
  lines.push('');
  lines.push('## Validator results');
  if (d.results.length === 0) {
    lines.push('- _no validator claimed this source (orphan)_');
  } else {
    for (const r of d.results) {
      const verdict = r.passed ? '✅ passed' : r.hardFail ? '❌ HARD FAIL' : '⚠️ soft warning';
      lines.push(`- **${r.validator}** — ${verdict}: ${r.notes}`);
    }
  }
  lines.push('');
  lines.push('## Proposed fix');
  lines.push('_Dataset maintainer fills this in before sending to counsel._');
  lines.push('');
  lines.push('```');
  lines.push('(paste proposed corrected quote / citation here)');
  lines.push('```');
  lines.push('');
  lines.push('## Attorney question');
  lines.push('1. Does the cited authority actually support the scenario analysis that relies on this source?');
  lines.push('2. If no, what is the correct authority (or is the scenario itself wrong)?');
  lines.push('3. Any jurisdictional caveats (circuit split, state overlay) we must surface in the model answer?');
  lines.push('');
  lines.push('## Attorney verdict');
  lines.push('- [ ] Approved as-is');
  lines.push('- [ ] Approved with modification (see below)');
  lines.push('- [ ] Rejected — remove from training data');
  lines.push('');
  lines.push('**Notes:**');
  lines.push('');
  return lines.join('\n') + '\n';
}

function renderIndex(b: ReviewBuckets, registryLastRun: string): string {
  const total = b.tier1.length + b.tier2.length + b.tier3.length + b.passed.length;
  const lines: string[] = [];
  lines.push(`# NVI Review Workflow — Routing Summary`);
  lines.push('');
  lines.push(`Registry last run: ${registryLastRun}`);
  lines.push(`Total sources: ${total}`);
  lines.push('');
  lines.push(`| Tier | Count | Description |`);
  lines.push(`|------|-------|-------------|`);
  lines.push(`| passed | ${b.passed.length} | verified, no routing |`);
  lines.push(`| Tier 1 | ${b.tier1.length} | mechanical fix — dataset maintainer |`);
  lines.push(`| Tier 2 | ${b.tier2.length} | LLM consensus review (Claude Opus + GPT-4o) |`);
  lines.push(`| Tier 3 | ${b.tier3.length} | attorney review |`);
  lines.push('');
  lines.push(`See:`);
  lines.push(`- \`tier1-mechanical.md\``);
  lines.push(`- \`tier2-llm-assisted.md\``);
  lines.push(`- \`tier3-attorney/<source-id>.md\``);
  lines.push('');
  return lines.join('\n') + '\n';
}

function renderTier1File(decisions: ReviewDecision[]): string {
  const lines = ['# Tier 1 — Mechanical fixes', ''];
  if (decisions.length === 0) lines.push('_None._');
  else for (const d of decisions) lines.push(renderTier1Summary(d));
  return lines.join('\n') + '\n';
}

function renderTier2File(decisions: ReviewDecision[]): string {
  const lines = ['# Tier 2 — LLM-assisted review (Claude Opus + GPT-4o consensus)', ''];
  if (decisions.length === 0) lines.push('_None._');
  else for (const d of decisions) lines.push(renderTier2Summary(d));
  return lines.join('\n') + '\n';
}

export interface WriteOpts {
  outDir: string;
  registryLastRun: string;
}

/** Write every packet + summary file under outDir. Creates directories as needed. */
export function writeReviewOutput(b: ReviewBuckets, opts: WriteOpts): void {
  const { outDir, registryLastRun } = opts;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'index.md'), renderIndex(b, registryLastRun));
  writeFileSync(resolve(outDir, 'tier1-mechanical.md'), renderTier1File(b.tier1));
  writeFileSync(resolve(outDir, 'tier2-llm-assisted.md'), renderTier2File(b.tier2));
  const tier3Dir = resolve(outDir, 'tier3-attorney');
  if (!existsSync(tier3Dir)) mkdirSync(tier3Dir, { recursive: true });
  for (const d of b.tier3) {
    writeFileSync(resolve(tier3Dir, `${d.sourceId}.md`), renderTier3Packet(d));
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs(argv: string[]): { registry: string | null; out: string } {
  const regIdx = argv.indexOf('--registry');
  const outIdx = argv.indexOf('--out');
  return {
    registry: regIdx >= 0 ? argv[regIdx + 1] : null,
    out: outIdx >= 0 ? argv[outIdx + 1] : resolve(__dirname, '..', '..', 'out', 'nvi-review'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryPath = args.registry ?? defaultRegistryPath(__dirname);
  const reg = loadRegistry(registryPath);
  const buckets = classifyRegistry(reg);
  writeReviewOutput(buckets, { outDir: args.out, registryLastRun: reg.lastRun });
  console.log(`📦 NVI review workflow`);
  console.log(`   registry: ${registryPath}`);
  console.log(`   out:      ${args.out}`);
  console.log(`   Tier 1:   ${buckets.tier1.length}`);
  console.log(`   Tier 2:   ${buckets.tier2.length}`);
  console.log(`   Tier 3:   ${buckets.tier3.length}`);
  console.log(`   passed:   ${buckets.passed.length}`);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('review-workflow.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
