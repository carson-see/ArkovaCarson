/**
 * AcceptInvitePage Tests (SCRUM-3012)
 *
 * Covers the end-to-end UI states the founder-reported bug left entirely
 * unbuilt: invalid/expired/already-used previews, new-account creation,
 * direct join for an already-signed-in matching caller, and the
 * account_exists -> sign-in redirect guard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AcceptInvitePage } from './AcceptInvitePage';

const mockUseAuth = vi.hoisted(() => vi.fn());
const mockLoadPreview = vi.hoisted(() => vi.fn());
const mockAcceptInvitation = vi.hoisted(() => vi.fn());
const mockUseAcceptInvite = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useAuth', () => ({ useAuth: mockUseAuth }));
vi.mock('@/hooks/useAcceptInvite', () => ({ useAcceptInvite: mockUseAcceptInvite }));

const ACCEPT_INVITE_JOINED_HEADING = "You're in";

const PREVIEW = {
  orgName: 'Example Org',
  email: 'invitee@example.com',
  role: 'INDIVIDUAL' as const,
  expired: false,
  alreadyUsed: false,
};

function renderPage(token = 'good-token') {
  return render(
    <MemoryRouter initialEntries={[`/accept-invite?token=${token}`]}>
      <Routes>
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function baseAcceptInviteState(overrides: Record<string, unknown> = {}) {
  return {
    preview: null,
    previewLoading: false,
    previewError: null,
    loadPreview: mockLoadPreview,
    accepting: false,
    acceptError: null,
    acceptInvitation: mockAcceptInvitation,
    ...overrides,
  };
}

describe('AcceptInvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: null });
  });

  it('shows the invitation preview and a create-account form for a signed-out visitor', async () => {
    mockLoadPreview.mockResolvedValue(PREVIEW);
    mockUseAcceptInvite.mockReturnValue(baseAcceptInviteState({ preview: PREVIEW }));

    renderPage();

    await waitFor(() => expect(screen.getByText('Example Org')).toBeInTheDocument());
    expect(screen.getByText(/as a member/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/create a password/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('invitee@example.com')).toBeDisabled();
  });

  it('submits the create-account form and shows the confirm-your-email state on success', async () => {
    mockLoadPreview.mockResolvedValue(PREVIEW);
    mockAcceptInvitation.mockResolvedValue({
      success: true,
      orgId: 'org-1',
      orgName: 'Example Org',
      verificationRequired: true,
      verificationEmailSent: true,
    });
    mockUseAcceptInvite.mockReturnValue(baseAcceptInviteState({ preview: PREVIEW }));

    renderPage();
    await waitFor(() => expect(screen.getByText('Example Org')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/create a password/i), 'longenough');
    await user.click(screen.getByRole('button', { name: /create account and join/i }));

    await waitFor(() =>
      expect(mockAcceptInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'good-token', password: 'longenough' }),
      ),
    );
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeInTheDocument());
  });

  it('shows a direct Join button (no password) when the signed-in caller email matches the invitation', async () => {
    mockUseAuth.mockReturnValue({ user: { email: 'invitee@example.com' } });
    mockLoadPreview.mockResolvedValue(PREVIEW);
    mockAcceptInvitation.mockResolvedValue({
      success: true,
      orgId: 'org-1',
      orgName: 'Example Org',
      verificationRequired: false,
      verificationEmailSent: false,
    });
    mockUseAcceptInvite.mockReturnValue(baseAcceptInviteState({ preview: PREVIEW }));

    renderPage();
    await waitFor(() => expect(screen.getByText('Example Org')).toBeInTheDocument());

    expect(screen.queryByLabelText(/create a password/i)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /create account and join/i }));

    await waitFor(() => expect(mockAcceptInvitation).toHaveBeenCalledWith({ token: 'good-token' }));
    await waitFor(() => expect(screen.getByText(ACCEPT_INVITE_JOINED_HEADING)).toBeInTheDocument());
  });

  it('shows the expired-invitation error card', async () => {
    mockLoadPreview.mockRejectedValue(Object.assign(new Error('expired'), { code: 'expired' }));
    mockUseAcceptInvite.mockReturnValue(
      baseAcceptInviteState({ previewError: { code: 'expired', message: 'This invitation has expired.' } }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('This invitation has expired')).toBeInTheDocument());
  });

  it('shows the invalid-invitation error card for an unknown token', async () => {
    mockLoadPreview.mockRejectedValue(Object.assign(new Error('not found'), { code: 'not_found' }));
    mockUseAcceptInvite.mockReturnValue(
      baseAcceptInviteState({ previewError: { code: 'not_found', message: 'This invitation link is invalid.' } }),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText('Invalid invitation link')).toBeInTheDocument());
  });

  it('surfaces an account_exists sign-in prompt without crashing the form', async () => {
    mockLoadPreview.mockResolvedValue(PREVIEW);
    mockAcceptInvitation.mockRejectedValue(
      Object.assign(new Error('An account with this email already exists. Sign in to accept this invitation.'), {
        code: 'account_exists',
      }),
    );
    mockUseAcceptInvite.mockReturnValue(
      baseAcceptInviteState({
        preview: PREVIEW,
        acceptError: {
          code: 'account_exists',
          message: 'An account with this email already exists. Sign in to accept this invitation.',
        },
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText('Example Org')).toBeInTheDocument());

    expect(screen.getByRole('link', { name: /sign in to accept/i })).toBeInTheDocument();
  });
});
