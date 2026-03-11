/**
 * Email Confirmation Component
 *
 * Success state shown after signup requesting email verification.
 */

import { Mail, ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
}

export function EmailConfirmation({
  email,
  onResend,
  onBack,
  resending = false,
}: Readonly<EmailConfirmationProps>) {
  return (
    <Card className="max-w-md mx-auto">
      <CardHeader className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 mb-4">
          <Mail className="h-8 w-8 text-primary" />
        </div>
        <CardTitle>Check your email</CardTitle>
        <CardDescription>
          We sent a verification link to confirm your account
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="text-center p-4 bg-muted rounded-lg">
          <p className="font-medium text-sm break-all">{email}</p>
        </div>

        <div className="space-y-2 text-sm text-muted-foreground">
          <p>Click the link in the email to verify your account and sign in.</p>
          <p>
            The link expires in 24 hours. If you don't see the email, check your
            spam folder.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          {onResend && (
            <Button
              variant="outline"
              className="w-full"
              onClick={onResend}
              disabled={resending}
            >
              {resending ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Resend email
                </>
              )}
            </Button>
          )}

          {onBack && (
            <Button variant="ghost" className="w-full" onClick={onBack}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to sign up
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
