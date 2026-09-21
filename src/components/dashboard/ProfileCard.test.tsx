import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const createSignedUrl = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({ supabase: { storage: { from: () => ({ createSignedUrl }) } } }));
import { MemoryRouter } from 'react-router-dom';
import { ProfileCard } from './ProfileCard';
import type { Database } from '@/types/database.types';

type Profile = Database['public']['Tables']['profiles']['Row'];

const baseProfile = {
  id: 'user-1',
  email: 'verified@example.test',
  full_name: 'Verified User',
  avatar_url: null,
  avatar_storage_path: null,
  banner_storage_path: null,
  role: 'ORG_ADMIN',
  role_set_at: null,
  org_id: 'org-1',
  requires_manual_review: false,
  manual_review_reason: null,
  manual_review_completed_at: null,
  manual_review_completed_by: null,
  created_at: '2026-05-05T00:00:00.000Z',
  updated_at: '2026-05-05T00:00:00.000Z',
  is_public_profile: false,
  is_verified: true,
  subscription_tier: 'organization',
  public_id: 'profile_public_1',
  deleted_at: null,
  status: 'ACTIVE',
  activation_token: null,
  activation_token_expires_at: null,
  is_platform_admin: false,
  phone_number: null,
  identity_verification_status: 'verified',
  identity_verification_session_id: null,
  identity_verified_at: '2026-05-05T00:00:00.000Z',
  phone_verified_at: null,
  kyc_provider: null,
  disclaimer_accepted_at: '2026-05-05T00:00:00.000Z',
  bio: null,
  social_links: null,
} satisfies Profile;

describe('ProfileCard', () => {
  it('renders the verified badge without throwing outside the sidebar tooltip provider', () => {
    render(
      <MemoryRouter>
        <ProfileCard
          profile={baseProfile}
          organization={{ id: 'org-1', display_name: 'Verified Org' }}
          onTogglePrivacy={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  // SCRUM-4989: the write-path validator only protects rows written after it
  // shipped. `profiles.social_links` was unvalidated jsonb for its whole
  // history, so the render path must default safely for what is already there.
  it.each([
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '//evil.example/x',
    'https://linkedin.com@evil.example/',
  ])('renders no link for a pre-existing %s value', (hostile) => {
    const { container } = render(
      <MemoryRouter>
        <ProfileCard
          profile={{ ...baseProfile, social_links: { linkedin: hostile, twitter: hostile } }}
          organization={{ id: 'org-1', display_name: 'Verified Org' }}
          onTogglePrivacy={vi.fn()}
        />
      </MemoryRouter>,
    );

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).not.toContain(hostile);
    expect(hrefs.some((h) => /^(javascript|data|vbscript):/i.test(h) || h.startsWith('//') || h.includes('@evil.example'))).toBe(false);
    expect(container.querySelector('a[aria-label="LinkedIn profile"]')).toBeNull();
    expect(container.querySelector('a[aria-label="Twitter profile"]')).toBeNull();
  });

  it('still renders safe linkedin and twitter links', () => {
    const { container } = render(
      <MemoryRouter>
        <ProfileCard
          profile={{ ...baseProfile, social_links: { linkedin: 'https://linkedin.com/in/ada', twitter: '@ada_l' } }}
          organization={{ id: 'org-1', display_name: 'Verified Org' }}
          onTogglePrivacy={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector('a[aria-label="LinkedIn profile"]')?.getAttribute('href')).toBe(
      'https://linkedin.com/in/ada',
    );
    expect(container.querySelector('a[aria-label="Twitter profile"]')?.getAttribute('href')).toBe(
      'https://x.com/ada_l',
    );
  });

  // D2 — UAT-14 uploads write `avatar_storage_path`, not `avatar_url`. Every
  // site that renders an avatar must resolve the storage path, or a user's new
  // photo silently does not appear.
  describe('avatar sourced from the private bucket', () => {
    beforeEach(() => { createSignedUrl.mockReset(); });

    it('renders the signed URL for an avatar that only has a storage path', async () => {
      createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/avatar' }, error: null });
      render(
        <MemoryRouter>
          <ProfileCard
            profile={{ ...baseProfile, avatar_url: null, avatar_storage_path: 'users/profile_public_1/avatar/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png' }}
            organization={{ id: 'org-1', display_name: 'Verified Org' }}
            onTogglePrivacy={vi.fn()}
          />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByRole('img', { name: 'Verified User' })).toHaveAttribute('src', 'https://signed.example/avatar'));
    });

    it('degrades to initials when signing is denied', async () => {
      createSignedUrl.mockResolvedValue({ data: null, error: { message: 'denied' } });
      render(
        <MemoryRouter>
          <ProfileCard
            profile={{ ...baseProfile, avatar_url: null, avatar_storage_path: 'users/profile_public_1/avatar/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png' }}
            organization={{ id: 'org-1', display_name: 'Verified Org' }}
            onTogglePrivacy={vi.fn()}
          />
        </MemoryRouter>,
      );
      await waitFor(() => expect(createSignedUrl).toHaveBeenCalled());
      expect(screen.queryByRole('img', { name: 'Verified User' })).not.toBeInTheDocument();
      expect(screen.getByText('VU')).toBeInTheDocument();
    });
  });
});
