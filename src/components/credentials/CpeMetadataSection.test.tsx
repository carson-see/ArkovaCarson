/**
 * CpeMetadataSection Tests (SCRUM-1857 + SCRUM-1858 / CPE-R1-2, CPE-R1-3)
 *
 * Detail-view CPE section + public-verification display.
 *
 * Coverage:
 * - Udemy import fixture renders every CPE field (credit hours, provider,
 *   NASBA status, field of study, delivery method, completion date,
 *   evidence level).
 * - requires_manual_review === true renders the review banner.
 * - No section when the viewer lacks the credential_source_import entitlement.
 * - Public view: extraction_confidence MUST be absent from rendered output
 *   (snapshot guard).
 *
 * @see SCRUM-1847, SCRUM-1857, SCRUM-1858
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CpeMetadataSection, type CpeMetadataView } from './CpeMetadataSection';
import { CPE_COMPLIANCE_COPY } from './cpeComplianceCopy';

/**
 * Udemy import fixture — mirrors the worker `CpeMetadataSchema`
 * (services/worker/src/compliance/professional-education.ts) plus the
 * display-only fields (provider/title/completion_date/evidence_level)
 * the detail + public views surface from the parent anchor.
 */
const UDEMY_FIXTURE: CpeMetadataView = {
  credit_hours: 7,
  field_of_study: 'Information Technology',
  delivery_method: 'QAS Self-Study',
  nasba_status: 'confirmed',
  nasba_lookup_date: '2026-05-20',
  sponsor_id: '108297',
  reporting_period_start: '2026-01-01',
  reporting_period_end: '2026-12-31',
  extraction_confidence: 0.97,
  extraction_source: 'ai',
  requires_manual_review: false,
  provider: 'Udemy',
  title: 'Advanced Cloud Security for CPAs',
  completion_date: '2026-05-18',
  evidence_level: 'ai_captured',
};

describe('CpeMetadataSection — detail view', () => {
  it('renders all CPE fields for a Udemy import fixture', () => {
    render(<CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} hasImportEntitlement />);

    // Section heading
    expect(screen.getByText(CPE_COMPLIANCE_COPY.SECTION_TITLE)).toBeInTheDocument();

    // Title + provider
    expect(screen.getByText('Advanced Cloud Security for CPAs')).toBeInTheDocument();
    expect(screen.getByText('Udemy')).toBeInTheDocument();

    // NASBA badge label
    expect(
      screen.getByText(CPE_COMPLIANCE_COPY.NASBA_STATUS_LABELS.confirmed),
    ).toBeInTheDocument();

    // CPE credit hours (formatted)
    expect(screen.getByText(/7(\.0)? CPE credits/i)).toBeInTheDocument();

    // Field of study
    expect(screen.getByText('Information Technology')).toBeInTheDocument();

    // Delivery method
    expect(screen.getByText('QAS Self-Study')).toBeInTheDocument();

    // Completion date (rendered as a human date — not the raw ISO string)
    expect(screen.getByText(/May 18, 2026/)).toBeInTheDocument();
    expect(screen.queryByText('2026-05-18')).toBeNull();

    // Evidence level label present
    expect(screen.getByText(CPE_COMPLIANCE_COPY.FIELD_LABELS.evidence_level)).toBeInTheDocument();
  });

  it('renders the review banner when requires_manual_review is true', () => {
    render(
      <CpeMetadataSection
        cpeMetadata={{ ...UDEMY_FIXTURE, requires_manual_review: true }}
        hasImportEntitlement
      />,
    );
    const banner = screen.getByText(CPE_COMPLIANCE_COPY.REVIEW_BANNER);
    expect(banner).toBeInTheDocument();
    expect(banner).toBe(
      screen.getByText('CPE details require review — extracted fields may be incomplete.'),
    );
  });

  it('does NOT render the review banner when requires_manual_review is false', () => {
    render(<CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} hasImportEntitlement />);
    expect(screen.queryByText(CPE_COMPLIANCE_COPY.REVIEW_BANNER)).toBeNull();
  });

  it('renders an alert role on the review banner for assistive tech', () => {
    render(
      <CpeMetadataSection
        cpeMetadata={{ ...UDEMY_FIXTURE, requires_manual_review: true }}
        hasImportEntitlement
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(CPE_COMPLIANCE_COPY.REVIEW_BANNER);
  });

  describe('entitlement gating', () => {
    it('renders nothing for a user WITHOUT the credential_source_import entitlement', () => {
      const { container } = render(
        <CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} hasImportEntitlement={false} />,
      );
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByText(CPE_COMPLIANCE_COPY.SECTION_TITLE)).toBeNull();
    });

    it('renders nothing when there is no CPE metadata', () => {
      const { container } = render(
        <CpeMetadataSection cpeMetadata={null} hasImportEntitlement />,
      );
      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('extraction_confidence is internal-only', () => {
    it('never renders the extraction_confidence value in the detail view', () => {
      const { container } = render(
        <CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} hasImportEntitlement />,
      );
      expect(container.textContent).not.toContain('0.97');
      expect(container.textContent?.toLowerCase()).not.toContain('confidence');
    });
  });
});

describe('CpeMetadataSection — public verification view', () => {
  it('displays the NASBA badge and evidence level publicly', () => {
    render(<CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} publicView />);
    expect(
      screen.getByText(CPE_COMPLIANCE_COPY.NASBA_STATUS_LABELS.confirmed),
    ).toBeInTheDocument();
    expect(screen.getByText(CPE_COMPLIANCE_COPY.FIELD_LABELS.evidence_level)).toBeInTheDocument();
    // ai_captured maps to a human label via the shared evidence-level helper.
    expect(screen.getByText('AI-Captured Evidence')).toBeInTheDocument();
  });

  it('does not require the import entitlement to render publicly', () => {
    // Public verification is cross-tenant by design — anyone with the link can
    // view it, so entitlement gating does not apply on the public surface.
    render(<CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} publicView hasImportEntitlement={false} />);
    expect(screen.getByText(CPE_COMPLIANCE_COPY.SECTION_TITLE)).toBeInTheDocument();
  });

  it('snapshot: extraction_confidence is absent from the public rendered output', () => {
    const { container } = render(
      <CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} publicView />,
    );
    // Hard requirement (SCRUM-1858): the confidence score must never reach
    // the public surface — neither the value nor a "confidence" label.
    expect(container.textContent).not.toContain('0.97');
    expect(container.textContent?.toLowerCase()).not.toContain('confidence');
    expect(container).toMatchSnapshot();
  });

  it('omits extraction_source and reporting period internals from the public view', () => {
    const { container } = render(
      <CpeMetadataSection cpeMetadata={UDEMY_FIXTURE} publicView />,
    );
    expect(container.textContent?.toLowerCase()).not.toContain('extraction_source');
    expect(container.textContent).not.toContain('108297'); // sponsor_id internal id
  });
});
