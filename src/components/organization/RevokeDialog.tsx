/**
 * Revoke Record Dialog
 *
 * Confirmation dialog for revoking a secured record.
 * Includes an optional reason field (persisted to DB).
 */

import { useState, useCallback } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FORM_LABELS } from '@/lib/copy';

interface RevokeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recordName: string;
  onConfirm: (reason: string) => Promise<void>;
}

export function RevokeDialog({
  open,
  onOpenChange,
  recordName,
  onConfirm,
}: Readonly<RevokeDialogProps>) {
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const isConfirmed = confirmation.toLowerCase() === 'revoke';

  const handleConfirm = useCallback(async () => {
    if (!isConfirmed) return;

    setLoading(true);
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
    } finally {
      setLoading(false);
      setConfirmation('');
      setReason('');
    }
  }, [isConfirmed, onConfirm, onOpenChange, reason]);

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!loading) {
      onOpenChange(newOpen);
      if (!newOpen) {
        setConfirmation('');
        setReason('');
      }
    }
  }, [loading, onOpenChange]);

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" />
            </div>
            <AlertDialogTitle>Revoke Record</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="space-y-3">
            <p>
              You are about to revoke the secured record for{' '}
              <span className="font-medium text-foreground">{recordName}</span>.
            </p>
            <p>
              This action is permanent and cannot be undone. The record will be marked
              as revoked and will no longer be verifiable.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="revoke-reason">
              {FORM_LABELS.REVOCATION_REASON}
            </Label>
            <Textarea
              id="revoke-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={FORM_LABELS.REVOCATION_REASON_PLACEHOLDER}
              disabled={loading}
              maxLength={2000}
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="revoke-confirm">
              Type <span className="font-mono font-semibold">revoke</span> to confirm
            </Label>
            <Input
              id="revoke-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="revoke"
              disabled={loading}
            />
          </div>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={!isConfirmed || loading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Revoking...
              </>
            ) : (
              'Revoke Record'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
