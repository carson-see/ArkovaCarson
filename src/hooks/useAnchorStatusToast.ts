/**
 * useAnchorStatusToast Hook (BETA-13)
 *
 * Fires a toast notification when an anchor's status changes
 * via realtime subscription. Tracks previous status via ref
 * to detect transitions.
 *
 * @see BETA-13 — Realtime Anchor Status Subscriptions
 */

import { useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { REALTIME_TOAST_LABELS } from '@/lib/copy';

/**
 * Watches an anchor status string and fires a toast when it changes.
 * Skips the initial render (no toast on mount).
 */
export function useAnchorStatusToast(status: string | undefined): void {
  const prevStatusRef = useRef<string | undefined>(undefined);
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (!status) return;

    if (isInitialMount.current) {
      isInitialMount.current = false;
      prevStatusRef.current = status;
      return;
    }

    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (prev === status) return;

    // Status changed — fire appropriate toast
    if (status === 'SECURED') {
      toast.success(REALTIME_TOAST_LABELS.SECURED);
      // Browser notification (Design Audit #17)
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Document Secured', {
          body: 'Your document has been permanently anchored and is now independently verifiable.',
          icon: '/favicon.ico',
        });
      } else if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
    } else if (status === 'REVOKED') {
      toast.error(REALTIME_TOAST_LABELS.REVOKED);
    } else if (status === 'EXPIRED') {
      toast.warning(REALTIME_TOAST_LABELS.EXPIRED);
    } else if (status === 'SUBMITTED') {
      toast.info(REALTIME_TOAST_LABELS.SUBMITTED);
    }
  }, [status]);
}
