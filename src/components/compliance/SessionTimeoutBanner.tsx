/**
 * Session Timeout Warning Banner — REG-06 (SCRUM-565)
 *
 * Displays a warning banner when the user's session is about to timeout.
 * HIPAA Section 164.312(a)(2)(iii) — automatic logoff.
 */

import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { HIPAA_LABELS } from '@/lib/copy';

interface SessionTimeoutBannerProps {
  minutesRemaining: number;
  onDismiss: () => void;
}

export function SessionTimeoutBanner({ minutesRemaining, onDismiss }: SessionTimeoutBannerProps) {
  return (
    <Alert variant="destructive" className="fixed top-4 right-4 z-50 max-w-md shadow-lg">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>
          {HIPAA_LABELS.SESSION_TIMEOUT_SETTING}: {minutesRemaining} minute{minutesRemaining !== 1 ? 's' : ''} remaining.
        </span>
        <Button variant="outline" size="sm" onClick={onDismiss}>
          Stay Signed In
        </Button>
      </AlertDescription>
    </Alert>
  );
}
