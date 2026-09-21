/**
 * Email Confirmation Component
 *
 * Success state shown after signup requesting email verification.
 */

import { useEffect, useState } from 'react';
import { Mail, ArrowLeft, RefreshCw, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SIGNUP_EMAIL_CONFIRMATION_LABELS } from '@/lib/copy';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface EmailConfirmationProps {
  email: string;
  onResend?: () => void;
  onBack?: () => void;
  resending?: boolean;
  resendAvailableAt?: number;
  resendResult?: 'success' | 'error';
}

export function EmailConfirmation({
  email,
  onResend,
  onBack,
  resending = false,
  resendAvailableAt,
  resendResult,
}: Readonly<EmailConfirmationProps>) {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const resendWaitSeconds = resendAvailableAt === undefined
    ? 0
    : Math.max(0, Math.ceil((resendAvailableAt - currentTime) / 1000));
  const waitingToResend = resendWaitSeconds > 0;

  useEffect(() => {
    if (!waitingToResend) return;
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waitingToResend, resendAvailableAt]);

  return (
    <Card className="max-w-md mx-auto">
      <CardHeader className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 mb-4">
          <Mail className="h-8 w-8 text-primary" />
        </div>
        <CardTitle>{SIGNUP_EMAIL_CONFIRMATION_LABELS.TITLE}</CardTitle>
        <CardDescription>
          {SIGNUP_EMAIL_CONFIRMATION_LABELS.DESCRIPTION}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="text-center p-4 bg-muted rounded-lg">
          <p className="font-medium text-sm break-all">{email}</p>
        </div>

        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{SIGNUP_EMAIL_CONFIRMATION_LABELS.INSTRUCTION}</p>
          <p>{SIGNUP_EMAIL_CONFIRMATION_LABELS.EXPIRY}</p>
        </div>

        {resendResult === 'success' && (
          <p role="status" className="text-sm text-center text-primary">
            {SIGNUP_EMAIL_CONFIRMATION_LABELS.RESEND_SUCCESS}
          </p>
        )}
        {resendResult === 'error' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{SIGNUP_EMAIL_CONFIRMATION_LABELS.RESEND_ERROR}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          {onResend && (
            <Button
              variant="outline"
              className="w-full"
              onClick={onResend}
              disabled={resending || waitingToResend}
            >
              {resending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  {SIGNUP_EMAIL_CONFIRMATION_LABELS.RESENDING}
                </>
              ) : waitingToResend ? (
                <>{SIGNUP_EMAIL_CONFIRMATION_LABELS.RESEND_WAIT} {resendWaitSeconds}s</>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {SIGNUP_EMAIL_CONFIRMATION_LABELS.RESEND}
                </>
              )}
            </Button>
          )}

          {onBack && (
            <Button variant="ghost" className="w-full" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              {SIGNUP_EMAIL_CONFIRMATION_LABELS.BACK}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
