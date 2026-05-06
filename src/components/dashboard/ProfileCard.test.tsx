import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProfileCard } from './ProfileCard';
import type { Database } from '@/types/database.types';

type Profile = Database['public']['Tables']['profiles']['Row'];

const baseProfile = {
  id: 'user-1',
  email: 'verified@example.test',
  full_name: 'Verified User',
  avatar_url: null,
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
});
