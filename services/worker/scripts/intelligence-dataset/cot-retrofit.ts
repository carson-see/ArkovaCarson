#!/usr/bin/env tsx
/**
 * NVI-06 — cot-retrofit CLI (SCRUM-810).
 *
 * Runs the deterministic chain-of-thought scaffolder over every FCRA /
 * HIPAA / FERPA scenario and writes the results to an inspection file so
 * dataset maintainers can eyeball coverage before baking CoT into the
 * training JSONL.
 *
 * Why a separate CLI? `build-dataset.ts` already emits CoT inline (NVI-06
 * wiring). This script exists for a different audience: the
 * maintainer who wants to audit the scaffold output, spot TODO markers
 * (step 3 statutory exceptions + step 4 state overlays when jurisdiction
 * is ambiguous), and decide which scenarios need LLM enrichment.
 *
 * Usage:
 *   npx tsx scripts/intelligence-dataset/cot-retrofit.ts --regulation fcra
 *   npx tsx scripts/intelligence-dataset/cot-retrofit.ts --regulation all \
 *     --out out/cot-scaffolds.json
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import type { IntelligenceScenario } from './types';
import { scaffoldCot, type CotReasoningSteps } from './cot-scaffold';

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

// HIPAA scenarios
import { HIPAA_PRIVACY_SCENARIOS } from './scenarios/hipaa/privacy-and-patient-rights';
import { HIPAA_SECURITY_BREACH_BA_SCENARIOS } from './scenarios/hipaa/security-breach-ba';
import { HIPAA_CREDENTIAL_SCENARIOS } from './scenarios/hipaa/credential-verification';

// FERPA scenarios
import { FERPA_SCENARIOS } from './scenarios/ferpa/ferpa-core';
import { FERPA_ADVANCED_SCENARIOS } from './scenarios/ferpa/ferpa-advanced';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function fcraScenarios(): IntelligenceScenario[] {
  return [
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
  ];
}

function hipaaScenarios(): IntelligenceScenario[] {
  return [...HIPAA_PRIVACY_SCENARIOS, ...HIPAA_SECURITY_BREACH_BA_SCENARIOS, ...HIPAA_CREDENTIAL_SCENARIOS];
}

function ferpaScenarios(): IntelligenceScenario[] {
  return [...FERPA_SCENARIOS, ...FERPA_ADVANCED_SCENARIOS];
}

interface Args {
  regulation: 'fcra' | 'hipaa' | 'ferpa' | 'all';
  out: string;
}

function parseArgs(argv: string[]): Args {
  const regIdx = argv.indexOf('--regulation');
  const outIdx = argv.indexOf('--out');
  const regulation = (regIdx >= 0 ? argv[regIdx + 1] : 'all') as Args['regulation'];
  const out = outIdx >= 0 ? argv[outIdx + 1] : resolve(__dirname, '..', '..', 'out', 'cot-scaffolds.json');
  return { regulation, out };
}

function scenariosFor(reg: Args['regulation']): IntelligenceScenario[] {
  switch (reg) {
    case 'fcra': return fcraScenarios();
    case 'hipaa': return hipaaScenarios();
    case 'ferpa': return ferpaScenarios();
    case 'all': return [...fcraScenarios(), ...hipaaScenarios(), ...ferpaScenarios()];
  }
}

interface CoverageReport {
  total: number;
  todoStep3: number;
  todoStep4: number;
  byQuestionKind: Record<string, number>;
  byConfidenceBand: Record<string, number>;
}

function summarise(cots: Record<string, CotReasoningSteps>): CoverageReport {
  const r: CoverageReport = {
    total: 0,
    todoStep3: 0,
    todoStep4: 0,
    byQuestionKind: {},
    byConfidenceBand: {},
  };
  for (const cot of Object.values(cots)) {
    r.total++;
    if (cot.step3_statutory_exceptions.startsWith('TODO')) r.todoStep3++;
    if (cot.step4_state_overlays.startsWith('TODO')) r.todoStep4++;
    r.byQuestionKind[cot.step1_question_kind] = (r.byQuestionKind[cot.step1_question_kind] ?? 0) + 1;
    const band = cot.step7_confidence_band.split(' ')[0];
    r.byConfidenceBand[band] = (r.byConfidenceBand[band] ?? 0) + 1;
  }
  return r;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = scenariosFor(args.regulation);
  const cots: Record<string, CotReasoningSteps> = {};
  for (const s of scenarios) cots[s.id] = scaffoldCot(s);
  const report = summarise(cots);

  const outDir = dirname(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(args.out, JSON.stringify({ generatedAt: new Date().toISOString(), report, cots }, null, 2));

  console.log(`\n🧠 NVI-06 CoT retrofit`);
  console.log(`   regulation: ${args.regulation}`);
  console.log(`   scenarios:  ${report.total}`);
  console.log(`   step3 TODO: ${report.todoStep3}`);
  console.log(`   step4 TODO: ${report.todoStep4}`);
  console.log(`   by kind:    ${JSON.stringify(report.byQuestionKind)}`);
  console.log(`   by band:    ${JSON.stringify(report.byConfidenceBand)}`);
  console.log(`   wrote:      ${args.out}`);
}

if (process.argv[1] && process.argv[1].endsWith('cot-retrofit.ts')) main();
