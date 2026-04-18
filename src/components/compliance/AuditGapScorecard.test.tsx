/**
 * AuditGapScorecard — tests (NCA-FU1 #2)
 *
 * Covers:
 *   - Renders gap list
 *   - Filters by jurisdiction via dropdown
 *   - Filters by gap type via dropdown
 *   - Combined filters
 *   - Empty state
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuditGapScorecard } from './AuditGapScorecard';
import type { AuditGap } from './AuditGapScorecard';

const SAMPLE_GAPS: AuditGap[] = [
  {
    type: 'LICENSE',
    category: 'MISSING',
    requirement: 'Upload professional license',
    jurisdiction_code: 'US-CA',
    industry_code: 'accounting',
    regulatory_reference: 'CA BPC 5000',
    severity: 'critical',
    remediation_hint: 'Upload the current professional license.',
  },
  {
    type: 'CERTIFICATE',
    category: 'EXPIRED',
    requirement: 'Renew expired CERTIFICATE',
    jurisdiction_code: 'US-NY',
    industry_code: 'accounting',
    regulatory_reference: null,
    severity: 'high',
    remediation_hint: 'Provide the industry-specific certificate.',
    days_remaining: -5,
    anchor_id: 'a-cert',
  },
  {
    type: 'CONTINUING_EDUCATION',
    category: 'EXPIRING_SOON',
    requirement: 'Renew CONTINUING_EDUCATION',
    jurisdiction_code: 'US-CA',
    industry_code: 'accounting',
    regulatory_reference: null,
    severity: 'medium',
    remediation_hint: 'Record the CE cycle completion.',
    days_remaining: 15,
    anchor_id: 'a-ce',
  },
  {
    type: 'DEGREE',
    category: 'INSUFFICIENT',
    requirement: 'Re-verify DEGREE (fraud flags raised)',
    jurisdiction_code: 'US-NY',
    industry_code: 'accounting',
    regulatory_reference: null,
    severity: 'critical',
    remediation_hint: 'Replace with a clean re-verification.',
    anchor_id: 'a-deg',
  },
];

function renderWithRouter(gaps: AuditGap[], initialEntries = ['/compliance/scorecard']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuditGapScorecard gaps={gaps} />
    </MemoryRouter>,
  );
}

describe('AuditGapScorecard — NCA-FU1 #2', () => {
  it('renders all gaps when no filters are active', () => {
    renderWithRouter(SAMPLE_GAPS);
    expect(screen.getByText('Upload professional license')).toBeDefined();
    expect(screen.getByText('Renew expired CERTIFICATE')).toBeDefined();
    expect(screen.getByText(/Renew CONTINUING_EDUCATION/)).toBeDefined();
    expect(screen.getByText(/Re-verify DEGREE/)).toBeDefined();
  });

  it('renders jurisdiction filter dropdown with unique values', () => {
    renderWithRouter(SAMPLE_GAPS);
    const jurisdictionSelect = screen.getByLabelText('Jurisdiction');
    expect(jurisdictionSelect).toBeDefined();
    expect(jurisdictionSelect.querySelectorAll('option').length).toBe(3); // "All" + US-CA + US-NY
  });

  it('renders gap type filter dropdown with all 4 categories', () => {
    renderWithRouter(SAMPLE_GAPS);
    const gapTypeSelect = screen.getByLabelText('Gap type');
    expect(gapTypeSelect).toBeDefined();
    expect(gapTypeSelect.querySelectorAll('option').length).toBe(5); // "All" + 4 categories
  });

  it('filters gaps by jurisdiction', () => {
    renderWithRouter(SAMPLE_GAPS);
    const jurisdictionSelect = screen.getByLabelText('Jurisdiction');
    fireEvent.change(jurisdictionSelect, { target: { value: 'US-NY' } });

    expect(screen.queryByText('Upload professional license')).toBeNull();
    expect(screen.getByText('Renew expired CERTIFICATE')).toBeDefined();
    expect(screen.getByText(/Re-verify DEGREE/)).toBeDefined();
  });

  it('filters gaps by gap type', () => {
    renderWithRouter(SAMPLE_GAPS);
    const gapTypeSelect = screen.getByLabelText('Gap type');
    fireEvent.change(gapTypeSelect, { target: { value: 'MISSING' } });

    expect(screen.getByText('Upload professional license')).toBeDefined();
    expect(screen.queryByText('Renew expired CERTIFICATE')).toBeNull();
    expect(screen.queryByText(/Renew CONTINUING_EDUCATION/)).toBeNull();
  });

  it('applies combined jurisdiction + gap type filter', () => {
    renderWithRouter(SAMPLE_GAPS);
    const jurisdictionSelect = screen.getByLabelText('Jurisdiction');
    const gapTypeSelect = screen.getByLabelText('Gap type');

    fireEvent.change(jurisdictionSelect, { target: { value: 'US-CA' } });
    fireEvent.change(gapTypeSelect, { target: { value: 'EXPIRING_SOON' } });

    expect(screen.queryByText('Upload professional license')).toBeNull();
    expect(screen.getByText(/Renew CONTINUING_EDUCATION/)).toBeDefined();
  });

  it('shows empty state when no gaps match', () => {
    renderWithRouter(SAMPLE_GAPS);
    const jurisdictionSelect = screen.getByLabelText('Jurisdiction');
    const gapTypeSelect = screen.getByLabelText('Gap type');

    fireEvent.change(jurisdictionSelect, { target: { value: 'US-CA' } });
    fireEvent.change(gapTypeSelect, { target: { value: 'INSUFFICIENT' } });

    expect(screen.getByText('No gaps match the selected filters.')).toBeDefined();
  });

  it('shows empty state when gaps array is empty', () => {
    renderWithRouter([]);
    expect(screen.getByText('No compliance gaps detected.')).toBeDefined();
  });

  it('reads initial filter from URL search params', () => {
    renderWithRouter(SAMPLE_GAPS, ['/compliance/scorecard?jurisdiction=US-NY&gapType=EXPIRED']);

    expect(screen.queryByText('Upload professional license')).toBeNull();
    expect(screen.getByText('Renew expired CERTIFICATE')).toBeDefined();
    expect(screen.queryByText(/Re-verify DEGREE/)).toBeNull();
  });
});
