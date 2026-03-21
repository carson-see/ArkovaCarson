/**
 * SignUpForm Beta Gate Tests
 *
 * Verifies signup form behavior with and without the beta invite code gate.
 * The gate is controlled by VITE_BETA_INVITE_CODE env var.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockSignUp = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signUp: mockSignUp,
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
