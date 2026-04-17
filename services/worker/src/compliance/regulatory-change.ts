/**
 * Regulatory Change Impact (NCA-06)
 *
 * Given a prior audit (before rule changes) and a fresh audit (after rule
 * changes), computes the score delta + categorises the change so the
 * notification layer can decide in-app vs email.
 *
 * This module is pure — I/O (DB reads, email send, in-app notification
 * insert) lives in the worker route + cron handler. That keeps the
 * decision logic unit-testable without a live Supabase + Resend.
 *
 * Jira: SCRUM-761 (NCA-06)
 */

import type { OrgAuditResult, AuditGap } from './org-audit.js';

export type ChangeSeverity = 'NONE' | 'INFO' | 'IN_APP' | 'EMAIL';

export interface RuleChangeSignal {
  /** Rules whose `updated_at` moved since the last audit. */
  changed_rule_ids: string[];
  /** Rules whose primary regulation reference changed (e.g. FCRA §604 → §605). */
  changed_regulations: string[];
  /** Newly-introduced rule ids. */
  added_rule_ids: string[];
  /** Rule ids marked deprecated. */
  deprecated_rule_ids: string[];
}

export interface RegulatoryChangeImpact {
  previous_score: number;
  new_score: number;
  delta: number;
  severity: ChangeSeverity;
  changed_regulations: string[];
  new_gap_keys: string[];
  resolved_gap_keys: string[];
  summary: string;
}

/** Score drop thresholds tuned so customers aren't spammed. */
const IN_APP_DELTA_THRESHOLD = 5;
const EMAIL_DELTA_THRESHOLD = 10;

export function computeRegulatoryChangeImpact(
  previous: OrgAuditResult,
  current: OrgAuditResult,
  ruleChange: RuleChangeSignal,
): RegulatoryChangeImpact {
  const delta = current.overall_score - previous.overall_score;

  const prevKeys = new Set(previous.gaps.map(gapKey));
  const currKeys = new Set(current.gaps.map(gapKey));

  const newGapKeys: string[] = [];
  for (const k of currKeys) if (!prevKeys.has(k)) newGapKeys.push(k);

  const resolvedGapKeys: string[] = [];
  for (const k of prevKeys) if (!currKeys.has(k)) resolvedGapKeys.push(k);

  const severity = decideSeverity(delta, ruleChange, newGapKeys.length);

  return {
    previous_score: previous.overall_score,
    new_score: current.overall_score,
    delta,
    severity,
    changed_regulations: [...new Set(ruleChange.changed_regulations)].sort(),
    new_gap_keys: newGapKeys.sort(),
    resolved_gap_keys: resolvedGapKeys.sort(),
    summary: summarise(delta, ruleChange, newGapKeys.length, resolvedGapKeys.length),
  };
}

function gapKey(gap: AuditGap): string {
  return `${gap.jurisdiction_code}::${gap.type}::${gap.category}`;
}

function decideSeverity(
  delta: number,
  ruleChange: RuleChangeSignal,
  newGapCount: number,
): ChangeSeverity {
  const drop = -delta;

  if (drop >= EMAIL_DELTA_THRESHOLD) return 'EMAIL';
  if (drop >= IN_APP_DELTA_THRESHOLD) return 'IN_APP';

  // Rule changes that introduce brand-new gaps without dropping score
  // enough to hit the threshold still warrant an in-app ping so the admin
  // can see what shifted.
  if (newGapCount > 0 && ruleChange.changed_rule_ids.length > 0) return 'IN_APP';

  // Pure administrative rule tweaks (renames, clarifications) with no
  // behaviour change → informational log only, no notification.
  if (
    ruleChange.changed_rule_ids.length > 0 ||
    ruleChange.added_rule_ids.length > 0 ||
    ruleChange.deprecated_rule_ids.length > 0
  ) {
    return 'INFO';
  }

  return 'NONE';
}

function summarise(
  delta: number,
  ruleChange: RuleChangeSignal,
  newGapCount: number,
  resolvedGapCount: number,
): string {
  if (delta === 0 && ruleChange.changed_rule_ids.length === 0 && ruleChange.added_rule_ids.length === 0) {
    return 'No regulatory change detected.';
  }
  const parts: string[] = [];
  if (delta < 0) parts.push(`Score dropped by ${-delta} points.`);
  else if (delta > 0) parts.push(`Score improved by ${delta} points.`);
  if (ruleChange.added_rule_ids.length)
    parts.push(`${ruleChange.added_rule_ids.length} new rule(s) took effect.`);
  if (ruleChange.changed_rule_ids.length)
    parts.push(`${ruleChange.changed_rule_ids.length} rule(s) updated.`);
  if (ruleChange.deprecated_rule_ids.length)
    parts.push(`${ruleChange.deprecated_rule_ids.length} rule(s) deprecated.`);
  if (newGapCount) parts.push(`${newGapCount} new gap(s) opened.`);
  if (resolvedGapCount) parts.push(`${resolvedGapCount} gap(s) closed.`);
  return parts.join(' ');
}

/**
 * Given an array of jurisdiction_rules rows with `updated_at` timestamps,
 * return the change signal relative to a reference time (typically the
 * previous audit's `started_at`).
 */
export function detectRuleChangesSince(
  rules: Array<{
    id: string;
    updated_at: string;
    created_at?: string;
    deprecated_at?: string | null;
    regulatory_reference?: string | null;
  }>,
  referenceTime: string,
): RuleChangeSignal {
  const refMs = new Date(referenceTime).getTime();
  const changed: string[] = [];
  const added: string[] = [];
  const deprecated: string[] = [];
  const regulations = new Set<string>();

  for (const r of rules) {
    const createdMs = r.created_at ? new Date(r.created_at).getTime() : 0;
    const updatedMs = new Date(r.updated_at).getTime();
    const deprMs = r.deprecated_at ? new Date(r.deprecated_at).getTime() : 0;
    if (createdMs > refMs) {
      added.push(r.id);
      if (r.regulatory_reference) regulations.add(r.regulatory_reference);
      continue; // a newly-added rule is not also "changed"
    }
    if (deprMs > refMs) {
      deprecated.push(r.id);
      if (r.regulatory_reference) regulations.add(r.regulatory_reference);
      continue;
    }
    if (updatedMs > refMs) {
      changed.push(r.id);
      if (r.regulatory_reference) regulations.add(r.regulatory_reference);
    }
  }

  return {
    changed_rule_ids: changed,
    added_rule_ids: added,
    deprecated_rule_ids: deprecated,
    changed_regulations: [...regulations],
  };
}
