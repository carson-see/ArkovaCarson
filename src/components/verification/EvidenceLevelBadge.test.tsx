/**
 * EvidenceLevelBadge Tests (CSI-03 / SCRUM-1599)
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvidenceLevelBadge } from './EvidenceLevelBadge';

describe('EvidenceLevelBadge', () => {
  it('renders nothing for null level', () => {
    const { container } = render(<EvidenceLevelBadge level={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for undefined level', () => {
    const { container } = render(<EvidenceLevelBadge level={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for unknown level', () => {
    const { container } = render(<EvidenceLevelBadge level="unknown_junk" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders "Issuer Anchored" label for issuer_anchored', () => {
    render(<EvidenceLevelBadge level="issuer_anchored" />);
    expect(screen.getByText('Issuer Anchored')).toBeInTheDocument();
  });

  it('renders "Source Signed" label for source_signed', () => {
    render(<EvidenceLevelBadge level="source_signed" />);
    expect(screen.getByText('Source Signed')).toBeInTheDocument();
  });

  it('renders "Account Linked" label for account_linked', () => {
    render(<EvidenceLevelBadge level="account_linked" />);
    expect(screen.getByText('Account Linked')).toBeInTheDocument();
  });

  it('renders "Captured URL Evidence" label for captured_url', () => {
    render(<EvidenceLevelBadge level="captured_url" />);
    expect(screen.getByText('Captured URL Evidence')).toBeInTheDocument();
  });

  it('renders "AI-Captured Evidence" label for ai_captured', () => {
    render(<EvidenceLevelBadge level="ai_captured" />);
    expect(screen.getByText('AI-Captured Evidence')).toBeInTheDocument();
  });

  it('applies green styling for strong evidence', () => {
    render(<EvidenceLevelBadge level="issuer_anchored" />);
    const badge = screen.getByTestId('evidence-level-badge');
    expect(badge.className).toContain('green');
  });

  it('applies blue styling for account_linked', () => {
    render(<EvidenceLevelBadge level="account_linked" />);
    const badge = screen.getByTestId('evidence-level-badge');
    expect(badge.className).toContain('blue');
  });

  it('applies amber styling for weaker evidence', () => {
    render(<EvidenceLevelBadge level="captured_url" />);
    const badge = screen.getByTestId('evidence-level-badge');
    expect(badge.className).toContain('amber');
  });

  it('renders evidence level label when showDescription is true', () => {
    render(<EvidenceLevelBadge level="captured_url" showDescription />);
    expect(screen.getByText('Evidence Level')).toBeInTheDocument();
    expect(screen.getByText('Captured URL Evidence')).toBeInTheDocument();
  });
});
