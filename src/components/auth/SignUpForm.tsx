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
import { User, Mail, Lock, AlertCircle, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmailConfirmation } from '@/components/onboarding/EmailConfirmation';
import { AUTH_FORM_LABELS, BETA_GATE_LABELS } from '@/lib/copy';

const BETA_INVITE_CODE = import.meta.env.VITE_BETA_INVITE_CODE as string | undefined;

interface SignUpFormProps {
  onSuccess?: () => void;
  onLoginClick?: () => void;
}

export function SignUpForm({ onSuccess, onLoginClick }: Readonly<SignUpFormProps>) {
  const { signUp, loading, error, clearError } = useAuth();
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
          <ShieldCheck className="h-8 w-8 mx-auto text-primary" />
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

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {displayError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{displayError}</AlertDescription>
        </Alert>
      )}

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
