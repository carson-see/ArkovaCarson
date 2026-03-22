/**
 * Login Form Component
 *
 * Handles user authentication with email and password.
 * Uses approved terminology per Constitution.
 */

import { useState, FormEvent } from 'react';
import { Mail, Lock, AlertCircle, Loader2, CheckCircle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';

interface LoginFormProps {
  onSuccess?: () => void;
  onSignUpClick?: () => void;
}

export function LoginForm({ onSuccess, onSignUpClick }: Readonly<LoginFormProps>) {
  const { signIn, signInWithGoogle, loading, error, clearError } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetSending, setResetSending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    clearError();

    const { error: signInError } = await signIn(email, password);

    if (!signInError && onSuccess) {
      onSuccess();
    }
  };

  const handleGoogleSignIn = async () => {
    clearError();
    await signInWithGoogle();
  };

  const handleForgotPassword = async (e: FormEvent) => {
    e.preventDefault();
    setResetError(null);
    setResetSending(true);

    const { error: resetErr } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}/login`,
    });

    setResetSending(false);

    if (resetErr) {
      // BUG-004 fix: Translate rate limit errors to a user-friendly message
      const msg = resetErr.message?.toLowerCase() ?? '';
      if (msg.includes('rate limit') || msg.includes('too many requests')) {
        setResetError('Too many reset requests. Please wait a few minutes before trying again.');
      } else if (msg.includes('failed to fetch') || msg.includes('networkerror')) {
        setResetError('Unable to reach the server. Please check your connection and try again.');
      } else {
        setResetError(resetErr.message);
      }
    } else {
      setResetSent(true);
    }
  };

  if (forgotMode) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-lg font-semibold">Reset your password</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Enter your email address and we&apos;ll send you a reset link.
          </p>
        </div>

        {resetSent ? (
          <Alert className="border-emerald-500/20 bg-emerald-500/10">
            <CheckCircle className="h-4 w-4 text-emerald-400" />
            <AlertDescription className="text-emerald-300">
              Check your email for a password reset link. It may take a few minutes to arrive.
            </AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={handleForgotPassword} className="space-y-4">
            {resetError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{resetError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email address</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="reset-email"
                  type="email"
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  disabled={resetSending}
                  className="pl-10"
                />
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={resetSending}>
              {resetSending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                'Send reset link'
              )}
            </Button>
          </form>
        )}

        <p className="text-center text-sm text-muted-foreground">
          <button
            type="button"
            onClick={() => {
              setForgotMode(false);
              setResetSent(false);
              setResetError(null);
            }}
            className="font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Back to sign in
          </button>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Google OAuth Button */}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={handleGoogleSignIn}
        disabled={loading}
      >
        <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
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
        Continue with Google
      </Button>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <Separator className="w-full" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Or continue with</span>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="email"
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
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <button
            type="button"
            onClick={() => {
              setForgotMode(true);
              setResetEmail(email);
            }}
            className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Forgot password?
          </button>
        </div>
        <div className="relative">
          <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
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
            Signing in...
          </>
        ) : (
          'Sign in'
        )}
      </Button>

      {onSignUpClick && (
        <p className="text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{' '}
          <button
            type="button"
            onClick={onSignUpClick}
            className="font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Create an account
          </button>
        </p>
      )}
    </form>
  );
}
