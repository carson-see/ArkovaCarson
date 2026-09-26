/**
 * D3 (PR #3033 independent review, pass 1) — AAL1 experience for profile media.
 *
 * `can_write_profile_media` requires `private.is_human_mfa_verified()`, so an
 * AAL1 session cannot write to the private bucket. Before this, the inputs were
 * enabled and the resulting PostgREST/RLS rejection was rendered verbatim in a
 * toast — not actionable, and a §1.3 violation (all user-visible text lives in
 * copy.ts). The inputs are now disabled up front with a copy.ts explanation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PROFILE_MEDIA_LABELS } from '@/lib/copy';

const sessionState = { accessToken: null as string | null };

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'ada@example.test' },
    session: sessionState.accessToken ? { access_token: sessionState.accessToken } : null,
    signOut: vi.fn(),
  }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: {
      id: 'user-1',
      email: 'ada@example.test',
      full_name: 'Ada Lovelace',
      role: 'ORG_ADMIN',
      public_id: 'profile_public_1',
      is_public_profile: false,
      bio: null,
      social_links: null,
      avatar_url: null,
      avatar_storage_path: null,
      banner_storage_path: null,
    },
    loading: false,
    updating: false,
    updateProfile: vi.fn(),
    refreshProfile: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'denied' } }) }) } },
}));

vi.mock('@/components/layout', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/auth/DeleteAccountDialog', () => ({ DeleteAccountDialog: () => null }));
vi.mock('@/components/auth/ExportDataButton', () => ({ ExportDataButton: () => null }));
vi.mock('@/components/auth/DataCorrectionForm', () => ({ DataCorrectionForm: () => null }));
vi.mock('@/components/auth/TwoFactorSetup', () => ({ TwoFactorSetup: () => null }));
vi.mock('@/components/auth/IdentityVerification', () => ({ IdentityVerification: () => null }));

const { SettingsPage } = await import('./SettingsPage');

/** Unsigned JWT shaped the way `sessionHasAal2` reads it (browser hint only). */
function token(aal: 'aal1' | 'aal2') {
  const payload = btoa(JSON.stringify({ sub: 'user-1', aal, role: 'authenticated', session_id: 's1' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `h.${payload}.sig`;
}

function renderPage(aal: 'aal1' | 'aal2') {
  sessionState.accessToken = token(aal);
  return render(<MemoryRouter><SettingsPage /></MemoryRouter>);
}

describe('SettingsPage profile media — AAL gate', () => {
  beforeEach(() => { sessionState.accessToken = null; });

  it('disables both media inputs and explains why on an AAL1 session', () => {
    renderPage('aal1');
    expect(screen.getByLabelText(PROFILE_MEDIA_LABELS.PROFILE_PHOTO)).toBeDisabled();
    expect(screen.getByLabelText(PROFILE_MEDIA_LABELS.PROFILE_BANNER)).toBeDisabled();
    expect(screen.getByText(PROFILE_MEDIA_LABELS.MFA_REQUIRED)).toBeInTheDocument();
  });

  it('enables them on an AAL2 session and shows no MFA notice', () => {
    renderPage('aal2');
    expect(screen.getByLabelText(PROFILE_MEDIA_LABELS.PROFILE_PHOTO)).not.toBeDisabled();
    expect(screen.getByLabelText(PROFILE_MEDIA_LABELS.PROFILE_BANNER)).not.toBeDisabled();
    expect(screen.queryByText(PROFILE_MEDIA_LABELS.MFA_REQUIRED)).not.toBeInTheDocument();
  });
});
