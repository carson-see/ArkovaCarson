/**
 * SCRUM-4989 — settings-page write path for `profiles.social_links`.
 *
 * Two behaviours this file pins, neither of which the validator alone gives:
 *  1. A rejection renders inside the Social Profiles card, next to the Save
 *     button that produced it. The page-level `error` Alert lives in the
 *     profile card far above, where the rejection is off screen and Save just
 *     looks inert.
 *  2. A legacy key the form has no input for does not lock the user out of
 *     saving (the write schema strips unknown keys and the form is seeded
 *     through `pickSocialLinks`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PROFILE_LABELS } from '@/lib/copy';

const updateProfile = vi.fn();
let mockProfile: Record<string, unknown> | null = null;

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'ada@example.test' }, signOut: vi.fn() }),
}));

vi.mock('@/hooks/useProfile', () => ({
  useProfile: () => ({
    profile: mockProfile,
    loading: false,
    updating: false,
    updateProfile,
    refreshProfile: vi.fn(),
  }),
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

function renderPage(social_links: unknown) {
  mockProfile = {
    id: 'user-1',
    email: 'ada@example.test',
    full_name: 'Ada Lovelace',
    role: 'ORG_ADMIN',
    public_id: 'profile_public_1',
    is_public_profile: false,
    bio: null,
    social_links,
  };
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

const LABELS = PROFILE_LABELS.socialLinks;

/** The <Card> that holds the Social Profiles form. */
function socialCard(): HTMLElement {
  const input = screen.getByPlaceholderText(LABELS.linkedin.placeholder);
  const card = input.closest('div.rounded-lg');
  if (!card) throw new Error('social links card not found');
  return card as HTMLElement;
}

function linkedinInput() {
  return screen.getByPlaceholderText(LABELS.linkedin.placeholder);
}

function clickSocialSave() {
  fireEvent.click(within(socialCard()).getByRole('button', { name: 'Save' }));
}

describe('SettingsPage social links', () => {
  beforeEach(() => {
    updateProfile.mockReset();
    updateProfile.mockResolvedValue(true);
  });

  it('shows the rejection inside the social card and does not write', async () => {
    renderPage({ linkedin: 'https://linkedin.com/in/ada' });

    fireEvent.change(linkedinInput(), { target: { value: 'javascript:alert(1)' } });
    clickSocialSave();

    const alert = await screen.findByText(LABELS.invalid.linkedin);
    expect(socialCard().contains(alert)).toBe(true);
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('clears the rejection once the field is edited again', async () => {
    renderPage(null);

    fireEvent.change(linkedinInput(), { target: { value: 'javascript:alert(1)' } });
    clickSocialSave();
    await screen.findByText(LABELS.invalid.linkedin);

    fireEvent.change(linkedinInput(), { target: { value: 'https://linkedin.com/in/ada' } });
    expect(screen.queryByText(LABELS.invalid.linkedin)).toBeNull();
  });

  it('an unknown stored key does not block the save (it is dropped)', async () => {
    renderPage({ linkedin: 'https://linkedin.com/in/ada', mastodon: 'https://m.example/@ada' });

    clickSocialSave();

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      social_links: { linkedin: 'https://linkedin.com/in/ada' },
    });
    expect(screen.queryByText(/must be a link starting with/)).toBeNull();
  });
});
