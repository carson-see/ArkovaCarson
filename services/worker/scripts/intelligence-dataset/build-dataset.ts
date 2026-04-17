#!/usr/bin/env tsx
/**
 * build-dataset.ts — compile scenarios into Together-format JSONL.
 *
 * Usage:
 *   npx tsx scripts/intelligence-dataset/build-dataset.ts --regulation fcra --version v27.1
 *   npx tsx scripts/intelligence-dataset/build-dataset.ts --regulation hipaa --version v28.0
 *   npx tsx scripts/intelligence-dataset/build-dataset.ts --regulation ferpa --version v29.0
 *
 * For each regulation, this script:
 *   1. Loads sources + scenarios from scripts/intelligence-dataset/{sources,scenarios}
 *   2. Validates the dataset (every citation has a source, no empty risks,
 *      no duplicates, no near-paraphrase leakage)
 *   3. Emits train/test JSONL files to training-output/
 *   4. Emits a manifest with coverage stats
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import type {
  RegulationDataset, IntelligenceScenario, TogetherTrainingRow, DatasetManifest,
} from './types';
import { splitBalanced } from './split';
import { validateDataset, findUncitedSources } from './validate';
import { toTogetherRow } from '../common/together';
import {
  defaultRegistryPath, loadRegistry, decideTrust,
} from './validators/verification-registry';
import { scaffoldCot, mergeCotIntoAnswer } from './cot-scaffold';
import { multiTurnToTogetherRow, validateMultiTurnScenario, type MultiTurnScenario } from './multi-turn';
import { FCRA_MULTI_TURN_SCENARIOS } from './scenarios/fcra/multi-turn';
import {
  buildCorpusIndex,
  documentGroundedToTogetherRow,
  validateDocumentGroundedScenario,
  type DocumentGroundedScenario,
} from './document-grounded';
import { FCRA_DOCUMENT_CORPUS } from './documents/fcra-corpus';
import { FCRA_DOC_GROUNDED_SCENARIOS } from './scenarios/fcra/document-grounded';

import { FCRA_SOURCES } from './sources/fcra-sources';
import { HIPAA_SOURCES } from './sources/hipaa-sources';
import { FERPA_SOURCES } from './sources/ferpa-sources';

// FCRA scenarios
import { PRE_ADVERSE_SCENARIOS } from './scenarios/fcra/pre-adverse-action';
import { ADVERSE_ACTION_SCENARIOS } from './scenarios/fcra/adverse-action-notices';
import { PERMISSIBLE_PURPOSE_SCENARIOS } from './scenarios/fcra/permissible-purpose';
import { DISPUTES_SCENARIOS, REPORTING_LIMITS_SCENARIOS } from './scenarios/fcra/disputes-and-reporting-limits';
import { STATE_VARIATIONS_SCENARIOS } from './scenarios/fcra/state-variations';
import { RISK_PATTERN_SCENARIOS } from './scenarios/fcra/risk-patterns';
import { CREDENTIAL_SPECIFIC_SCENARIOS } from './scenarios/fcra/credential-specific';
import { RISK_PATTERNS_EXPANSION } from './scenarios/fcra/v27-3-risk-patterns-expansion';
import { ADVERSE_EXPANSION } from './scenarios/fcra/v27-3-adverse-expansion';
import { MULTI_REG_EXPANSION } from './scenarios/fcra/v27-4-multi-reg-expansion';
import { FCRA_ADVERSARIAL_INDEX } from './scenarios/fcra/adversarial';
import { validateAdversarialAnswer } from './adversarial';
import { ensureHeldOut as ensureBenchmarkHeldOut, validateBenchmark } from './benchmark/benchmark';
import { FCRA_GOLD_STANDARD_BENCHMARK } from './benchmark/fcra-gold-standard';
import { evaluateFcraMasteryGate, renderGateStatusMarkdown } from './gate';

// HIPAA scenarios
import { HIPAA_PRIVACY_SCENARIOS } from './scenarios/hipaa/privacy-and-patient-rights';
import { HIPAA_SECURITY_BREACH_BA_SCENARIOS } from './scenarios/hipaa/security-breach-ba';
import { HIPAA_CREDENTIAL_SCENARIOS } from './scenarios/hipaa/credential-verification';

// FERPA scenarios
import { FERPA_SCENARIOS } from './scenarios/ferpa/ferpa-core';
import { FERPA_ADVANCED_SCENARIOS } from './scenarios/ferpa/ferpa-advanced';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUTPUT_DIR = resolve(__dirname, '..', '..', 'training-output');

/** Inputs for the closed-gate advisory warning on non-FCRA builds. Reflects
 *  the snapshot documented in docs/plans/nessie-fcra-mastery-gate.md. */
const CLOSED_GATE_PLACEHOLDER = {
  verification: { total: 1, passing: 0, orphans: 1, hardFails: 0 },
  attorneyReview: { tier3Open: 27, tier3Resolved: 0 },
  chainOfThought: { scenariosWithCot: 0, scenariosTotal: 302 },
  distillation: { acceptedQa: 0, target: 5000 },
  auxiliary: { multiTurn: 12, documentGrounded: 9, adversarial: 15 },
  benchmark: { attorneyQuestions: 2, nessieScorePercent: 0, geminiBaselinePercent: 70 },
  canary: { reviewedResponses: 0, matchRatePercent: 0 },
} as const;

// ---------------------------------------------------------------------------
// Dataset assembly per regulation
// ---------------------------------------------------------------------------

function buildFcraDataset(version: string): RegulationDataset {
  const scenarios: IntelligenceScenario[] = [
    ...PRE_ADVERSE_SCENARIOS,
    ...ADVERSE_ACTION_SCENARIOS,
    ...PERMISSIBLE_PURPOSE_SCENARIOS,
    ...DISPUTES_SCENARIOS,
    ...REPORTING_LIMITS_SCENARIOS,
    ...STATE_VARIATIONS_SCENARIOS,
    ...RISK_PATTERN_SCENARIOS,
    ...CREDENTIAL_SPECIFIC_SCENARIOS,
    ...RISK_PATTERNS_EXPANSION,
    ...ADVERSE_EXPANSION,
    ...MULTI_REG_EXPANSION,
    ...FCRA_ADVERSARIAL_INDEX,
  ];

  return {
    regulation: 'FCRA',
    version,
    sources: FCRA_SOURCES,
    scenarios,
    categories: [
      { id: 'pre-adverse',          name: 'Pre-Adverse Action',        targetCount: 25 },
      { id: 'adverse-action',       name: 'Adverse Action Notices',    targetCount: 25 },
      { id: 'permissible-purpose',  name: 'Permissible Purpose',       targetCount: 20 },
      { id: 'disputes',             name: 'Disputes + Reinvestigation', targetCount: 20 },
      { id: 'reporting-limits',     name: 'Reporting Limits',           targetCount: 15 },
      { id: 'state-variations',     name: 'State Variations',           targetCount: 30 },
      { id: 'risk-patterns',        name: 'Risk Patterns',              targetCount: 35 },
      { id: 'medical-license',      name: 'Medical Licensure',          targetCount: 15 },
      { id: 'education-verification', name: 'Education Verification',   targetCount: 15 },
      { id: 'e-verify',             name: 'E-Verify / I-9',             targetCount: 5  },
      { id: 'eeoc-overlap',         name: 'EEOC Title VII Overlap',     targetCount: 5  },
    ],
  };
}

function buildHipaaDataset(version: string): RegulationDataset {
  const scenarios: IntelligenceScenario[] = [
    ...HIPAA_PRIVACY_SCENARIOS,
    ...HIPAA_SECURITY_BREACH_BA_SCENARIOS,
    ...HIPAA_CREDENTIAL_SCENARIOS,
  ];

  return {
    regulation: 'HIPAA',
    version,
    sources: HIPAA_SOURCES,
    scenarios,
    categories: [
      { id: 'privacy-rule',        name: 'Privacy Rule',            targetCount: 20 },
      { id: 'patient-rights',      name: 'Patient Rights',          targetCount: 10 },
      { id: 'security-rule',       name: 'Security Rule',           targetCount: 15 },
      { id: 'breach-rule',         name: 'Breach Notification',     targetCount: 8  },
      { id: 'business-associate',  name: 'Business Associates',     targetCount: 8  },
    ],
  };
}

function buildFerpaDataset(version: string): RegulationDataset {
  return {
    regulation: 'FERPA',
    version,
    sources: FERPA_SOURCES,
    scenarios: [...FERPA_SCENARIOS, ...FERPA_ADVANCED_SCENARIOS],
    categories: [
      { id: 'consent',               name: 'Consent + Eligible Student',   targetCount: 7 },
      { id: 'directory-info',        name: 'Directory Information',         targetCount: 5 },
      { id: 'disclosure-exceptions', name: 'Disclosure Exceptions',         targetCount: 8 },
      { id: 'access-amendment',      name: 'Access + Amendment',            targetCount: 5 },
      { id: 'disclosure-log',        name: 'Disclosure Log',                targetCount: 3 },
      { id: 'emergency-disclosure',  name: 'Health/Safety Emergency',       targetCount: 2 },
      { id: 'state-overlay',         name: 'State Overlays (NY/CA/IL)',     targetCount: 4 },
      { id: 'enforcement',           name: 'FPCO Enforcement',              targetCount: 3 },
      { id: 'hipaa-boundary',        name: 'FERPA-HIPAA Boundary',          targetCount: 2 },
      { id: 'vendor-contracts',      name: 'Vendor Data-Sharing Contracts', targetCount: 3 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Together-format emission
// ---------------------------------------------------------------------------

function scenarioToTogetherRow(s: IntelligenceScenario, opts: { cot: boolean } = { cot: true }): TogetherTrainingRow {
  // NVI-06: attach chain-of-thought unless explicitly disabled. The
  // scaffolder is deterministic + offline, so this costs no API budget.
  const answer = opts.cot
    ? mergeCotIntoAnswer(s.expected, s.expected.reasoning_steps ?? scaffoldCot(s))
    : s.expected;
  return toTogetherRow(s.query, answer);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const regIdx = args.indexOf('--regulation');
  const verIdx = args.indexOf('--version');

  const regulation = regIdx >= 0 ? args[regIdx + 1] : null;
  const version = verIdx >= 0 ? args[verIdx + 1] : null;
  // NVI-06: chain-of-thought emission in training JSONL. Default ON.
  // Pass `--no-cot` to reproduce v27.3 / earlier training format exactly.
  const cotEnabled = !args.includes('--no-cot');

  if (!regulation || !version) {
    console.error('Usage: --regulation fcra|hipaa|ferpa --version v27.1|v28.0|v29.0');
    process.exit(1);
  }

  let dataset: RegulationDataset;
  switch (regulation.toLowerCase()) {
    case 'fcra':  dataset = buildFcraDataset(version); break;
    case 'hipaa': dataset = buildHipaaDataset(version); break;
    case 'ferpa': dataset = buildFerpaDataset(version); break;
    default:
      console.error(`Unknown regulation: ${regulation}`);
      process.exit(1);
  }

  console.log(`\n📚 Building Nessie ${dataset.regulation} ${dataset.version} intelligence dataset...`);
  console.log(`   Sources: ${dataset.sources.length}`);
  console.log(`   Scenarios: ${dataset.scenarios.length}`);

  // NVI-14 advisory: warn when building non-FCRA while the gate is closed.
  if (dataset.regulation !== 'FCRA') {
    const gateEval = evaluateFcraMasteryGate(CLOSED_GATE_PLACEHOLDER);
    if (!gateEval.passes) {
      console.warn(`\n🛑 NVI-14 FCRA Mastery Gate is CLOSED — building ${dataset.regulation} while FCRA is pre-mastery.`);
      console.warn(`   CLAUDE.md §0 NVI Gate Mandate applies. This build is permitted only for bug-fixes to already-deployed v28/v29 endpoints (per quarantine policy).`);
      console.warn(renderGateStatusMarkdown(gateEval).replace(/^/gm, '   '));
    }
  }

  // ─── Validation ───
  const report = validateDataset(dataset);
  console.log(`\n🔍 Validation:`);
  console.log(`   Errors: ${report.errors.length}`);
  console.log(`   Warnings: ${report.warnings.length}`);
  if (report.errors.length > 0) {
    console.log(`\n❌ Errors:`);
    for (const e of report.errors.slice(0, 20)) console.log(`   - ${e}`);
    if (report.errors.length > 20) console.log(`   ... (${report.errors.length - 20} more)`);
    process.exit(2);
  }
  if (report.warnings.length > 0) {
    console.log(`\n⚠️  Warnings (non-fatal):`);
    for (const w of report.warnings.slice(0, 10)) console.log(`   - ${w}`);
    if (report.warnings.length > 10) console.log(`   ... (${report.warnings.length - 10} more)`);
  }

  const uncited = findUncitedSources(dataset);
  if (uncited.length > 0) {
    console.log(`\n📎 Uncited sources (${uncited.length}) — consider adding scenarios or removing sources:`);
    for (const s of uncited.slice(0, 10)) console.log(`   - ${s.id} (${s.source})`);
  }

  // NVI-10: adversarial humility-contract check. When any scenario carries
  // should_refuse=true the answer must satisfy confidence≤0.70 +
  // escalation_trigger=true + an escalation-style recommendation. Fail the
  // build hard on mismatch so the training signal stays consistent.
  const advErrors: string[] = [];
  for (const sc of dataset.scenarios) {
    const errs = validateAdversarialAnswer(sc.expected);
    for (const e of errs) advErrors.push(`${sc.id}: ${e}`);
  }
  if (advErrors.length > 0) {
    console.error(`\n❌ Adversarial (NVI-10) contract violations:`);
    for (const e of advErrors.slice(0, 20)) console.error(`   - ${e}`);
    if (advErrors.length > 20) console.error(`   ... (${advErrors.length - 20} more)`);
    process.exit(7);
  }

  // NVI-11: FCRA gold-standard benchmark held-out guard. Any scenario id
  // that collides with the benchmark contaminates the measurement.
  if (dataset.regulation === 'FCRA') {
    const benchErrs = validateBenchmark(FCRA_GOLD_STANDARD_BENCHMARK);
    if (benchErrs.length > 0) {
      console.error(`\n❌ Benchmark (NVI-11) validation failed:`);
      for (const e of benchErrs) console.error(`   - ${e}`);
      process.exit(8);
    }
    try {
      ensureBenchmarkHeldOut(FCRA_GOLD_STANDARD_BENCHMARK, dataset.scenarios);
    } catch (err) {
      console.error(`\n❌ Benchmark (NVI-11) held-out violation: ${(err as Error).message}`);
      process.exit(8);
    }
    console.log(`\n🎯 Benchmark (NVI-11): ${FCRA_GOLD_STANDARD_BENCHMARK.length} held-out questions verified`);
  }

  // ─── NVI-18 CI guard: block emission if any cited source is untrusted ───
  // A cited source is trusted iff the verification registry has a current
  // passing entry (NVI-01..04) for it. Unverified / failing / stale entries
  // are BLOCKERS — we refuse to produce training JSONL that cites them.
  //
  // Override: set NVI_SKIP_GUARD=1 to emit anyway. This is a deliberate
  // escape hatch (e.g. experimenting on a disposable endpoint) — CI must
  // NOT set it.
  const skipGuard = process.env.NVI_SKIP_GUARD === '1';
  const intelDir = resolve(__dirname);
  const registryPath = defaultRegistryPath(intelDir);
  let registry;
  try {
    registry = loadRegistry(registryPath);
  } catch (err) {
    console.error(`\n💥 NVI CI guard: cannot load verification registry at ${registryPath}: ${(err as Error).message}`);
    console.error('   Run: npx tsx scripts/intelligence-dataset/validators/verify-sources.ts');
    if (!skipGuard) process.exit(3);
    registry = null;
  }

  const citedIds = new Set<string>();
  for (const sc of dataset.scenarios) {
    for (const c of sc.expected.citations) citedIds.add(c.record_id);
  }

  if (registry) {
    const decisions = decideTrust(registry, Array.from(citedIds), { maxAgeDays: 90 });
    const untrusted = decisions.filter((d) => !d.trusted);
    console.log(`\n🛡  NVI CI guard (90-day freshness window):`);
    console.log(`   cited sources:     ${citedIds.size}`);
    console.log(`   trusted:           ${decisions.length - untrusted.length}`);
    console.log(`   untrusted:         ${untrusted.length}`);
    if (untrusted.length > 0) {
      console.log(`\n❌ Cannot emit training JSONL — the following cited sources are not trusted:`);
      for (const d of untrusted.slice(0, 20)) {
        console.log(`   - ${d.sourceId}: ${d.reason}`);
      }
      if (untrusted.length > 20) console.log(`   ... (${untrusted.length - 20} more)`);
      if (!skipGuard) {
        console.log(`\n   Fix: run npx tsx scripts/intelligence-dataset/validators/verify-sources.ts`);
        console.log(`        and resolve any hardFail / orphan before rebuilding.`);
        console.log(`        Override (disposable-only): NVI_SKIP_GUARD=1`);
        process.exit(4);
      }
      console.log(`\n⚠️  NVI_SKIP_GUARD=1 set — emitting anyway. DO NOT use this for production training.`);
    }
  }

  // ─── Split ───
  const split = splitBalanced(dataset.scenarios, 0.2);
  console.log(`\n📊 Split (80/20 category-balanced):`);
  console.log(`   Train: ${split.train.length}`);
  console.log(`   Test:  ${split.test.length}`);
  console.log(`   By category:`);
  for (const [cat, b] of Object.entries(split.byCategory)) {
    console.log(`     ${cat}: total=${b.total} train=${b.train} test=${b.test}`);
  }

  // ─── Emit ───
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const prefix = `nessie-${version}-${dataset.regulation.toLowerCase()}`;

  const trainPath = resolve(OUTPUT_DIR, `${prefix}-train.jsonl`);
  const testPath  = resolve(OUTPUT_DIR, `${prefix}-test.jsonl`);

  // NVI-08: multi-turn scenarios join the FCRA training set. Validate each
  // before emit so a malformed seed file fails the build, not a silent
  // trainingpad. Other regulations don't have multi-turn seeds yet.
  const multiTurn: MultiTurnScenario[] = dataset.regulation === 'FCRA' ? FCRA_MULTI_TURN_SCENARIOS : [];
  for (const mt of multiTurn) {
    const errs = validateMultiTurnScenario(mt);
    if (errs.length > 0) {
      console.error(`❌ Multi-turn scenario ${mt.id} invalid: ${errs.join('; ')}`);
      process.exit(5);
    }
  }
  if (multiTurn.length > 0) {
    console.log(`\n💬 Multi-turn scenarios (NVI-08): ${multiTurn.length} (appended to train split)`);
  }

  // NVI-09: document-grounded scenarios join FCRA training. Validate every
  // reference against the corpus index; missing or malformed scenarios fail
  // the build rather than emit silently.
  const docScenarios: DocumentGroundedScenario[] = dataset.regulation === 'FCRA' ? FCRA_DOC_GROUNDED_SCENARIOS : [];
  const corpus = dataset.regulation === 'FCRA' ? buildCorpusIndex(FCRA_DOCUMENT_CORPUS) : buildCorpusIndex([]);
  for (const dg of docScenarios) {
    const errs = validateDocumentGroundedScenario(dg, corpus);
    if (errs.length > 0) {
      console.error(`❌ Document-grounded scenario ${dg.id} invalid: ${errs.join('; ')}`);
      process.exit(6);
    }
  }
  if (docScenarios.length > 0) {
    console.log(`📎 Document-grounded scenarios (NVI-09): ${docScenarios.length} (appended to train split)`);
  }

  const trainRows: string[] = [
    ...split.train.map((s) => JSON.stringify(scenarioToTogetherRow(s, { cot: cotEnabled }))),
    ...multiTurn.map((mt) => JSON.stringify(multiTurnToTogetherRow(mt))),
    ...docScenarios.map((dg) => JSON.stringify(documentGroundedToTogetherRow(dg, corpus))),
  ];
  writeFileSync(trainPath, trainRows.join('\n') + '\n');
  writeFileSync(
    testPath,
    split.test.map((s) => JSON.stringify(scenarioToTogetherRow(s, { cot: cotEnabled }))).join('\n') + '\n',
  );

  // ─── Manifest ───
  const manifest: DatasetManifest = {
    regulation: dataset.regulation,
    version,
    generatedAt: new Date().toISOString(),
    sourceCount: dataset.sources.length,
    scenarioCount: dataset.scenarios.length,
    trainCount: split.train.length,
    testCount: split.test.length,
    byCategory: split.byCategory,
    coverageWarnings: report.warnings,
    validationErrors: report.errors,
  };
  const manifestPath = resolve(OUTPUT_DIR, `${prefix}-manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n✅ Wrote:`);
  console.log(`   ${trainPath}`);
  console.log(`   ${testPath}`);
  console.log(`   ${manifestPath}`);
  console.log(`\n📈 Stats:`);
  console.log(`   avg citations/scenario: ${report.stats.avgCitationsPerScenario.toFixed(2)}`);
  console.log(`   avg risks/scenario: ${report.stats.avgRisksPerScenario.toFixed(2)}`);
  console.log(`   avg confidence: ${report.stats.avgConfidence.toFixed(3)}`);
  console.log(`\n   Next: upload ${prefix}-train.jsonl to Together + submit fine-tune job`);
}

main();
