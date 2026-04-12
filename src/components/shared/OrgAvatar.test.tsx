import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrgAvatar } from './OrgAvatar';

describe('OrgAvatar', () => {
  it('renders logo image when logoUrl is provided', () => {
    render(<OrgAvatar logoUrl="https://example.com/logo.png" displayName="Test Org" />);
    const img = screen.getByAltText('Test Org logo');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('https://example.com/logo.png');
  });

  it('renders initials when no logoUrl but displayName provided', () => {
    render(<OrgAvatar displayName="Test Organization" />);
    expect(screen.getByText('TO')).toBeTruthy();
  });

  it('renders single-word name initials (first 2 chars)', () => {
    render(<OrgAvatar displayName="Arkova" />);
    expect(screen.getByText('AR')).toBeTruthy();
  });

  it('renders Building2 icon when no logo or name', () => {
    const { container } = render(<OrgAvatar />);
    // lucide-react renders an SVG
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('renders Building2 icon when displayName is empty string', () => {
    const { container } = render(<OrgAvatar displayName="" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
  });

  it('applies size classes correctly', () => {
    const { container: sm } = render(<OrgAvatar displayName="A" size="sm" />);
    expect(sm.firstElementChild?.className).toContain('h-8');

    const { container: lg } = render(<OrgAvatar displayName="A" size="lg" />);
    expect(lg.firstElementChild?.className).toContain('h-28');
  });

  it('prefers logo over initials', () => {
    render(<OrgAvatar logoUrl="https://example.com/logo.png" displayName="Test Org" />);
    expect(screen.queryByText('TO')).toBeNull();
    expect(screen.getByAltText('Test Org logo')).toBeTruthy();
  });

  it('handles null logoUrl gracefully', () => {
    render(<OrgAvatar logoUrl={null} displayName="Test" />);
    expect(screen.getByText('TE')).toBeTruthy();
  });
});
