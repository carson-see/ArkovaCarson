/**
 * SignUpForm Registration Tests
 *
 * Registration stays open even when an old deployment still defines a beta code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const authState = { loading: false, error: null as string | null };
const mockSignUp = vi.fn();
const mockSignInWithGoogle = vi.fn();
const mockSignInWithLinkedIn = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signUp: mockSignUp,
    signInWithGoogle: mockSignInWithGoogle,
    signInWithLinkedIn: mockSignInWithLinkedIn,
    loading: authState.loading,
    error: authState.error,
    clearError: vi.fn(),
  }),
}));

vi.mock('@/components/onboarding/EmailConfirmation', () => ({
  EmailConfirmation: () => <div data-testid="email-confirmation">Check your email</div>,
}));

describe('SignUpForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.loading = false;
    authState.error = null;
    mockSignUp.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe.each([
    ['no legacy beta code', ''],
    ['a legacy beta code', 'RETIRED-BETA-CODE'],
  ])('with %s', (_label, legacyCode) => {
    beforeEach(() => {
      vi.stubEnv('VITE_BETA_INVITE_CODE', legacyCode);
    });

    async function loadSignUpForm() {
      vi.resetModules();
      const { SignUpForm } = await import('./SignUpForm');
      return SignUpForm;
    }

    it('shows signup form directly', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      expect(screen.queryByLabelText(/invite code/i)).not.toBeInTheDocument();
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

    it('rejects a short password before contacting auth', async () => {
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'short' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'short' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it('keeps a failed signup on the form without reporting success', async () => {
      mockSignUp.mockResolvedValue({ error: new Error('Signup is temporarily unavailable'), session: null });
      const SignUpForm = await loadSignUpForm();
      const onSuccess = vi.fn();
      const { rerender } = render(<SignUpForm onSuccess={onSuccess} />);
      fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'test@example.com' } });
      fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => expect(mockSignUp).toHaveBeenCalledOnce());
      // useAuth owns backend error state and publishes it to subscribers.
      authState.error = 'Signup is temporarily unavailable';
      rerender(<SignUpForm onSuccess={onSuccess} />);
      expect(screen.getByRole('alert').textContent).toContain('Signup is temporarily unavailable');
      expect(screen.queryByTestId('email-confirmation')).not.toBeInTheDocument();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/email address/i)).toHaveValue('test@example.com');
    });

    it('shows errors supplied by the OAuth provider', async () => {
      authState.error = 'Unable to connect to the sign-in provider';
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      expect(screen.getByRole('alert').textContent).toContain('Unable to connect to the sign-in provider');
      expect(screen.queryByTestId('email-confirmation')).not.toBeInTheDocument();
    });

    it('prevents duplicate signup and provider submissions while auth is loading', async () => {
      authState.loading = true;
      const SignUpForm = await loadSignUpForm();
      render(<SignUpForm />);
      expect(screen.getByRole('button', { name: /creating account/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /google/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /linkedin/i })).toBeDisabled();
      expect(screen.getByLabelText(/email address/i)).toBeDisabled();
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

    // SCRUM-2907: When signUp returns an ACTIVE session (confirmation disabled
    // in a test environment), the user is already logged in → skip the misleading
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
});
