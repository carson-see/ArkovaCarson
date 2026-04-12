/**
 * Cross-Reference Engine Tests (NCE-15)
 */

import { describe, it, expect } from 'vitest';
import { crossReferenceDocuments, type CrossRefAnchor, type CrossRefFinding } from './cross-reference.js';

const makeAnchor = (overrides: Partial<CrossRefAnchor> = {}): CrossRefAnchor => ({
  id: 'a1',
  credential_type: 'LICENSE',
  title: 'CPA License',
  extracted_name: 'John Smith',
  extracted_date: '2024-01-15',
  jurisdiction: 'US-CA',
  org_id: 'org-1',
  ...overrides,
});

describe('crossReferenceDocuments', () => {
  it('returns no findings when all documents are consistent', () => {
    const anchors = [
      makeAnchor({ id: 'a1', extracted_name: 'John Smith' }),
      makeAnchor({ id: 'a2', credential_type: 'DEGREE', title: 'MBA', extracted_name: 'John Smith' }),
    ];
    const result = crossReferenceDocuments(anchors);
    expect(result.findings).toHaveLength(0);
  });

  it('detects name mismatches (HIGH severity)', () => {
    const anchors = [
      makeAnchor({ id: 'a1', extracted_name: 'John Smith' }),
      makeAnchor({ id: 'a2', extracted_name: 'Jon Smith', credential_type: 'DEGREE' }),
    ];
    const result = crossReferenceDocuments(anchors);
    const nameFindings = result.findings.filter(f => f.type === 'NAME_MISMATCH');
    expect(nameFindings.length).toBeGreaterThan(0);
    expect(nameFindings[0].severity).toBe('HIGH');
  });

  it('detects duplicate credentials (MEDIUM severity)', () => {
    const anchors = [
      makeAnchor({ id: 'a1', credential_type: 'LICENSE', title: 'CPA License' }),
      makeAnchor({ id: 'a2', credential_type: 'LICENSE', title: 'CPA License' }),
    ];
    const result = crossReferenceDocuments(anchors);
    const dupFindings = result.findings.filter(f => f.type === 'DUPLICATE_CREDENTIAL');
    expect(dupFindings.length).toBeGreaterThan(0);
    expect(dupFindings[0].severity).toBe('MEDIUM');
  });

  it('detects jurisdiction inconsistencies (LOW severity)', () => {
    const anchors = [
      makeAnchor({ id: 'a1', jurisdiction: 'US-CA' }),
      makeAnchor({ id: 'a2', jurisdiction: 'US-NY', credential_type: 'DEGREE' }),
    ];
    const result = crossReferenceDocuments(anchors);
    const jurisFindings = result.findings.filter(f => f.type === 'JURISDICTION_MISMATCH');
    expect(jurisFindings.length).toBeGreaterThan(0);
    expect(jurisFindings[0].severity).toBe('LOW');
  });

  it('handles single document (no comparisons needed)', () => {
    const result = crossReferenceDocuments([makeAnchor()]);
    expect(result.findings).toHaveLength(0);
  });

  it('handles empty array', () => {
    const result = crossReferenceDocuments([]);
    expect(result.findings).toHaveLength(0);
  });

  it('includes anchor IDs in findings', () => {
    const anchors = [
      makeAnchor({ id: 'anchor-A', extracted_name: 'John Smith' }),
      makeAnchor({ id: 'anchor-B', extracted_name: 'Jane Doe', credential_type: 'DEGREE' }),
    ];
    const result = crossReferenceDocuments(anchors);
    const finding = result.findings[0];
    expect(finding.anchor_ids).toContain('anchor-A');
    expect(finding.anchor_ids).toContain('anchor-B');
  });

  it('returns sorted findings by severity (HIGH first)', () => {
    const anchors = [
      makeAnchor({ id: 'a1', extracted_name: 'John Smith', jurisdiction: 'US-CA' }),
      makeAnchor({ id: 'a2', extracted_name: 'Jane Doe', jurisdiction: 'US-NY', credential_type: 'DEGREE' }),
    ];
    const result = crossReferenceDocuments(anchors);
    if (result.findings.length >= 2) {
      const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      for (let i = 1; i < result.findings.length; i++) {
        expect(severityOrder[result.findings[i - 1].severity]).toBeLessThanOrEqual(
          severityOrder[result.findings[i].severity]
        );
      }
    }
  });
});
