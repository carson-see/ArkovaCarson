/**
 * SCRUM-2938 S1 — terminology-scrub copy contract.
 *
 * Locks the S1 copy-level changes so a future edit can't silently regress the
 * scrubbed user-facing vocabulary:
 *   1. the generic "Imported Records" surface labels its items "documents"
 *      (not the restricted "credentials" term);
 *   2. the deprecated "Compliance Intelligence" / "Nessie" / "compliance score"
 *      phrasings are gone from user-facing copy;
 *   3. the copy moved out of inline JSX (ComplianceDashboardPage access-restricted
 *      card + DocumentsPage "Issued to Me" empty state) lives in copy.ts.
 *
 * The full 228-occurrence noun purge is DEFERRED to S2 — this test only guards
 * the S1 slice, so it deliberately does NOT assert the absence of "credential"
 * everywhere.
 */

import { describe, expect, it } from 'vitest';
import {
  MY_CREDENTIALS_LABELS,
  COMPLIANCE_LABELS,
  NESSIE_LABELS,
  AUDIT_MY_ORG_LABELS,
  DOCUMENTS_PAGE_LABELS,
} from './copy';

describe('SCRUM-2938 S1 — Imported Records surface', () => {
  it('titles the surface "Imported Records" (nav + page)', () => {
    expect(MY_CREDENTIALS_LABELS.PAGE_TITLE).toBe('Imported Records');
    expect(MY_CREDENTIALS_LABELS.NAV_LABEL).toBe('Imported Records');
  });

  it('labels generic items as documents, not credentials', () => {
    expect(MY_CREDENTIALS_LABELS.PAGE_SUBTITLE).toBe(
      'Documents issued to you or imported from public sources.',
    );
    expect(MY_CREDENTIALS_LABELS.EMPTY_TITLE).toBe('No documents yet');
    expect(MY_CREDENTIALS_LABELS.EMPTY_DESC).toBe(
      'When organizations issue documents to your email address, they will appear here.',
    );
    expect(MY_CREDENTIALS_LABELS.CREDENTIAL_COUNT).toBe('{count} documents');

    for (const v of [
      MY_CREDENTIALS_LABELS.PAGE_TITLE,
      MY_CREDENTIALS_LABELS.NAV_LABEL,
      MY_CREDENTIALS_LABELS.PAGE_SUBTITLE,
      MY_CREDENTIALS_LABELS.EMPTY_TITLE,
      MY_CREDENTIALS_LABELS.EMPTY_DESC,
      MY_CREDENTIALS_LABELS.CREDENTIAL_COUNT,
    ]) {
      expect(v.toLowerCase()).not.toContain('credential');
    }
  });
});

describe('SCRUM-2938 S1 — killed compliance-intelligence / Nessie / compliance-score copy', () => {
  it('Compliance dashboard title drops "Compliance Intelligence"', () => {
    expect(COMPLIANCE_LABELS.PAGE_TITLE).toBe('Compliance Dashboard');
    expect(COMPLIANCE_LABELS.PAGE_TITLE.toLowerCase()).not.toContain('intelligence');
  });

  // The intelligence-PANEL keys this used to assert over (PANEL_TITLE,
  // EMPTY_STATE, TASK_*, CONFIDENCE*) no longer exist: the panel was mounted
  // ungated on a customer-reachable route while Nessie is OFF by founder
  // directive, so the component and its vocabulary were deleted rather than
  // rescrubbed. The S1 terminology contract is not weakened by that — copy that
  // does not exist cannot carry the codename. It is now enforced two ways:
  // structurally by src/lib/nessie-surfaces-offline.test.ts (nothing may mount
  // a Nessie surface), and for the surviving keys below.
  it('Nessie codename + "compliance intelligence" gone from the surviving insights copy', () => {
    expect(NESSIE_LABELS.INSIGHTS_TITLE).toBe('Document Insights');
    for (const v of Object.values(NESSIE_LABELS)) {
      expect(v.toLowerCase()).not.toContain('nessie');
      expect(v.toLowerCase()).not.toContain('compliance intelligence');
    }
  });

  it('the deleted intelligence-panel copy has not crept back into the vocabulary', () => {
    const keys = Object.keys(NESSIE_LABELS);
    // Every surviving key belongs to NessieInsights (components/anchor).
    expect(keys.every((k) => k.startsWith('INSIGHTS_'))).toBe(true);
    // No confidence vocabulary survives anywhere in this export (SCRUM-2914).
    for (const [k, v] of Object.entries(NESSIE_LABELS)) {
      expect(k.toLowerCase()).not.toContain('confidence');
      expect(v.toLowerCase()).not.toContain('confidence');
    }
  });

  it('audit scorecard drops "compliance score"', () => {
    expect(AUDIT_MY_ORG_LABELS.SCORECARD_TITLE).toBe('Audit scorecard');
    for (const v of [
      AUDIT_MY_ORG_LABELS.SCORECARD_TITLE,
      AUDIT_MY_ORG_LABELS.SCORECARD_EMPTY,
    ]) {
      expect(v.toLowerCase()).not.toContain('compliance score');
    }
  });
});

describe('SCRUM-2938 S1 — copy moved out of inline JSX into copy.ts', () => {
  it('ComplianceDashboardPage access-restricted card is sourced from COMPLIANCE_LABELS', () => {
    expect(COMPLIANCE_LABELS.ACCESS_RESTRICTED_TITLE).toBe('Access Restricted');
    expect(COMPLIANCE_LABELS.ACCESS_RESTRICTED_BODY).toBe(
      'The Compliance dashboard is available to organization administrators. Contact your admin for access.',
    );
    expect(COMPLIANCE_LABELS.ACCESS_RESTRICTED_BODY.toLowerCase()).not.toContain(
      'compliance intelligence',
    );
  });

  it('DocumentsPage "Issued to Me" empty state is sourced from DOCUMENTS_PAGE_LABELS', () => {
    expect(DOCUMENTS_PAGE_LABELS.RECEIVED_EMPTY_TITLE).toBe('No documents yet');
    expect(DOCUMENTS_PAGE_LABELS.RECEIVED_EMPTY_DESC).toBe(
      'When organizations issue documents to your email address, they will appear here.',
    );
    for (const v of [
      DOCUMENTS_PAGE_LABELS.RECEIVED_EMPTY_TITLE,
      DOCUMENTS_PAGE_LABELS.RECEIVED_EMPTY_DESC,
    ]) {
      expect(v.toLowerCase()).not.toContain('credential');
    }
  });
});
