/**
 * NVI-10 — Adversarial + "I don't know" humility training (SCRUM-814).
 *
 * Production compliance AI's biggest failure mode is confident wrong
 * answers. Our current training signal is all "here's a clean answer";
 * Nessie never sees a scenario where the correct move is "decline,
 * consult counsel, the law is unsettled". This module defines the
 * validator that enforces the contract on refuse-to-answer scenarios so
 * the training signal stays consistent.
 *
 * Contract (when `should_refuse: true`):
 *   1. `confidence ≤ 0.70` — over-confident refusals are as bad as
 *      over-confident answers. If you're refusing, you're uncertain.
 *   2. `escalation_trigger: true` — the refusal must be accompanied by
 *      an explicit cue so the UI surfaces a counsel-consultation prompt.
 *   3. At least one `recommendations` entry must be an escalation-style
 *      recommendation (matched by `isEscalationRecommendation`).
 *
 * Legacy scenarios that omit `should_refuse` entirely are unaffected —
 * the contract only applies when the flag is present.
 */

import type { IntelligenceAnswer } from './types';

/** Recommendation text patterns that qualify as an escalation-style cue. */
const ESCALATION_PATTERNS: RegExp[] = [
  /\bconsult\b.*\b(?:counsel|attorney|lawyer|compliance\s+expert)\b/i,
  /\breview\s+with\b.*\b(?:counsel|attorney|expert|specialist)\b/i,
  /\bseek\s+legal\s+advice\b/i,
  /\bengage\s+(?:outside\s+)?counsel\b/i,
  /\brefer\b.*\b(?:to\s+counsel|to\s+attorney)\b/i,
  /\bescalate\b.*\b(?:to\s+counsel|to\s+legal|to\s+compliance)\b/i,
];

export function isEscalationRecommendation(rec: string): boolean {
  return ESCALATION_PATTERNS.some((re) => re.test(rec));
}

/**
 * Validate an answer against the NVI-10 contract. Returns an array of
 * error strings; empty = valid. No-ops on answers that omit
 * `should_refuse` or set it to false.
 */
export function validateAdversarialAnswer(ans: IntelligenceAnswer): string[] {
  if (!ans.should_refuse) return [];
  const errs: string[] = [];
  if (ans.confidence > 0.70) {
    errs.push(`should_refuse=true requires confidence ≤ 0.70 (got ${ans.confidence.toFixed(2)})`);
  }
  if (ans.escalation_trigger !== true) {
    errs.push('should_refuse=true requires escalation_trigger=true');
  }
  const hasEscalation = ans.recommendations.some(isEscalationRecommendation);
  if (!hasEscalation) {
    errs.push('should_refuse=true requires at least one escalation-style recommendation (e.g. "Consult qualified FCRA counsel")');
  }
  return errs;
}
