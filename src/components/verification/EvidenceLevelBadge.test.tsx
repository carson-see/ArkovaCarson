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

// ─── SCRUM-2481: badge / provenance honesty ──────────────────────────────────
describe('EvidenceLevelBadge — SCRUM-2481 honesty guarantees', () => {
  const ALL_TIERS = [
    'issuer_anchored',
    'source_signed',
    'account_linked',
    'captured_url',
    'ai_captured',
  ] as const;

  const ISSUER_TIERS = ['issuer_anchored', 'source_signed'] as const;
  const NON_ISSUER_TIERS = ['account_linked', 'captured_url', 'ai_captured'] as const;

  it('tags every tier with a distinct data-evidence-tier attribute', () => {
    const seen = new Set<string>();
    for (const tier of ALL_TIERS) {
      const { container, unmount } = render(<EvidenceLevelBadge level={tier} />);
      const badge = container.querySelector('[data-evidence-tier]');
      expect(badge).not.toBeNull();
      const attr = badge!.getAttribute('data-evidence-tier');
      expect(attr).toBe(tier);
      expect(seen.has(attr!)).toBe(false);
      seen.add(attr!);
      unmount();
    }
    expect(seen.size).toBe(ALL_TIERS.length);
  });

  it('renders a distinct alt/aria-label per tier (no two tiers share label text)', () => {
    const labels = new Set<string>();
    for (const tier of ALL_TIERS) {
      const { container, unmount } = render(<EvidenceLevelBadge level={tier} />);
      const badge = container.querySelector('[data-evidence-tier]') as HTMLElement;
      const label = badge.getAttribute('aria-label');
      expect(label).toBeTruthy();
      expect(labels.has(label!)).toBe(false);
      labels.add(label!);
      unmount();
    }
    expect(labels.size).toBe(ALL_TIERS.length);
  });

  it('renders visually distinct icon artwork per tier (distinct svg per tier)', () => {
    const iconSignatures = new Set<string>();
    for (const tier of ALL_TIERS) {
      const { container, unmount } = render(<EvidenceLevelBadge level={tier} />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      // lucide sets a stable class token per icon (e.g. "lucide-shield-check")
      const iconClass = Array.from(svg!.classList).find((c) => c.startsWith('lucide-'));
      expect(iconClass).toBeTruthy();
      iconSignatures.add(iconClass!);
      unmount();
    }
    expect(iconSignatures.size).toBe(ALL_TIERS.length);
  });

  it.each(ISSUER_TIERS)('applies the green issuer treatment for %s', (tier) => {
    render(<EvidenceLevelBadge level={tier} />);
    const badge = screen.getByTestId('evidence-level-badge');
    expect(badge.className).toContain('green');
  });

  it.each(NON_ISSUER_TIERS)(
    'NEVER applies the green issuer treatment for %s',
    (tier) => {
      render(<EvidenceLevelBadge level={tier} />);
      const badge = screen.getByTestId('evidence-level-badge');
      expect(badge.className).not.toContain('green');
    }
  );

  it.each(NON_ISSUER_TIERS)(
    'alt/aria for %s contains NO issuer-family wording (Verified / Issuer / Authenticated)',
    (tier) => {
      const { container } = render(<EvidenceLevelBadge level={tier} />);
      const badge = container.querySelector('[data-evidence-tier]') as HTMLElement;
      const label = (badge.getAttribute('aria-label') ?? '').toLowerCase();
      expect(label).not.toContain('verified');
      expect(label).not.toContain('issuer');
      expect(label).not.toContain('authenticated');
    }
  );

  it('routes the green treatment through the issuer-auth gate for showDescription mode too', () => {
    render(<EvidenceLevelBadge level="captured_url" showDescription />);
    const badge = screen.getByTestId('evidence-level-badge');
    expect(badge.className).not.toContain('green');
    const labelled = badge.getAttribute('aria-label') ?? '';
    expect(labelled.toLowerCase()).not.toContain('verified');
  });
});
