/**
 * ActivateAccountPage tests.
 *
 * The page previously called a `activate_user(p_token, p_claim_key)` overload
 * that does not exist in production (PGRST202), and never collected a password
 * at all — so a recipient could never claim a credential or sign in. These
 * tests pin the corrected contract: preview the link, collect a password,
 * POST it to the worker, and surface expired / already-used links honestly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ActivateAccountPage } from './ActivateAccountPage';

const mockLoadPreview = vi.hoisted(() => vi.fn());
const mockActivateAccount = vi.hoisted(() => vi.fn());
const mockUseActivateAccount = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useActivateAccount', () => ({ useActivateAccount: mockUseActivateAccount }));

const TOKEN = 'a'.repeat(64);

const PREVIEW = {
  email: 'recipient@example.com',
  fullName: 'Rec Ipient',
  orgName: 'Example University',
  expired: false,
};

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    preview: null,
    previewLoading: false,
    previewError: null,
    loadPreview: mockLoadPreview,
    activating: false,
    activateError: null,
    activateAccount: mockActivateAccount,
    ...overrides,
  };
}

function renderPage(token: string | null = TOKEN) {
  const path = token === null ? '/activate' : `/activate?token=${token}`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/activate" element={<ActivateAccountPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ActivateAccountPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadPreview.mockResolvedValue(PREVIEW);
    mockUseActivateAccount.mockReturnValue(baseState({ preview: PREVIEW }));
  });

  it('shows an invalid-link state when the URL carries no token', async () => {
    mockUseActivateAccount.mockReturnValue(baseState());
    renderPage(null);

    expect(
      await screen.findByRole('heading', { name: /activation link is invalid/i }),
    ).toBeInTheDocument();
    expect(mockLoadPreview).not.toHaveBeenCalled();
  });

  it('previews the link and asks the recipient to choose a password', async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText('Example University')).toBeInTheDocument());
    // Defect B: activation is meaningless without collecting a password.
    expect(screen.getByLabelText(/choose a password/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('recipient@example.com')).toBeDisabled();
  });

  it('sends the token and the chosen password to the worker, and never a claim key', async () => {
    const user = userEvent.setup();
    mockActivateAccount.mockResolvedValue({ success: true, email: PREVIEW.email, orgName: PREVIEW.orgName });

    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/choose a password/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/choose a password/i), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /activate/i }));

    await waitFor(() => expect(mockActivateAccount).toHaveBeenCalled());
    const sent = mockActivateAccount.mock.calls[0][0];
    expect(sent).toMatchObject({ token: TOKEN, password: 'correct horse battery' });
    // Defect A: `p_claim_key` was the argument that could never bind.
    expect(JSON.stringify(sent)).not.toContain('claim');
  });

  it('rejects a password shorter than 8 characters before calling the worker', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/choose a password/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/choose a password/i), 'short');
    await user.click(screen.getByRole('button', { name: /activate/i }));

    expect(mockActivateAccount).not.toHaveBeenCalled();
    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
  });

  it('tells the recipient to request a new link when the token has expired', async () => {
    mockLoadPreview.mockRejectedValue(Object.assign(new Error('expired'), { code: 'expired' }));
    mockUseActivateAccount.mockReturnValue(
      baseState({ previewError: Object.assign(new Error('expired'), { code: 'expired' }) }),
    );

    renderPage();

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });

  it('shows a success state that directs the recipient to sign in', async () => {
    const user = userEvent.setup();
    mockActivateAccount.mockResolvedValue({ success: true, email: PREVIEW.email, orgName: PREVIEW.orgName });

    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/choose a password/i)).toBeInTheDocument());

    await user.type(screen.getByLabelText(/choose a password/i), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: /activate/i }));

    expect(await screen.findByText(/your account is ready/i)).toBeInTheDocument();
  });
});
