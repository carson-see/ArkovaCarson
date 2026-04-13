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
});
