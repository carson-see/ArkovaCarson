/**
 * Gap Detector (NCE-08)
 *
 * Compares an org's anchored documents against jurisdiction rules
 * to identify missing required and recommended documents.
 *
 * Jira: SCRUM-598
 */

import type { JurisdictionRule } from './score-calculator.js';

export interface GapAnchor {
  id: string;
  credential_type: string;
  status: string;
}

export interface GapDetectorInput {
  rules: JurisdictionRule[];
  anchors: GapAnchor[];
  aggregateData: Record<string, number> | null; // type -> % of similar orgs with this type
}

export interface GapItem {
  type: string;
  requirement: string;
  regulatory_reference: string | null;
  score_impact: number;
  peer_adoption_pct: number | null;
}

export interface GapDetectorResult {
  missing_required: GapItem[];
  missing_recommended: GapItem[];
  priority_order: string[];
  summary: string;
}

const TYPE_PRIORITY: Record<string, number> = {
  LICENSE: 100,
  PROFESSIONAL: 90,
  DEGREE: 80,
  CERTIFICATE: 60,
  CONTINUING_EDUCATION: 70,
  TRANSCRIPT: 40,
  OTHER: 30,
};

export function detectGaps(input: GapDetectorInput): GapDetectorResult {
  const { rules, anchors, aggregateData } = input;

  // Build set of SECURED credential types
  const presentTypes = new Set<string>();
  for (const anchor of anchors) {
    if (anchor.status === 'SECURED') {
      presentTypes.add(anchor.credential_type);
    }
  }

  // Collect all required and optional types from rules
  const requiredTypes = new Set<string>();
  const optionalTypes = new Set<string>();
  for (const rule of rules) {
    for (const t of rule.required_credential_types) requiredTypes.add(t);
    for (const t of rule.optional_credential_types) optionalTypes.add(t);
  }

  const missing_required: GapItem[] = [];
  const missing_recommended: GapItem[] = [];

  for (const type of requiredTypes) {
    if (!presentTypes.has(type)) {
      const ruleRef = rules.find(r => r.required_credential_types.includes(type));
      missing_required.push({
        type,
        requirement: `Required: ${type}`,
        regulatory_reference: ruleRef?.regulatory_reference ?? null,
        score_impact: TYPE_PRIORITY[type] ?? TYPE_PRIORITY.OTHER,
        peer_adoption_pct: aggregateData?.[type] ?? null,
      });
    }
  }

  for (const type of optionalTypes) {
    if (!presentTypes.has(type) && !requiredTypes.has(type)) {
      missing_recommended.push({
        type,
        requirement: `Recommended: ${type}`,
        regulatory_reference: null,
        score_impact: 0,
        peer_adoption_pct: aggregateData?.[type] ?? null,
      });
    }
  }

  // Sort by priority (highest first)
  missing_required.sort((a, b) => (TYPE_PRIORITY[b.type] ?? 0) - (TYPE_PRIORITY[a.type] ?? 0));

  const priority_order = missing_required.map(m => m.type);

  const totalRequired = requiredTypes.size;
  const totalPresent = totalRequired - missing_required.length;

  let summary: string;
  if (missing_required.length === 0) {
    summary = `You have all ${totalRequired} required documents for compliance.`;
  } else {
    summary = `You are missing ${missing_required.length} of ${totalRequired} required documents for compliance.`;
  }

  return {
    missing_required,
    missing_recommended,
    priority_order,
    summary,
  };
}
