/**
 * Manual Review Gate Component
 *
 * Displayed when a user's account requires manual review.
 * Blocks access until review is completed by admin.
 */

import { Clock, ShieldAlert, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface ManualReviewGateProps {
  reason?: string;
  onSignOut?: () => void;
}

export function ManualReviewGate({ reason, onSignOut }: Readonly<ManualReviewGateProps>) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 mb-4">
            <ShieldAlert className="h-8 w-8 text-amber-600" />
          </div>
          <CardTitle>Account Under Review</CardTitle>
          <CardDescription>
            Your account requires manual verification before you can proceed
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-start gap-4 p-4 bg-muted rounded-lg">
            <Clock className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-sm">What happens next?</p>
              <p className="text-sm text-muted-foreground">
                Our team will review your account within 1-2 business days.
                You'll receive an email once the review is complete.
              </p>
            </div>
          </div>

          {reason && (
            <div className="p-4 border rounded-lg">
              <p className="text-sm font-medium mb-1">Review reason:</p>
              <p className="text-sm text-muted-foreground">{reason}</p>
            </div>
          )}

          <div className="flex items-start gap-4 p-4 bg-muted rounded-lg">
            <Mail className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-sm">Questions?</p>
              <p className="text-sm text-muted-foreground">
                Contact support if you believe this is an error or need
                assistance with your verification.
              </p>
            </div>
          </div>

          {onSignOut && (
            <Button
              variant="outline"
              className="w-full"
              onClick={onSignOut}
            >
              Sign out
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
