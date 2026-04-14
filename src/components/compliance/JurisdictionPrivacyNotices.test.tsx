/**
 * Tests for Jurisdiction-Specific Privacy Notices — REG-14 (SCRUM-575)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JurisdictionPrivacyNotices } from './JurisdictionPrivacyNotices';

describe('JurisdictionPrivacyNotices — REG-14', () => {
  it('renders all 6 jurisdictions when no filter is provided', () => {
    render(<JurisdictionPrivacyNotices />);

    // Each jurisdiction renders a card with its title
    const allText = document.body.textContent ?? '';
    expect(allText).toContain('FERPA');
    expect(allText).toContain('HIPAA');
    expect(allText).toContain('Kenya');
    expect(allText).toContain('Australian');
    expect(allText).toContain('POPIA');
    expect(allText).toContain('Nigeria');
  });

  it('filters to specific jurisdictions when provided', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['ferpa', 'hipaa']} />);

    expect(screen.getByText(/FERPA/)).toBeDefined();
    expect(screen.getByText(/HIPAA/)).toBeDefined();
    expect(screen.queryByText(/Kenya Data Protection Act/)).toBeNull();
    expect(screen.queryByText(/POPIA/)).toBeNull();
  });

  it('shows regulator links for each jurisdiction', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['kenya']} />);

    const link = screen.getByText(/Office of the Data Protection Commissioner/);
    expect(link).toBeDefined();
    expect(link.closest('a')?.getAttribute('href')).toBe('https://odpc.go.ke');
  });

  it('shows breach timelines for each jurisdiction', () => {
    render(<JurisdictionPrivacyNotices />);

    expect(screen.getByText(/72 hours.*ODPC/)).toBeDefined();
    expect(screen.getByText(/60 calendar days/)).toBeDefined();
    expect(screen.getByText(/30-day assessment/)).toBeDefined();
  });

  it('shows data subject rights badges', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['australia']} />);

    expect(screen.getByText('Access (APP 12)')).toBeDefined();
    expect(screen.getByText('Correction (APP 13)')).toBeDefined();
  });

  it('filters correctly with single jurisdiction', () => {
    const { container } = render(<JurisdictionPrivacyNotices jurisdictions={['nigeria']} />);

    const text = container.textContent ?? '';
    expect(text).toContain('Nigeria');
    expect(text).toContain('NDPC');
  });

  it('shows South Africa POPIA notice with Information Regulator details (REG-22)', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['south-africa']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).toContain('POPIA');
    expect(allText).toContain('Information Regulator');
    expect(allText).toContain('Section 23');
    expect(allText).toContain('Section 24');
    expect(allText).toContain('Section 72');
  });

  it('shows Nigeria NDPA notice with NDPC details (REG-25)', () => {
    render(<JurisdictionPrivacyNotices jurisdictions={['nigeria']} />);

    const allText = document.body.textContent ?? '';
    expect(allText).toContain('Nigeria Data Protection Act 2023');
    expect(allText).toContain('NDPC');
    expect(allText).toContain('Access');
    expect(allText).toContain('Rectification');
    expect(allText).toContain('Erasure');
    expect(allText).toContain('72 hours');
  });

  it('shows Information Officer contact for African jurisdictions (REG-28)', () => {
    render(<JurisdictionPrivacyNotices />);

    const links = document.querySelectorAll('a[href="mailto:privacy@arkova.ai"]');
    // Kenya, South Africa, and Nigeria should all show the DPO email
    expect(links.length).toBe(3);
  });

  it('shows cross-border transfer basis for all jurisdictions', () => {
    render(<JurisdictionPrivacyNotices />);

    const allText = document.body.textContent ?? '';
    // SA
    expect(allText).toContain('Section 72 binding agreement');
    // Nigeria
    expect(allText).toContain('Standard Contractual Clauses');
    // Kenya
    expect(allText).toContain('Section 48');
  });
});
