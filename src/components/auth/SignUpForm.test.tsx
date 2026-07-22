/**
 * SignUpForm Beta Gate Tests
 *
 * Verifies signup form behavior with and without the beta invite code gate.
 * The gate is controlled by VITE_BETA_INVITE_CODE env var.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockSignUp = vi.fn();
const mockSignInWithGoogle = vi.fn();
const mockSignInWithLinkedIn = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signUp: mockSignUp,
    signInWithGoogle: mockSignInWithGoogle,
    signInWithLinkedIn: mockSignInWithLinkedIn,
    loading: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

vi.mock('@/components/onboarding/EmailConfirmation', () => ({
  EmailConfirmation: () => <div data-testid="email-confirmation">Check your email</div>,
}));

describe('SignUpForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignUp.mockResolvedValue({ error: null });
  });

  describe('without beta gate (no VITE_BETA_INVITE_CODE)', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_BETA_INVITE_CODE', '');
    });

    async function loadSignUpForm() {
      vi.resetModules();
      const { SignUpForm } = await import('./SignUpForm');
      return SignUpForm;
    }

    it('shows signup form directly', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /google/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /linkedin/i })).toBeInTheDocument();
    });

    it('starts social signup with Google or LinkedIn', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);

      fireEvent.click(screen.getByRole('button', { name: /google/i }));
      fireEvent.click(screen.getByRole('button', { name: /linkedin/i }));

      expect(mockSignInWithGoogle).toHaveBeenCalledOnce();
      expect(mockSignInWithLinkedIn).toHaveBeenCalledOnce();
    });

    it('submits signup form', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Test User' } });
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(mockSignUp).toHaveBeenCalledWith('test@example.com', 'password123', 'Test User');
      });
    });

    it('shows password mismatch error', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'different' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
      });
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it('shows email confirmation after successful signup', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByTestId('email-confirmation')).toBeInTheDocument();
      });
    });

    // SCRUM-2907: The confirmation screen is session-aware. When signUp returns
    // NO active session, email confirmation is genuinely pending → show the
    // "Check your email" screen and do NOT proceed into the app.
    it('shows email confirmation and does not proceed when signUp returns no session', async () => {
      mockSignUp.mockResolvedValue({ error: null, session: null });
      const SignUpForm = await loadSignUpForm();
      const onSuccess = vi.fn();
      render(<SignUpForm onSuccess={onSuccess} />);
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByTestId('email-confirmation')).toBeInTheDocument();
      });
      expect(onSuccess).not.toHaveBeenCalled();
    });

    // SCRUM-2907: When signUp returns an ACTIVE session (auto-confirm on, as in
    // prod today), the user is already logged in → skip the misleading
    // "Check your email" screen and proceed into the app like a normal login.
    it('proceeds into the app without email confirmation when signUp returns an active session', async () => {
      mockSignUp.mockResolvedValue({ error: null, session: { user: { id: 'user-1' } } });
      const SignUpForm = await loadSignUpForm();
      const onSuccess = vi.fn();
      render(<SignUpForm onSuccess={onSuccess} />);
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledOnce();
      });
      expect(screen.queryByTestId('email-confirmation')).not.toBeInTheDocument();
    });

    it('shows sign in link when onLoginClick provided', async () => {
      const SignUpForm = await loadSignUpForm();
      const onLoginClick = vi.fn();
      render(<SignUpForm onLoginClick={onLoginClick} />);
      const signInButton = screen.getByText(/sign in/i);
      fireEvent.click(signInButton);
      expect(onLoginClick).toHaveBeenCalled();
    });
  });

  describe('with beta gate (VITE_BETA_INVITE_CODE set)', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_BETA_INVITE_CODE', 'BETA-TEST-CODE');
    });

    async function loadSignUpForm() {
      vi.resetModules();
      const { SignUpForm } = await import('./SignUpForm');
      return SignUpForm;
    }

    it('shows invite code form instead of signup form', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      expect(screen.getByLabelText(/invite code/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/full name/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    });

    it('shows error for invalid invite code', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      fireEvent.change(screen.getByLabelText(/invite code/i), { target: { value: 'WRONG-CODE' } });
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/invalid invite code/i)).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/full name/i)).not.toBeInTheDocument();
    });

    it('shows signup form after valid invite code', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      fireEvent.change(screen.getByLabelText(/invite code/i), { target: { value: 'BETA-TEST-CODE' } });
      fireEvent.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/invite code/i)).not.toBeInTheDocument();
    });

    it('shows sign in link on invite code form', async () => {
      const SignUpForm = await loadSignUpForm();
      const onLoginClick = vi.fn();
      render(<SignUpForm onLoginClick={onLoginClick} />);
      const signInButton = screen.getByText(/sign in/i);
      fireEvent.click(signInButton);
      expect(onLoginClick).toHaveBeenCalled();
    });
  });
});
