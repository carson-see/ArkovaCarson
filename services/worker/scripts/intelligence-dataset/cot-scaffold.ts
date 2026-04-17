/**
 * NVI-06 — Chain-of-thought scaffolder (SCRUM-810).
 *
 * Turns an existing hand-crafted `IntelligenceScenario` into an 8-step
 * chain-of-thought reasoning record. The motivation: v27.2 → v27.3 showed
 * faithfulness plateaued at 45-47% because scenarios teach the destination
 * (query → answer) but not the journey. Exposing the reasoning path at
 * training time is expected to lift faithfulness.
 *
 * The 8 steps (contract, NOT arbitrary):
 *
 *   step1_question_kind       Classify: compliance_qa / risk_analysis /
 *                             cross_reference / recommendation / document_summary
 *   step2_federal_statutes    Specific federal statute sections cited
 *   step3_statutory_exceptions Statute-level exceptions we need to screen for
 *   step4_state_overlays      State-law parallel / overlay codes that apply
 *   step5_risks               Risks enumerated (copy from answer.risks)
 *   step6_recommendations     Actionable recommendations (copy from answer.recommendations)
 *   step7_confidence_band     Calibration band (clear-statute / common-interpretation / grey-area)
 *   step8_escalation_trigger  When should the user consult counsel?
 *
 * Design choices:
 *   - The scaffolder is DETERMINISTIC and OFFLINE. No LLM calls here. An
 *     LLM enricher can later refine the TODO-marked steps (steps 3 + 8
 *     especially), but the scaffold already produces a full 8-step record
 *     from existing scenario content alone. That means every scenario can
 *     be retrofitted in one CLI run with zero API budget.
 *   - Steps 5 + 6 are CARBON COPIES of the scenario's existing risks +
 *     recommendations. We do not regenerate them. The goal is for the
 *     model to learn the intermediate reasoning leading up to those
 *     outputs — not to invent new ones.
 *   - Confidence band comes directly from `answer.confidence`. This keeps
 *     the training signal internally consistent.
 *   - When the scaffolder can't infer a step from the scenario content
 *     alone (e.g. step 3 statutory exceptions), it emits a TODO marker
 *     so maintainers can see what still needs LLM or human input.
 */

import type { IntelligenceAnswer, IntelligenceScenario } from './types';

export type QuestionKind =
  | 'compliance_qa'
  | 'risk_analysis'
  | 'cross_reference'
  | 'recommendation'
  | 'document_summary';

export interface CotReasoningSteps {
  step1_question_kind: QuestionKind;
  step2_federal_statutes: string[];
  step3_statutory_exceptions: string;
  step4_state_overlays: string;
  step5_risks: string[];
  step6_recommendations: string[];
  step7_confidence_band: string;
  step8_escalation_trigger: string;
}

export type ConfidenceBand = 'clear-statute' | 'common-interpretation' | 'grey-area';

// ---------------------------------------------------------------------------
// Step 1 — classify question kind
// ---------------------------------------------------------------------------

export function classifyQuestionKind(sc: IntelligenceScenario): QuestionKind {
  const q = sc.query.toLowerCase();
  // Document-summary takes priority — the word "summarize" is decisive.
  if (/\b(summarize|explain\s+this|what\s+does\s+this\s+(contract|clause|policy|section))/.test(q)) {
    return 'document_summary';
  }
  // Multi-statute questions are cross_reference (e.g. "how does X interact with Y")
  if (/\b(interact|intersect|overlap|together\s+with|combined\s+with|how\s+does\s+.*\s+and\s+)/.test(q)) {
    return 'cross_reference';
  }
  // Recommendation: "what should I", "how do I", "what's the process"
  if (/\b(what\s+should|how\s+do\s+i|how\s+should|what['\u2019]s\s+the\s+process|best\s+practice)/.test(q)) {
    return 'recommendation';
  }
  // Risk: "risk", "liability", "exposure"
  if (/\b(risk|risks|liability|exposure|danger|penalty|penalties)\b/.test(q)) {
    return 'risk_analysis';
  }
  return 'compliance_qa';
}

// ---------------------------------------------------------------------------
// Step 2 — extract federal statute refs from the analysis prose
// ---------------------------------------------------------------------------

/** "§604(a)", "§615(c)", "§1681b(b)(3)", "15 U.S.C. §1681b(a)", "45 CFR 164.524". */
const STATUTE_RE = /(?:\b\d+\s+U\.S\.C\.\s*§\s*\d+[a-z]?(?:\([a-z0-9]+\))*|§\s*\d+[a-z]?(?:\([a-z0-9]+\))+|\b\d+\s+CFR\s+\d+\.\d+)/gi;

export function extractFederalStatuteRefs(text: string): string[] {
  const raw = text.match(STATUTE_RE) ?? [];
  // Normalise whitespace inside each match so "§ 604(a)" and "§604(a)" dedupe.
  const normalised = raw.map((r) => r.replace(/\s+/g, ' ').replace(/§\s+/g, '§'));
  return Array.from(new Set(normalised));
}

// ---------------------------------------------------------------------------
// Step 3 — statutory exceptions (TODO if not extractable)
// ---------------------------------------------------------------------------

function scaffoldExceptions(sc: IntelligenceScenario): string {
  // The analysis prose sometimes names exceptions ("§605(b) salary exception",
  // "§604(f) permissible purpose exception", "HIPAA TPO carve-out"). Surface
  // any such phrasing; otherwise emit a clear TODO marker.
  const analysis = sc.expected.analysis;
  const exceptionRe = /\b(§\s*\d+[a-z]?(?:\([a-z0-9]+\))+|[A-Z]{3,}[\w-]*)\s+(?:exception|carve-?out|exemption|safe\s+harbor)/gi;
  const hits = analysis.match(exceptionRe);
  if (hits && hits.length > 0) {
    return Array.from(new Set(hits.map((h) => h.replace(/\s+/g, ' ')))).join('; ');
  }
  return 'TODO (LLM-enrich): screen for statute-level exceptions or note "none apply"';
}

// ---------------------------------------------------------------------------
// Step 4 — state overlays
// ---------------------------------------------------------------------------

/** Catches "California §12952", "Illinois JOQAA", "NYC §8-107", "C.R.S. §8-2-130", "NJ Opportunity". */
const STATE_CODE_RE = /\b(California|Illinois|Texas|Massachusetts|Oregon|Washington|Colorado|Florida|Georgia|Ohio|Pennsylvania|New\s+York|New\s+Jersey|Minnesota|Hawaii|Nevada|Montana|Connecticut|CA|NY|NYC|IL|TX|MA|OR|WA|CO|FL|GA|OH|PA|NJ|MN|HI|NV|MT|CT)\s+(?:§\s*\d[\w.()-]*|[A-Z]{2,}[\w-]*|Civ\.?|Code|Lab\.?|Opportunity|Fair\s+Chance|Article\s+\d+|Chapter\s+\d+|C\.R\.S\.|JOQAA|CCPA)/g;

function scaffoldStateOverlays(sc: IntelligenceScenario): string {
  const j = sc.expected.jurisdiction;
  if (j === 'federal') return 'none — federal-only scenario';
  const analysis = sc.expected.analysis;
  const hits = analysis.match(STATE_CODE_RE);
  if (hits && hits.length > 0) {
    return Array.from(new Set(hits.map((h) => h.replace(/\s+/g, ' ')))).join('; ');
  }
  // The jurisdiction flagged a state overlay but the analysis didn't name
  // the specific code — that's a TODO for enrichment.
  return `TODO (LLM-enrich): jurisdiction=${j} but no state code extracted from analysis`;
}

// ---------------------------------------------------------------------------
// Step 7 — confidence band
// ---------------------------------------------------------------------------

export function confidenceBand(confidence: number): { band: ConfidenceBand; rationale: string } {
  if (confidence >= 0.85) return { band: 'clear-statute', rationale: `confidence ${confidence.toFixed(2)} ≥ 0.85` };
  if (confidence >= 0.70) return { band: 'common-interpretation', rationale: `confidence ${confidence.toFixed(2)} ∈ [0.70, 0.85)` };
  return { band: 'grey-area', rationale: `confidence ${confidence.toFixed(2)} < 0.70` };
}

// ---------------------------------------------------------------------------
// Step 8 — escalation trigger
// ---------------------------------------------------------------------------

function scaffoldEscalation(sc: IntelligenceScenario): string {
  const b = confidenceBand(sc.expected.confidence).band;
  if (b === 'grey-area') {
    return 'consult outside counsel before action — legal uncertainty above model confidence';
  }
  if (b === 'common-interpretation') {
    return 'consult counsel for novel fact patterns or when state-overlay analysis is required';
  }
  return 'not routinely — high-confidence federal rule with clear statutory basis';
}

// ---------------------------------------------------------------------------
// Main scaffolder
// ---------------------------------------------------------------------------

export function scaffoldCot(sc: IntelligenceScenario): CotReasoningSteps {
  const band = confidenceBand(sc.expected.confidence);
  return {
    step1_question_kind: classifyQuestionKind(sc),
    step2_federal_statutes: extractFederalStatuteRefs(sc.expected.analysis),
    step3_statutory_exceptions: scaffoldExceptions(sc),
    step4_state_overlays: scaffoldStateOverlays(sc),
    step5_risks: [...sc.expected.risks],
    step6_recommendations: [...sc.expected.recommendations],
    step7_confidence_band: `${band.band} (${band.rationale})`,
    step8_escalation_trigger: scaffoldEscalation(sc),
  };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Returns a NEW IntelligenceAnswer with `reasoning_steps` attached. Does not
 * mutate the input. build-dataset.ts uses this when assembling the Together
 * training row.
 */
export function mergeCotIntoAnswer(
  answer: IntelligenceAnswer,
  cot: CotReasoningSteps,
): IntelligenceAnswer & { reasoning_steps: CotReasoningSteps } {
  return { ...answer, reasoning_steps: cot };
}

// ---------------------------------------------------------------------------
// Pluggable LLM enricher interface (contract only — no default impl)
// ---------------------------------------------------------------------------

/**
 * Interface for a Claude Opus / GPT-4o / Gemini 2.5 Pro enricher that can
 * refine the TODO-marked steps (3, 4, 8) once the scaffolder has produced
 * the deterministic baseline. The enricher is NEVER called from tests — it
 * exists so cot-retrofit.ts can optionally upgrade the scaffold offline.
 */
export interface LlmEnricher {
  enrich(
    sc: IntelligenceScenario,
    scaffold: CotReasoningSteps,
  ): Promise<CotReasoningSteps>;
}
