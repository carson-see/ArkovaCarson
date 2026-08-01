/**
 * Unit tests for ThirdPartyNoticesPage — the LGPL-3.0 / third-party notice
 * discharge page at /legal/third-party-notices (engineering-counsel review,
 * 2026-07-28).
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThirdPartyNoticesPage } from './ThirdPartyNoticesPage';

describe('ThirdPartyNoticesPage', () => {
  it('renders the page heading', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Third-Party Notices' })).toBeDefined();
  });

  // Scoped to the libheif-js entry rather than the whole page: there is now
  // more than one pinned copyleft notice (jszip was added once we found it was
  // getting no attribution at all), and several of these strings — "Used
  // unmodified from the published upstream release." especially — legitimately
  // render once per entry. A page-wide getByText would break on every new
  // notice, which is the wrong pressure to put on adding attribution.
  function libheifEntry(): HTMLElement {
    const name = screen.getByText((_content, el) => el?.textContent === 'libheif-js@1.19.8');
    const entry = name.closest('li') ?? name.parentElement?.parentElement;
    if (!entry) throw new Error('could not locate the libheif-js notice entry');
    return entry as HTMLElement;
  }

  it('discloses libheif-js (LGPL-3.0) with its unmodified-source and license-text links', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    const entry = within(libheifEntry());

    expect(entry.getByText('LGPL-3.0')).toBeDefined();
    expect(entry.getByText(/Used unmodified from the published upstream release\./)).toBeDefined();

    const lgplLink = entry.getByText(/License text \(www\.gnu\.org\/licenses\/lgpl-3\.0\.txt\)/);
    expect(lgplLink.closest('a')?.getAttribute('href')).toBe('https://www.gnu.org/licenses/lgpl-3.0.txt');

    const gplLink = entry.getByText(/License text \(www\.gnu\.org\/licenses\/gpl-3\.0\.txt\)/);
    expect(gplLink.closest('a')?.getAttribute('href')).toBe('https://www.gnu.org/licenses/gpl-3.0.txt');

    const sourceLink = entry.getByText('Unmodified upstream source');
    expect(sourceLink.closest('a')?.getAttribute('href')).toMatch(/^https:\/\/registry\.npmjs\.org\/libheif-js\//);
  });

  // Regression guard for the attribution hole this PR closed: jszip is
  // allowlist-cleared copyleft used under its MIT option, so the generator
  // excluded it from the general list — and it had no pinned notice either, so
  // it appeared NOWHERE. Electing MIT is exactly what makes MIT attribution
  // load-bearing, so this is the case where the omission mattered most.
  it('discloses jszip, the dual-licensed dependency used under MIT', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    expect(
      screen.getByText((_content, el) => el?.textContent === 'jszip@3.10.1'),
    ).toBeDefined();
  });

  it('never badges a shipped component as not-yet-shipped (R-7)', () => {
    render(<MemoryRouter><ThirdPartyNoticesPage /></MemoryRouter>);
    // libheif-js ships today via heic-decode. A "pending" status here would
    // publicly disclaim a live attribution obligation.
    expect(screen.queryByText('In development — not yet shipped')).toBeNull();
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
