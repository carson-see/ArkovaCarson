/**
 * SCRUM-4989 — the public profile is the cross-user render surface for
 * `profiles.social_links`. The write-path validator only guards rows written
 * after it shipped, so the render path must default safely for rows that are
 * already in the table.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PublicProfilePage } from './PublicProfilePage';
import type { PublicMemberProfile } from '@/hooks/usePublicSearch';

const fetchProfile = vi.fn();
let mockProfile: PublicMemberProfile | null = null;

vi.mock('@/hooks/usePublicSearch', () => ({
  usePublicMemberProfile: () => ({
    profile: mockProfile,
    loading: false,
    error: null,
    fetchProfile,
  }),
}));

function renderPage(social_links: Record<string, string> | null) {
  mockProfile = {
    public_id: 'profile_public_1',
    display_name: 'Ada Lovelace',
    avatar_url: null,
    bio: null,
    social_links,
    created_at: '2026-05-05T00:00:00.000Z',
    organizations: [],
  };
  return render(
    <MemoryRouter initialEntries={['/profile/profile_public_1']}>
      <Routes>
        <Route path="/profile/:profileId" element={<PublicProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PublicProfilePage social links', () => {
  beforeEach(() => {
    fetchProfile.mockClear();
  });

  it.each([
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/x',
    'https://linkedin.com@evil.example/',
  ])('renders no link for a pre-existing %s value', (hostile) => {
    const { container } = renderPage({ linkedin: hostile, website: hostile });

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).not.toContain(hostile);
    expect(
      hrefs.some((h) => /^(javascript|data|vbscript):/i.test(h) || h.startsWith('//') || h.includes('@evil.example')),
    ).toBe(false);
  });

  it('still renders safe links, including a bare domain and an @handle', () => {
    const { container } = renderPage({
      linkedin: 'https://linkedin.com/in/ada',
      website: 'ada.example/page',
      twitter: '@ada_l',
    });

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://linkedin.com/in/ada');
    expect(hrefs).toContain('https://ada.example/page');
    expect(hrefs).toContain('https://x.com/ada_l');
    expect(screen.getByLabelText('Profile QR code').querySelector('svg')).toBeTruthy();
  });
});
