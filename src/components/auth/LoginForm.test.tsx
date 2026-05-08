/**
 * LoginForm Component Tests (SCRUM-1790)
 *
 * Verifies login form rendering, email/password submission,
 * OAuth buttons (Google, LinkedIn), forgot password flow,
 * and error display.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoginForm } from './LoginForm';

const {
  mockSignIn,
  mockSignInWithGoogle,
  mockSignInWithLinkedIn,
  mockClearError,
  mockResetPasswordForEmail,
} = vi.hoisted(() => ({
  mockSignIn: vi.fn().mockResolvedValue({ error: null }),
  mockSignInWithGoogle: vi.fn(),
  mockSignInWithLinkedIn: vi.fn(),
  mockClearError: vi.fn(),
  mockResetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    signIn: mockSignIn,
    signInWithGoogle: mockSignInWithGoogle,
    signInWithLinkedIn: mockSignInWithLinkedIn,
    loading: false,
    error: null,
    clearError: mockClearError,
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: mockResetPasswordForEmail,
    },
  },
}));

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders email and password inputs', () => {
    render(<LoginForm />);
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('renders sign in button', () => {
    render(<LoginForm />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders Google OAuth button', () => {
    render(<LoginForm />);
    expect(screen.getByRole('button', { name: /google/i })).toBeInTheDocument();
  });

  it('renders LinkedIn OAuth button', () => {
    render(<LoginForm />);
    expect(screen.getByRole('button', { name: /linkedin/i })).toBeInTheDocument();
  });

  it('renders forgot password link', () => {
    render(<LoginForm />);
    expect(screen.getByText(/forgot password/i)).toBeInTheDocument();
  });

  it('renders create account link when onSignUpClick provided', () => {
    render(<LoginForm onSignUpClick={vi.fn()} />);
    expect(screen.getByText(/create an account/i)).toBeInTheDocument();
  });

  it('does not render create account link when onSignUpClick not provided', () => {
    render(<LoginForm />);
    expect(screen.queryByText(/create an account/i)).toBeNull();
  });

  it('calls signIn on form submit', async () => {
    render(<LoginForm />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith('test@example.com', 'password123');
    });
  });

  it('calls onSuccess after successful login', async () => {
    const onSuccess = vi.fn();
    render(<LoginForm onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'test@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await vi.waitFor(() => {
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it('shows forgot password form when link clicked', () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByText(/forgot password/i));
    expect(screen.getByText(/reset your password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  it('calls resetPasswordForEmail on forgot password submit', async () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByText(/forgot password/i));

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'forgot@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await vi.waitFor(() => {
      expect(mockResetPasswordForEmail).toHaveBeenCalledWith('forgot@example.com', {
        redirectTo: expect.stringContaining('/login'),
      });
    });
  });

  it('shows success message after password reset email sent', async () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByText(/forgot password/i));

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'forgot@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    await vi.waitFor(() => {
      expect(screen.getByText(/check your email/i)).toBeInTheDocument();
    });
  });

  it('returns to sign in from forgot password view', () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByText(/forgot password/i));
    expect(screen.getByText(/reset your password/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/back to sign in/i));
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('calls signInWithGoogle when Google button clicked', () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: /google/i }));
    expect(mockSignInWithGoogle).toHaveBeenCalled();
  });

  it('calls signInWithLinkedIn when LinkedIn button clicked', () => {
    render(<LoginForm />);
    fireEvent.click(screen.getByRole('button', { name: /linkedin/i }));
    expect(mockSignInWithLinkedIn).toHaveBeenCalled();
  });
});
