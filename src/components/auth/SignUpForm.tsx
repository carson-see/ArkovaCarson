/**
 * Sign Up Form Component
 *
 * Handles new user registration.
 * Shows "Check your email" success state after signup.
 * Note: Role is assigned during onboarding, not signup.
 *
 * Beta gate: When VITE_BETA_INVITE_CODE is set, users must enter
 * a valid invite code before the signup form is shown.
 */

import { useState, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { User, Mail, Lock, AlertCircle, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { EmailConfirmation } from '@/components/onboarding/EmailConfirmation';
import { AUTH_FORM_LABELS, BETA_GATE_LABELS } from '@/lib/copy';

const BETA_INVITE_CODE = import.meta.env.VITE_BETA_INVITE_CODE as string | undefined;

interface SignUpFormProps {
  onSuccess?: () => void;
  onLoginClick?: () => void;
}

export function SignUpForm({ onSuccess, onLoginClick }: Readonly<SignUpFormProps>) {
  const { signUp, signInWithGoogle, signInWithLinkedIn, loading, error, clearError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviteVerified, setInviteVerified] = useState(!BETA_INVITE_CODE);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [signupComplete, setSignupComplete] = useState(false);
  const [resending, setResending] = useState(false);

  const handleInviteSubmit = (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    if (inviteCode.trim() === BETA_INVITE_CODE) {
      setInviteVerified(true);
    } else {
      setValidationError(BETA_GATE_LABELS.INVALID_CODE);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();
    setValidationError(null);

    if (password !== confirmPassword) {
      setValidationError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setValidationError('Password must be at least 8 characters');
      return;
    }

    const result = await signUp(email, password, fullName || undefined);

    // BUG-003 fix: Check return value directly instead of stale error closure
    if (!result.error) {
      setSignupComplete(true);
      onSuccess?.();
    }
  };

  const handleResend = async () => {
    setResending(true);
    // Resend signup email
    await signUp(email, password, fullName || undefined);
    setResending(false);
  };

  const handleBack = () => {
    setSignupComplete(false);
  };

  // Show email confirmation after successful signup
  if (signupComplete) {
    return (
      <EmailConfirmation
        email={email}
        onResend={handleResend}
        onBack={handleBack}
        resending={resending}
      />
    );
  }

  const displayError = validationError || error;

  // Beta invite code gate
  if (!inviteVerified) {
    return (
      <form onSubmit={handleInviteSubmit} className="space-y-5">
        <div className="text-center space-y-2">
          <ArkovaIcon className="h-8 w-8 mx-auto text-primary" />
          <p className="text-sm text-muted-foreground">
            {BETA_GATE_LABELS.DESCRIPTION}
          </p>
        </div>

        {validationError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="inviteCode">{BETA_GATE_LABELS.CODE_LABEL}</Label>
          <Input
            id="inviteCode"
            type="text"
            value={inviteCode}
            onChange={(e) => { setInviteCode(e.target.value); setValidationError(null); }}
            placeholder={BETA_GATE_LABELS.CODE_PLACEHOLDER}
            required
            autoFocus
          />
        </div>

        <Button type="submit" className="w-full" size="lg">
          {BETA_GATE_LABELS.CONTINUE}
        </Button>

        {onLoginClick && (
          <p className="text-center text-sm text-muted-foreground">
            {AUTH_FORM_LABELS.ALREADY_HAVE_ACCOUNT}{' '}
            <button
              type="button"
              onClick={onLoginClick}
              className="font-medium text-primary hover:text-primary/80 transition-colors"
            >
              {AUTH_FORM_LABELS.SIGN_IN}
            </button>
          </p>
        )}
      </form>
    );
  }

  const handleGoogleSignUp = async () => {
    clearError();
    await signInWithGoogle();
  };

  const handleLinkedInSignUp = async () => {
    clearError();
    await signInWithLinkedIn();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {displayError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{displayError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={handleGoogleSignUp}
          disabled={loading}
        >
          <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="currentColor"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="currentColor"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="currentColor"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Google
        </Button>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={handleLinkedInSignUp}
          disabled={loading}
        >
          <span
            className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded-[2px] bg-[#0a66c2] text-[10px] font-bold leading-none text-white"
            aria-hidden="true"
          >
            in
          </span>
          LinkedIn
        </Button>
      </div>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <Separator className="w-full" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Or continue with any email</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Gmail, Yahoo, Proton, work domains, and personal email accounts are all supported.
      </p>

      <div className="space-y-2">
        <Label htmlFor="fullName">Full name</Label>
        <div className="relative">
          <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="fullName"
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Enter your full name"
            disabled={loading}
            className="pl-10"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="signupEmail">Email address</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="signupEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            disabled={loading}
            className="pl-10"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="signupPassword">Password</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="signupPassword"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Create a password (8+ characters)"
            required
            minLength={8}
            disabled={loading}
            className="pl-10"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm your password"
            required
            disabled={loading}
            className="pl-10"
          />
        </div>
      </div>

      <Button type="submit" className="w-full" size="lg" disabled={loading}>
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {AUTH_FORM_LABELS.CREATING_ACCOUNT}
          </>
        ) : (
          AUTH_FORM_LABELS.CREATE_ACCOUNT
        )}
      </Button>

      {onLoginClick && (
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onLoginClick}
            className="font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Sign in
          </button>
        </p>
      )}
    </form>
  );
}
