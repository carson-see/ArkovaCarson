/**
 * ThirdPartyNoticesPage — license text + copyright rendering (SCRUM-3559)
 *
 * The notices page must include copyright lines and full license text, not
 * just SPDX identifiers + links. This suite mocks the generated JSON module
 * so it pins page BEHAVIOR (what renders for which fields), independent of
 * the current dependency tree; the sibling `ThirdPartyNoticesPage.test.tsx`
 * keeps testing against the real generated data.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const FIXTURE = vi.hoisted(() => ({
  generatedAt: '2026-08-30T00:00:00.000Z',
  generalDependencies: [
    {
      name: 'left-pad',
      version: '1.3.0',
      license: 'MIT',
      repository: 'https://github.com/example/left-pad',
      copyright: 'Copyright (c) 2018 Example Author',
      licenseText:
        'The MIT License (MIT)\n\nCopyright (c) 2018 Example Author\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.',
    },
    {
      name: 'no-license-file-dep',
      version: '2.0.0',
      license: 'ISC',
    },
  ],
  copyleftDependencies: [
    {
      name: 'example-zip',
      version: '3.10.1',
      license: 'MIT OR GPL-3.0-or-later',
      repository: 'https://github.com/example/example-zip',
      sourceUrl: 'https://registry.npmjs.org/example-zip/-/example-zip-3.10.1.tgz',
      status: 'active',
      statusNote: 'Ships today in a lazy chunk; used under the MIT option.',
      unmodified: true,
      copyright: 'Copyright (c) 2009-2016 Example Zip Authors',
      licenseText: 'Example Zip is dual licensed. You may use it under the MIT license.',
      licenseTextUrls: ['https://raw.githubusercontent.com/example/example-zip/main/LICENSE.markdown'],
      licenseTextNote: 'Used under the MIT option of the dual license.',
    },
    {
      name: 'example-pending-lib',
      version: '9.9.9',
      license: 'LGPL-3.0',
      repository: 'https://github.com/example/example-pending-lib',
      status: 'pending',
      statusNote: 'Arrives via an in-flight dependency change.',
      unmodified: true,
      licenseTextUrls: ['https://www.gnu.org/licenses/lgpl-3.0.txt', 'https://www.gnu.org/licenses/gpl-3.0.txt'],
      licenseTextNote: 'LGPL-3.0 incorporates the GNU GPL v3 by reference; both texts are linked.',
    },
  ],
}));

vi.mock('@/data/thirdPartyNotices.generated.json', () => ({ default: FIXTURE }));

import { ThirdPartyNoticesPage } from './ThirdPartyNoticesPage';
import { THIRD_PARTY_NOTICES_LABELS } from '@/lib/copy';

describe('ThirdPartyNoticesPage license text rendering (SCRUM-3559)', () => {
  function renderPage() {
    return render(
      <MemoryRouter>
        <ThirdPartyNoticesPage />
      </MemoryRouter>,
    );
  }

  it('exposes a license-text toggle label in copy.ts (§1.3 — no inline JSX strings)', () => {
    expect(typeof THIRD_PARTY_NOTICES_LABELS.LICENSE_TEXT_TOGGLE).toBe('string');
    expect(THIRD_PARTY_NOTICES_LABELS.LICENSE_TEXT_TOGGLE.length).toBeGreaterThan(0);
  });

  it('renders the copyright line for a general dependency that has one', () => {
    renderPage();
    expect(screen.getByText('Copyright (c) 2018 Example Author')).toBeInTheDocument();
  });

  it('renders the full license text for a general dependency inside a collapsible region', () => {
    renderPage();
    const text = screen.getByText(/Permission is hereby granted, free of charge/);
    expect(text).toBeInTheDocument();
    expect(text.closest('details')).not.toBeNull();
  });

  it('renders copyright and license text for a copyleft entry', () => {
    renderPage();
    expect(screen.getByText('Copyright (c) 2009-2016 Example Zip Authors')).toBeInTheDocument();
    const text = screen.getByText(/You may use it under the MIT license/);
    expect(text).toBeInTheDocument();
    expect(text.closest('details')).not.toBeNull();
  });

  it('renders a license-text toggle only for entries that carry license text', () => {
    renderPage();
    // left-pad (general) + example-zip (copyleft) — NOT no-license-file-dep or example-pending-lib
    expect(screen.getAllByText(THIRD_PARTY_NOTICES_LABELS.LICENSE_TEXT_TOGGLE)).toHaveLength(2);
    expect(screen.getByText('no-license-file-dep@2.0.0')).toBeInTheDocument();
  });

  it('keeps the pending badge for pending entries and never shows it for active ones', () => {
    renderPage();
    const badges = screen.getAllByText(THIRD_PARTY_NOTICES_LABELS.PENDING_BADGE);
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('li')).toHaveTextContent('example-pending-lib');
  });

  it('keeps rendering license-text links for entries without inline text', () => {
    renderPage();
    const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(hrefs).toContain('https://www.gnu.org/licenses/lgpl-3.0.txt');
    expect(hrefs).toContain('https://www.gnu.org/licenses/gpl-3.0.txt');
  });
});
