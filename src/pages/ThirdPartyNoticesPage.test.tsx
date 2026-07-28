/**
 * Unit tests for ThirdPartyNoticesPage — the LGPL-3.0 / third-party notice
 * discharge page at /legal/third-party-notices (engineering-counsel review,
 * 2026-07-28).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThirdPartyNoticesPage } from './ThirdPartyNoticesPage';

describe('ThirdPartyNoticesPage', () => {
  it('renders the page heading', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Third-Party Notices' })).toBeDefined();
  });

  it('discloses libheif-js (LGPL-3.0) with its unmodified-source and license-text links', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    expect(screen.getByText(/libheif-js@1\.19\.8/)).toBeDefined();
    expect(screen.getByText('LGPL-3.0')).toBeDefined();
    expect(screen.getByText(/Used unmodified from the published upstream release\./)).toBeDefined();

    const lgplLink = screen.getByText(/License text \(www\.gnu\.org\/licenses\/lgpl-3\.0\.txt\)/);
    expect(lgplLink.closest('a')?.getAttribute('href')).toBe('https://www.gnu.org/licenses/lgpl-3.0.txt');

    const gplLink = screen.getByText(/License text \(www\.gnu\.org\/licenses\/gpl-3\.0\.txt\)/);
    expect(gplLink.closest('a')?.getAttribute('href')).toBe('https://www.gnu.org/licenses/gpl-3.0.txt');

    const sourceLink = screen.getByText('Unmodified upstream source');
    expect(sourceLink.closest('a')?.getAttribute('href')).toMatch(/^https:\/\/registry\.npmjs\.org\/libheif-js\//);
  });

  it('renders the general open-source dependency list', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    expect(screen.getByText('Open-source components')).toBeDefined();
    // Sanity check a couple of real, generated entries render (not exhaustive —
    // the exact set changes as the dependency tree changes).
    expect(screen.getAllByText(/^MIT$/).length).toBeGreaterThan(0);
  });

  it('does not include a fabricated xlsx entry (no such dependency exists in the tree)', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    expect(screen.queryByText(/^xlsx@/)).toBeNull();
  });
});
