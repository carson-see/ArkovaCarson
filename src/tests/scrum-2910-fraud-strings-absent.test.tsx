/**
 * SCRUM-2910 — Fraud strings absent (durable DOM regression guard).
 *
 * BUG-2026-07-17-009 / BUG-2026-07-17-010 (P0): fraud-derived metadata and the
 * old "Document Risk Assessment" surface must NEVER render on any user-facing
 * result view. PR #1569 removed the fraud *display* surfaces (filtered `fraud_*`
 * metadata keys out of the shared credential card + records rows) and this task
 * (SCRUM-2910 remainder) deleted the remaining dead fraud *code*
 * (`RiskAssessmentReport` component + `FRAUD_DETECTION_LABELS` copy constant).
 *
 * This suite is the standing guard that ties both halves together: it renders
 * the metadata-bearing result surfaces with a deliberately fraud-laden metadata
 * payload (historical `fraud_*` keys + Gemini camelCase `fraudSignals`) and
 * asserts that ZERO fraud strings — the generic terms AND every former
 * `FRAUD_DETECTION_LABELS` string — reach the DOM. If anyone reintroduces a
 * fraud label constant, a risk-score badge, or an unfiltered metadata key, one
 * of these assertions fails.
 *
 * @see docs/eval/fraud-concerns-inventory (historical) — the surfaces enumerated here.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CredentialRenderer } from '@/components/credentials/CredentialRenderer';
import { RecordsList, type Record } from '@/components/records/RecordsList';
import type { TemplateDisplayData } from '@/hooks/useCredentialTemplate';

// The credential card copies fingerprints to the clipboard on interaction; stub
// it so a render-only test doesn't touch the real (undefined-in-jsdom) API.
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

/**
 * A metadata payload that mixes legitimate fields with every historical shape
 * of fraud-derived metadata we have observed on real anchors:
 *  - snake_case `fraud_*` keys written by the client-side worker,
 *  - a camelCase `fraudSignals` field emitted by Gemini extraction,
 *  - nested signal objects,
 *  - a numeric risk score value (0.87) that must never surface.
 */
const FRAUD_LADEN_METADATA: Record['metadata'] = {
  institution: 'University of Michigan',
  degree: 'Bachelor of Science',
  field_of_study: 'Computer Science',
  fraud_score: 0.87,
  fraud_risk_level: 'high',
  fraud_analysis_method: 'client_side_worker_v2',
  fraud_signals: [{ signal_type: 'future_date', score: 0.35 }],
  fraudSignals: '["Font inconsistency detected"]',
  'Fraud-Risk-Level': 'critical',
};

/**
 * Strings that must never appear on any result surface: the generic fraud/risk
 * vocabulary plus every literal string that the deleted `FRAUD_DETECTION_LABELS`
 * constant used to render. Kept as literals (not imports) on purpose — the whole
 * point is that these strings have no home in the codebase anymore.
 */
const FORBIDDEN_STRINGS = [
  // Generic vocabulary
  'fraud',
  'risk assessment',
  'risk score',
  'risk level',
  // Former FRAUD_DETECTION_LABELS values
  'document risk assessment',
  'visual analysis of document authenticity indicators',
  'analyze document',
  'analyzing document',
  'low risk',
  'medium risk',
  'high risk',
  'critical risk',
  'no risk assessment available',
  'detection signals',
  'font analysis',
  'layout analysis',
  'image manipulation',
  'metadata consistency',
  'security features',
];

function expectNoFraudStrings(textContent: string | null | undefined) {
  const haystack = (textContent ?? '').toLowerCase();
  for (const needle of FORBIDDEN_STRINGS) {
    expect(haystack).not.toContain(needle);
  }
  // The specific risk-score value must not leak in any format (raw or percent).
  expect(haystack).not.toContain('0.87');
  expect(haystack).not.toContain('87%');
}

const TEMPLATE: TemplateDisplayData = {
  name: "Bachelor's Degree",
  fields: [
    { key: 'institution', label: 'Institution', type: 'text' },
    { key: 'degree', label: 'Degree', type: 'text' },
    { key: 'field_of_study', label: 'Field of Study', type: 'text' },
  ],
};

describe('SCRUM-2910 — no fraud strings on any result surface', () => {
  describe('CredentialRenderer (shared owner detail + public verification card)', () => {
    it('renders legitimate fields but never fraud-derived metadata (template mode)', () => {
      const { container, queryByText } = render(
        <CredentialRenderer
          template={TEMPLATE}
          metadata={FRAUD_LADEN_METADATA}
          credentialType="DEGREE"
          status="SECURED"
        />,
      );
      // Sanity: a legitimate field still renders — the guard isn't vacuously green.
      expect(queryByText('Computer Science')).toBeInTheDocument();
      expectNoFraudStrings(container.textContent);
    });

    it('never renders fraud metadata in key-value mode (no template)', () => {
      const { container } = render(
        <CredentialRenderer metadata={FRAUD_LADEN_METADATA} status="SECURED" />,
      );
      expectNoFraudStrings(container.textContent);
    });
  });

  describe('RecordsList (owner records rows)', () => {
    it('never renders fraud metadata in a secured row', () => {
      const record: Record = {
        id: 'rec-1',
        filename: 'diploma.pdf',
        fingerprint: 'a'.repeat(64),
        status: 'SECURED',
        createdAt: '2026-04-01T10:30:00Z',
        securedAt: '2026-04-01T12:00:00Z',
        fileSize: 102400,
        publicId: 'ARK-DOC-1',
        metadata: FRAUD_LADEN_METADATA,
      };
      const { container } = render(<RecordsList records={[record]} />);
      expectNoFraudStrings(container.textContent);
    });
  });
});
