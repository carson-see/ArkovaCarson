/**
 * CleMetadataSection Tests (SCRUM-1869 / CLE-R1)
 *
 * Detail-view CLE section + public-verification display.
 *
 * Coverage:
 * - PLI import fixture renders every CLE field (total credit hours, ethics
 *   hours on a SEPARATE row, jurisdiction badge, provider approval badge,
 *   delivery format, completion date, evidence level).
 * - ethics_hours renders on its own row, distinct from total credit_hours.
 * - requires_manual_review === true renders the ethics-specific review banner.
 * - No section when the viewer lacks the credential_source_import entitlement.
 * - Public view: extraction_confidence MUST be absent from rendered output
 *   (snapshot guard).
 *
 * @see SCRUM-1869, SCRUM-1865
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CleMetadataSection, type CleMetadataView } from './CleMetadataSection';
import { CLE_COMPLIANCE_COPY } from './cleComplianceCopy';

/**
 * PLI (Practising Law Institute) import fixture — mirrors the worker
 * `CleMetadataSchema` (services/worker/src/compliance/professional-education.ts)
 * plus the display-only fields (course_title/completion_date/evidence_level)
 * the detail + public views surface from the parent anchor.
 */
const PLI_FIXTURE: CleMetadataView = {
  credit_hours: 6,
  ethics_hours: 2,
  jurisdiction: 'CA',
  delivery_format: 'On-Demand',
  approved_provider_name: 'Practising Law Institute',
  provider_approval_status: 'approved',
  provider_lookup_date: '2026-05-20',
  course_id: 'PLI-2026-0481',
  reporting_period_start: '2026-01-01',
  reporting_period_end: '2026-12-31',
  extraction_confidence: 0.97,
  extraction_source: 'ai',
  requires_manual_review: false,
  course_title: 'Advanced Trial Advocacy',
  completion_date: '2026-05-18',
  evidence_level: 'ai_captured',
};

describe('CleMetadataSection — detail view', () => {
  it('renders all CLE fields for a PLI import fixture', () => {
    render(<CleMetadataSection cleMetadata={PLI_FIXTURE} hasImportEntitlement />);

    // Section heading
    expect(screen.getByText(CLE_COMPLIANCE_COPY.SECTION_TITLE)).toBeInTheDocument();

    // Course title + provider
    expect(screen.getByText('Advanced Trial Advocacy')).toBeInTheDocument();
    expect(screen.getByText('Practising Law Institute')).toBeInTheDocument();

    // Provider approval badge label
    expect(
      screen.getByText(CLE_COMPLIANCE_COPY.PROVIDER_STATUS_LABELS.approved),
    ).toBeInTheDocument();

    // Total credit hours (formatted)
    expect(screen.getByText(/6(\.0)? CLE credits/i)).toBeInTheDocument();

    // Delivery format
    expect(screen.getByText('On-Demand')).toBeInTheDocument();

    // Completion date (rendered as a human date — not the raw ISO string)
    expect(screen.getByText(/May 18, 2026/)).toBeInTheDocument();
    expect(screen.queryByText('2026-05-18')).toBeNull();

    // Evidence level label present
    expect(screen.getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.evidence_level)).toBeInTheDocument();
  });

  describe('ethics hours on a separate row (first-class)', () => {
    it('renders ethics_hours on a distinct labeled row from total credit_hours', () => {
      render(<CleMetadataSection cleMetadata={PLI_FIXTURE} hasImportEntitlement />);

      // Both labels exist independently.
      const totalLabel = screen.getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.credit_hours);
      const ethicsLabel = screen.getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.ethics_hours);
      expect(totalLabel).toBeInTheDocument();
      expect(ethicsLabel).toBeInTheDocument();

      // They are different DOM rows (not the same node).
      const totalRow = totalLabel.closest('div');
      const ethicsRow = ethicsLabel.closest('div');
      expect(totalRow).not.toBeNull();
      expect(ethicsRow).not.toBeNull();
      expect(totalRow).not.toBe(ethicsRow);

      // The ethics value (2.0 ethics credits) lives in the ethics row,
      // and the total (6.0 CLE credits) lives in the total row.
      expect(within(ethicsRow as HTMLElement).getByText(/2(\.0)? ethics credits/i)).toBeInTheDocument();
      expect(within(totalRow as HTMLElement).getByText(/6(\.0)? CLE credits/i)).toBeInTheDocument();
    });

    it('does not infer ethics from total: a 0-ethics value renders as 0, not the total', () => {
      render(
        <CleMetadataSection
          cleMetadata={{ ...PLI_FIXTURE, ethics_hours: 0, requires_manual_review: false }}
          hasImportEntitlement
        />,
      );
      const ethicsRow = screen
        .getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.ethics_hours)
        .closest('div') as HTMLElement;
      expect(within(ethicsRow).getByText(/0(\.0)? ethics credits/i)).toBeInTheDocument();
    });

    it('omits the ethics row entirely when ethics_hours is null (unconfirmed)', () => {
      render(
        <CleMetadataSection
          cleMetadata={{ ...PLI_FIXTURE, ethics_hours: null }}
          hasImportEntitlement
        />,
      );
      // No ethics value row — null is "not confirmed", surfaced via the banner.
      expect(screen.queryByText(/ethics credits/i)).toBeNull();
      // Total credits still shown.
      expect(screen.getByText(/6(\.0)? CLE credits/i)).toBeInTheDocument();
    });
  });

  describe('jurisdiction badge', () => {
    it('renders the jurisdiction as a US state abbreviation', () => {
      render(<CleMetadataSection cleMetadata={PLI_FIXTURE} hasImportEntitlement />);
      const jurisdictionRow = screen
        .getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.jurisdiction)
        .closest('div') as HTMLElement;
      expect(within(jurisdictionRow).getByText('CA')).toBeInTheDocument();
    });

    it('strips a US- prefix down to the bare state abbreviation', () => {
      render(
        <CleMetadataSection
          cleMetadata={{ ...PLI_FIXTURE, jurisdiction: 'US-NY' }}
          hasImportEntitlement
        />,
      );
      const jurisdictionRow = screen
        .getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.jurisdiction)
        .closest('div') as HTMLElement;
      expect(within(jurisdictionRow).getByText('NY')).toBeInTheDocument();
    });
  });

  describe('review banner (ethics-specific language)', () => {
    it('renders the ethics-specific review banner when requires_manual_review is true', () => {
      render(
        <CleMetadataSection
          cleMetadata={{ ...PLI_FIXTURE, requires_manual_review: true }}
          hasImportEntitlement
        />,
      );
      const banner = screen.getByText(CLE_COMPLIANCE_COPY.REVIEW_BANNER);
      expect(banner).toBeInTheDocument();
      // Verbatim ethics-specific copy per AC.
      expect(banner).toBe(
        screen.getByText(
          'CLE details require review — extracted fields may be incomplete. Ethics hours not confirmed.',
        ),
      );
    });

    it('does NOT render the review banner when requires_manual_review is false', () => {
      render(<CleMetadataSection cleMetadata={PLI_FIXTURE} hasImportEntitlement />);
      expect(screen.queryByText(CLE_COMPLIANCE_COPY.REVIEW_BANNER)).toBeNull();
    });

    it('renders an alert role on the review banner for assistive tech', () => {
      render(
        <CleMetadataSection
          cleMetadata={{ ...PLI_FIXTURE, requires_manual_review: true }}
          hasImportEntitlement
        />,
      );
      expect(screen.getByRole('alert')).toHaveTextContent(CLE_COMPLIANCE_COPY.REVIEW_BANNER);
    });
  });

  describe('entitlement gating', () => {
    it('renders nothing for a user WITHOUT the credential_source_import entitlement', () => {
      const { container } = render(
        <CleMetadataSection cleMetadata={PLI_FIXTURE} hasImportEntitlement={false} />,
      );
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByText(CLE_COMPLIANCE_COPY.SECTION_TITLE)).toBeNull();
    });

    it('renders nothing when there is no CLE metadata', () => {
      const { container } = render(
        <CleMetadataSection cleMetadata={null} hasImportEntitlement />,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('extraction_confidence is internal-only', () => {
    it('never renders the extraction_confidence value in the detail view', () => {
      const { container } = render(
        <CleMetadataSection cleMetadata={PLI_FIXTURE} hasImportEntitlement />,
      );
      expect(container.textContent).not.toContain('0.97');
      expect(container.textContent?.toLowerCase()).not.toContain('confidence');
    });
  });

  describe('evidence level formatting', () => {
    it('humanizes an unrecognized snake_case evidence level', () => {
      // Drives the fallback path when the shared evidence-level helper has no
      // mapped label: "field_observed" → "Field Observed".
      render(
        <CleMetadataSection
          cleMetadata={{ ...PLI_FIXTURE, evidence_level: 'field_observed' }}
          hasImportEntitlement
        />,
      );
      const evidenceRow = screen
        .getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.evidence_level)
        .closest('div') as HTMLElement;
      expect(within(evidenceRow).getByText('Field Observed')).toBeInTheDocument();
    });
  });
});

describe('CleMetadataSection — public verification view', () => {
  it('displays the provider approval badge and jurisdiction publicly', () => {
    render(<CleMetadataSection cleMetadata={PLI_FIXTURE} publicView />);
    expect(
      screen.getByText(CLE_COMPLIANCE_COPY.PROVIDER_STATUS_LABELS.approved),
    ).toBeInTheDocument();
    const jurisdictionRow = screen
      .getByText(CLE_COMPLIANCE_COPY.FIELD_LABELS.jurisdiction)
      .closest('div') as HTMLElement;
    expect(within(jurisdictionRow).getByText('CA')).toBeInTheDocument();
  });

  it('does not require the import entitlement to render publicly', () => {
    // Public verification is cross-tenant by design — anyone with the link can
    // view it, so entitlement gating does not apply on the public surface.
    render(<CleMetadataSection cleMetadata={PLI_FIXTURE} publicView hasImportEntitlement={false} />);
    expect(screen.getByText(CLE_COMPLIANCE_COPY.SECTION_TITLE)).toBeInTheDocument();
  });

  it('snapshot: extraction_confidence is absent from the public rendered output', () => {
    const { container } = render(
      <CleMetadataSection cleMetadata={PLI_FIXTURE} publicView />,
    );
    // Hard requirement (SCRUM-1869 AC): the confidence score must never reach
    // the public surface — neither the value nor a "confidence" label.
    expect(container.textContent).not.toContain('0.97');
    expect(container.textContent?.toLowerCase()).not.toContain('confidence');
    // Normalize React's non-deterministic useId() values (the tooltip
    // aria-describedby/id pair) so the snapshot is stable regardless of how
    // many components rendered earlier in the suite — the snapshot guards the
    // rendered structure, not the opaque id.
    const html = container.innerHTML.replace(/«?_?r[a-z0-9]+_?»?/g, 'CLE_ID');
    expect(html).toMatchSnapshot();
  });

  it('omits extraction_source and reporting period internals from the public view', () => {
    const { container } = render(
      <CleMetadataSection cleMetadata={PLI_FIXTURE} publicView />,
    );
    expect(container.textContent?.toLowerCase()).not.toContain('extraction_source');
    expect(container.textContent).not.toContain('PLI-2026-0481'); // course_id internal
  });
});
