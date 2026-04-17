/**
 * NVI-14 — FCRA Single-Domain Mastery Gate (SCRUM-818).
 *
 * Pure-function evaluator for the 8-criterion gate that blocks HIPAA /
 * FERPA / SOX / GDPR / Kenya / etc. training until FCRA reaches
 * attorney-benchmarked production quality.
 *
 * Inputs are programmatic: verification registry counts, attorney-
 * review state, distillation counts, benchmark scores, canary match
 * rate. The `docs/plans/nessie-fcra-mastery-gate.md` doc describes the
 * policy; this module is the executable check.
 *
 * Intended consumers:
 *   - `build-dataset.ts` can call this to refuse emission of
 *     non-FCRA training JSONL when the gate is closed.
 *   - `scripts/intelligence-dataset/validators/verify-sources.ts` can
 *     print the gate status at end-of-run.
 *   - A nightly cron + dashboard surfaces the status for the team.
 */

export type GateCriterionStatus = 'pass' | 'fail';

export interface GateCriterion {
  id: string;
  label: string;
  status: GateCriterionStatus;
  detail: string;
}

export interface FcraMasteryGateInputs {
  /** From NVI-01..04 verification registry aggregate. */
  verification: { total: number; passing: number; orphans: number; hardFails: number };
  /** From NVI-05 tier-3 attorney-review queue. */
  attorneyReview: { tier3Open: number; tier3Resolved: number };
  /** From NVI-06 cot-retrofit output. */
  chainOfThought: { scenariosWithCot: number; scenariosTotal: number };
  /** From NVI-07 Opus-distillation accepted-Q&A count. */
  distillation: { acceptedQa: number; target: number };
  /** From NVI-08 / 09 / 10 scenario counts. */
  auxiliary: { multiTurn: number; documentGrounded: number; adversarial: number };
  /** From NVI-11 + NVI-12 LLM-judge benchmark results. */
  benchmark: { attorneyQuestions: number; nessieScorePercent: number; geminiBaselinePercent: number };
  /** From NVI-13 canary review rollup. */
  canary: { reviewedResponses: number; matchRatePercent: number };
}

export interface GateEvaluation {
  passes: boolean;
  criteria: GateCriterion[];
}

/** Threshold constants — changing these is a policy change, document in gate MD. */
const MIN_AUX = { multiTurn: 100, documentGrounded: 150, adversarial: 50 } as const;
const MIN_ATTORNEY_BENCHMARK_QUESTIONS = 50;
const MIN_CANARY_REVIEWED = 100;
const MIN_CANARY_MATCH_RATE = 0.70;

export function evaluateFcraMasteryGate(inputs: FcraMasteryGateInputs): GateEvaluation {
  const criteria: GateCriterion[] = [];

  // 1. Verification
  {
    const { total, passing, orphans, hardFails } = inputs.verification;
    const ok = hardFails === 0 && orphans === 0 && passing === total;
    criteria.push({
      id: 'verification',
      label: 'NVI-01..04 — every FCRA source verified',
      status: ok ? 'pass' : 'fail',
      detail: `passing ${passing}/${total}; orphans ${orphans}; hardFails ${hardFails}`,
    });
  }

  // 2. Attorney review
  {
    const { tier3Open, tier3Resolved } = inputs.attorneyReview;
    const ok = tier3Open === 0;
    criteria.push({
      id: 'attorney-review',
      label: 'NVI-05 — all Tier 3 items attorney-resolved',
      status: ok ? 'pass' : 'fail',
      detail: `tier-3 open ${tier3Open}, resolved ${tier3Resolved}`,
    });
  }

  // 3. Chain-of-thought
  {
    const { scenariosWithCot, scenariosTotal } = inputs.chainOfThought;
    const ok = scenariosWithCot === scenariosTotal && scenariosTotal > 0;
    criteria.push({
      id: 'chain-of-thought',
      label: 'NVI-06 — CoT retrofit on every scenario',
      status: ok ? 'pass' : 'fail',
      detail: `${scenariosWithCot}/${scenariosTotal} with reasoning_steps`,
    });
  }

  // 4. Distillation
  {
    const { acceptedQa, target } = inputs.distillation;
    const ok = acceptedQa >= target;
    criteria.push({
      id: 'distillation',
      label: 'NVI-07 — ≥5,000 Opus-distilled FCRA Q&A',
      status: ok ? 'pass' : 'fail',
      detail: `accepted ${acceptedQa}/${target}`,
    });
  }

  // 5. Auxiliary coverage
  {
    const { multiTurn, documentGrounded, adversarial } = inputs.auxiliary;
    const ok =
      multiTurn >= MIN_AUX.multiTurn &&
      documentGrounded >= MIN_AUX.documentGrounded &&
      adversarial >= MIN_AUX.adversarial;
    criteria.push({
      id: 'auxiliary',
      label: 'NVI-08/09/10 — ≥100 multi-turn + ≥150 doc-grounded + ≥50 adversarial',
      status: ok ? 'pass' : 'fail',
      detail: `multi-turn ${multiTurn}/${MIN_AUX.multiTurn}; doc ${documentGrounded}/${MIN_AUX.documentGrounded}; adversarial ${adversarial}/${MIN_AUX.adversarial}`,
    });
  }

  // 6. Professional benchmark exists
  {
    const ok = inputs.benchmark.attorneyQuestions >= MIN_ATTORNEY_BENCHMARK_QUESTIONS;
    criteria.push({
      id: 'professional-benchmark',
      label: `NVI-11 — attorney-created gold-standard (≥${MIN_ATTORNEY_BENCHMARK_QUESTIONS} questions)`,
      status: ok ? 'pass' : 'fail',
      detail: `${inputs.benchmark.attorneyQuestions}/${MIN_ATTORNEY_BENCHMARK_QUESTIONS}`,
    });
  }

  // 7. Benchmark score
  {
    const { nessieScorePercent, geminiBaselinePercent } = inputs.benchmark;
    const ok = nessieScorePercent >= geminiBaselinePercent;
    criteria.push({
      id: 'benchmark',
      label: 'NVI-12 — Nessie score ≥ Gemini 2.5 Pro baseline on gold-standard',
      status: ok ? 'pass' : 'fail',
      detail: `Nessie ${nessieScorePercent.toFixed(1)}% vs Gemini ${geminiBaselinePercent.toFixed(1)}%`,
    });
  }

  // 8. Canary
  {
    const { reviewedResponses, matchRatePercent } = inputs.canary;
    const ok =
      reviewedResponses >= MIN_CANARY_REVIEWED &&
      matchRatePercent >= MIN_CANARY_MATCH_RATE;
    criteria.push({
      id: 'canary',
      label: `NVI-13 — ≥${MIN_CANARY_REVIEWED} canary responses reviewed, ≥${(MIN_CANARY_MATCH_RATE * 100).toFixed(0)}% match rate`,
      status: ok ? 'pass' : 'fail',
      detail: `reviewed ${reviewedResponses}; match ${(matchRatePercent * 100).toFixed(1)}%`,
    });
  }

  const passes = criteria.every((c) => c.status === 'pass');
  return { passes, criteria };
}

export function renderGateStatusMarkdown(ev: GateEvaluation): string {
  const banner = ev.passes ? 'FCRA Mastery Gate: ✅ PASS' : 'FCRA Mastery Gate: 🛑 HOLD';
  const lines: string[] = [`# ${banner}`, ''];
  for (const c of ev.criteria) {
    const icon = c.status === 'pass' ? '✅' : '❌';
    lines.push(`- [${icon}] **${c.label}** — ${c.detail}`);
  }
  lines.push('');
  if (!ev.passes) {
    const failing = ev.criteria.filter((c) => c.status === 'fail').map((c) => c.id);
    lines.push(`Failing criteria: ${failing.join(', ')}`);
    lines.push('');
    lines.push('While the gate is closed: HIPAA / FERPA / SOX / GDPR / Kenya / international dataset expansion and training are **paused** per CLAUDE.md §0 NVI Gate Mandate.');
  }
  return lines.join('\n') + '\n';
}
