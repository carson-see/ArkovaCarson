/**
 * AI-03 (SCRUM-2383) — TemplateReviewPanel MVP tests.
 *
 * Contract:
 *  - Gated by ENABLE_AI_EXTRACTION: flag off → panel ABSENT (not broken) and
 *    review is not required.
 *  - Low-confidence fields are visually flagged and REQUIRE acknowledgment or
 *    correction before review is complete.
 *  - All fields are editable; edits propagate via onFieldEdit and count as
 *    correction.
 *  - No document content or field values are ever logged from this component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  TemplateReviewPanel,
  LOW_CONFIDENCE_THRESHOLD,
} from './TemplateReviewPanel';
import { isAIExtractionEnabled } from '@/lib/switchboard';
import { TEMPLATE_REVIEW_LABELS } from '@/lib/copy';
import type { ExtractionField } from '../../lib/aiExtraction';

vi.mock('@/lib/switchboard', () => ({
  isAIExtractionEnabled: vi.fn(async () => true),
}));

const fields: ExtractionField[] = [
  { key: 'credentialType', value: 'CPE', confidence: 0.95, status: 'accepted' },
  { key: 'issuerName', value: 'Example Institute', confidence: 0.9, status: 'accepted' },
  { key: 'creditHours', value: '4', confidence: 0.42, status: 'suggested' },
  { key: 'issuedDate', value: '2026-03-01', confidence: 0.55, status: 'suggested' },
];

function makeProps(overrides: Partial<Parameters<typeof TemplateReviewPanel>[0]> = {}) {
  return {
    fields,
    overallConfidence: 0.8,
    onFieldEdit: vi.fn(),
    onReviewStateChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(isAIExtractionEnabled).mockReset();
  vi.mocked(isAIExtractionEnabled).mockResolvedValue(true);
});

describe('TemplateReviewPanel — flag gating', () => {
  it('renders NOTHING when ENABLE_AI_EXTRACTION is off (absent, not broken)', async () => {
    vi.mocked(isAIExtractionEnabled).mockResolvedValue(false);
    const props = makeProps();
    render(<TemplateReviewPanel {...props} />);

    await waitFor(() => {
      // Flag off → review must not block the flow.
      expect(props.onReviewStateChange).toHaveBeenCalledWith(true);
    });
    expect(screen.queryByTestId('template-review-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(TEMPLATE_REVIEW_LABELS.TITLE)).not.toBeInTheDocument();
  });

  it('renders the panel when the flag is on', async () => {
    render(<TemplateReviewPanel {...makeProps()} />);
    expect(await screen.findByTestId('template-review-panel')).toBeInTheDocument();
    expect(screen.getByText(TEMPLATE_REVIEW_LABELS.TITLE)).toBeInTheDocument();
  });
});

describe('TemplateReviewPanel — low-confidence review requirement', () => {
  it(`flags fields below the ${LOW_CONFIDENCE_THRESHOLD} threshold and reports review INCOMPLETE`, async () => {
    const props = makeProps();
    render(<TemplateReviewPanel {...props} />);
    await screen.findByTestId('template-review-panel');

    // Two low-confidence fields flagged
    expect(screen.getAllByText(TEMPLATE_REVIEW_LABELS.LOW_CONFIDENCE_BADGE)).toHaveLength(2);
    expect(screen.getByText(TEMPLATE_REVIEW_LABELS.REVIEW_REQUIRED_NOTICE)).toBeInTheDocument();
    await waitFor(() => {
      expect(props.onReviewStateChange).toHaveBeenLastCalledWith(false);
    });
  });

  it('review becomes COMPLETE once every low-confidence field is acknowledged', async () => {
    const props = makeProps();
    render(<TemplateReviewPanel {...props} />);
    await screen.findByTestId('template-review-panel');

    fireEvent.click(screen.getByTestId('review-ack-creditHours'));
    fireEvent.click(screen.getByTestId('review-ack-issuedDate'));

    await waitFor(() => {
      expect(props.onReviewStateChange).toHaveBeenLastCalledWith(true);
    });
    expect(screen.getByText(TEMPLATE_REVIEW_LABELS.ALL_REVIEWED_NOTICE)).toBeInTheDocument();
    expect(screen.getAllByText(TEMPLATE_REVIEW_LABELS.ACKNOWLEDGED_LABEL).length).toBeGreaterThan(0);
  });

  it('CORRECTING a low-confidence field also satisfies the review requirement', async () => {
    const editable: ExtractionField[] = [
      { key: 'credentialType', value: 'CPE', confidence: 0.95, status: 'accepted' },
      // status 'edited' = corrected by the user upstream
      { key: 'creditHours', value: '6', confidence: 0.42, status: 'edited' },
    ];
    const props = makeProps({ fields: editable });
    render(<TemplateReviewPanel {...props} />);
    await screen.findByTestId('template-review-panel');

    await waitFor(() => {
      expect(props.onReviewStateChange).toHaveBeenLastCalledWith(true);
    });
    expect(screen.getByText(TEMPLATE_REVIEW_LABELS.EDITED_BADGE)).toBeInTheDocument();
  });

  it('reports COMPLETE immediately when no field is low-confidence', async () => {
    const confident = fields.map((f) => ({ ...f, confidence: 0.95 }));
    const props = makeProps({ fields: confident });
    render(<TemplateReviewPanel {...props} />);
    await screen.findByTestId('template-review-panel');

    await waitFor(() => {
      expect(props.onReviewStateChange).toHaveBeenLastCalledWith(true);
    });
    expect(screen.queryByText(TEMPLATE_REVIEW_LABELS.LOW_CONFIDENCE_BADGE)).not.toBeInTheDocument();
  });
});

describe('TemplateReviewPanel — all fields editable', () => {
  it('every field (including high-confidence) has an edit control that propagates edits', async () => {
    const props = makeProps();
    render(<TemplateReviewPanel {...props} />);
    await screen.findByTestId('template-review-panel');

    for (const field of fields) {
      expect(screen.getByTestId(`review-edit-${field.key}`)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId('review-edit-issuerName'));
    const input = screen.getByTestId('review-input-issuerName');
    fireEvent.change(input, { target: { value: 'Corrected Institute' } });
    fireEvent.click(screen.getByTestId('review-save-issuerName'));

    expect(props.onFieldEdit).toHaveBeenCalledWith('issuerName', 'Corrected Institute');
  });

  it('cancelling an edit does not propagate', async () => {
    const props = makeProps();
    render(<TemplateReviewPanel {...props} />);
    await screen.findByTestId('template-review-panel');

    fireEvent.click(screen.getByTestId('review-edit-issuerName'));
    fireEvent.change(screen.getByTestId('review-input-issuerName'), {
      target: { value: 'Should Not Propagate' },
    });
    fireEvent.click(screen.getByTestId('review-cancel-issuerName'));

    expect(props.onFieldEdit).not.toHaveBeenCalled();
  });
});

describe('TemplateReviewPanel — telemetry value-omission (client side)', () => {
  it('never logs field values to the console on render or interaction', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const infoSpy = vi.spyOn(console, 'info');
    const warnSpy = vi.spyOn(console, 'warn');
    const errorSpy = vi.spyOn(console, 'error');

    const sentinel: ExtractionField[] = [
      { key: 'issuerName', value: 'PII-SENTINEL-VALUE-42', confidence: 0.3, status: 'suggested' },
    ];
    render(<TemplateReviewPanel {...makeProps({ fields: sentinel })} />);
    await screen.findByTestId('template-review-panel');
    fireEvent.click(screen.getByTestId('review-ack-issuerName'));

    const allCalls = JSON.stringify([
      logSpy.mock.calls,
      infoSpy.mock.calls,
      warnSpy.mock.calls,
      errorSpy.mock.calls,
    ]);
    expect(allCalls).not.toContain('PII-SENTINEL-VALUE-42');

    logSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
