/**
 * Cross-Reference Engine (NCE-15)
 *
 * Compares extracted metadata across multiple documents to find
 * inconsistencies: name mismatches, duplicate credentials, and
 * jurisdiction inconsistencies.
 *
 * Jira: SCRUM-606
 */

export interface CrossRefAnchor {
  id: string;
  credential_type: string;
  title: string | null;
  extracted_name: string | null;
  extracted_date: string | null;
  jurisdiction: string | null;
  org_id: string;
}

export type FindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export type FindingType = 'NAME_MISMATCH' | 'DUPLICATE_CREDENTIAL' | 'JURISDICTION_MISMATCH' | 'DATE_CONFLICT';

export interface CrossRefFinding {
  type: FindingType;
  severity: FindingSeverity;
  anchor_ids: string[];
  description: string;
  conflicting_fields: Record<string, unknown>;
}

export interface CrossRefResult {
  findings: CrossRefFinding[];
  documents_analyzed: number;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function crossReferenceDocuments(anchors: CrossRefAnchor[]): CrossRefResult {
  const findings: CrossRefFinding[] = [];

  if (anchors.length <= 1) {
    return { findings: [], documents_analyzed: anchors.length };
  }

  // 1. Name mismatch detection (HIGH)
  const names = new Map<string, string[]>(); // normalized name -> anchor IDs
  for (const anchor of anchors) {
    if (!anchor.extracted_name) continue;
    const norm = anchor.extracted_name.trim().toLowerCase();
    const existing = names.get(norm);
    if (existing) {
      existing.push(anchor.id);
    } else {
      names.set(norm, [anchor.id]);
    }
  }

  // If there are multiple distinct names, flag as mismatch
  const distinctNames = [...names.keys()];
  if (distinctNames.length > 1) {
    const allIds = anchors.filter(a => a.extracted_name).map(a => a.id);
    const nameValues: Record<string, string[]> = {};
    for (const [name, ids] of names) {
      nameValues[name] = ids;
    }
    findings.push({
      type: 'NAME_MISMATCH',
      severity: 'HIGH',
      anchor_ids: allIds,
      description: `Name mismatch detected across ${distinctNames.length} variants: ${distinctNames.join(', ')}`,
      conflicting_fields: { names: nameValues },
    });
  }

  // 2. Duplicate credential detection (MEDIUM)
  const typeMap = new Map<string, CrossRefAnchor[]>();
  for (const anchor of anchors) {
    const key = `${anchor.credential_type}:${(anchor.title ?? '').toLowerCase()}`;
    const existing = typeMap.get(key);
    if (existing) {
      existing.push(anchor);
    } else {
      typeMap.set(key, [anchor]);
    }
  }

  for (const [key, group] of typeMap) {
    if (group.length > 1) {
      findings.push({
        type: 'DUPLICATE_CREDENTIAL',
        severity: 'MEDIUM',
        anchor_ids: group.map(a => a.id),
        description: `Duplicate ${group[0].credential_type} credentials detected (${group.length} instances)`,
        conflicting_fields: { credential_type: group[0].credential_type, title: group[0].title },
      });
    }
  }

  // 3. Jurisdiction inconsistency detection (LOW)
  const jurisdictions = new Map<string, string[]>();
  for (const anchor of anchors) {
    if (!anchor.jurisdiction) continue;
    const existing = jurisdictions.get(anchor.jurisdiction);
    if (existing) {
      existing.push(anchor.id);
    } else {
      jurisdictions.set(anchor.jurisdiction, [anchor.id]);
    }
  }

  if (jurisdictions.size > 1) {
    const allIds = anchors.filter(a => a.jurisdiction).map(a => a.id);
    const jurisValues: Record<string, string[]> = {};
    for (const [j, ids] of jurisdictions) {
      jurisValues[j] = ids;
    }
    findings.push({
      type: 'JURISDICTION_MISMATCH',
      severity: 'LOW',
      anchor_ids: allIds,
      description: `Documents span ${jurisdictions.size} jurisdictions: ${[...jurisdictions.keys()].join(', ')}`,
      conflicting_fields: { jurisdictions: jurisValues },
    });
  }

  // Sort by severity
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    findings,
    documents_analyzed: anchors.length,
  };
}
