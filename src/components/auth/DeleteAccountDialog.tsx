/**
 * Delete Account Dialog — GDPR Art. 17 Right to Erasure (PII-02)
 *
 * Confirmation dialog with typed confirmation before account deletion.
 * Calls the worker DELETE /api/account endpoint.
 */

import { useState, useCallback } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { workerFetch } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';
import { ACCOUNT_DELETE_LABELS } from '@/lib/copy';

interface DeleteAccountDialogProps {
  userEmail: string;
}

export function DeleteAccountDialog({ userEmail }: Readonly<DeleteAccountDialogProps>) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const CONFIRMATION_TEXT = 'DELETE';

  const handleDelete = useCallback(async () => {
    if (confirmation !== CONFIRMATION_TEXT) return;

    setDeleting(true);
    setError(null);

    try {
      const response = await workerFetch('/api/account', {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as Record<string, string>).error ?? 'Deletion failed');
      }

      // Sign out locally after successful deletion
      await supabase.auth.signOut();
      window.location.href = '/login';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Account deletion failed');
      setDeleting(false);
    }
  }, [confirmation]);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); setConfirmation(''); setError(null); }}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm">
          {ACCOUNT_DELETE_LABELS.DELETE_BUTTON}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {ACCOUNT_DELETE_LABELS.DIALOG_TITLE}
          </DialogTitle>
          <DialogDescription>
            {ACCOUNT_DELETE_LABELS.DIALOG_DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {ACCOUNT_DELETE_LABELS.WARNING}
            </AlertDescription>
          </Alert>

          <div className="text-sm text-muted-foreground space-y-2">
            <p>{ACCOUNT_DELETE_LABELS.CONSEQUENCES_INTRO}</p>
            <ul className="list-disc list-inside space-y-1">
              <li>{ACCOUNT_DELETE_LABELS.CONSEQUENCE_1}</li>
              <li>{ACCOUNT_DELETE_LABELS.CONSEQUENCE_2}</li>
              <li>{ACCOUNT_DELETE_LABELS.CONSEQUENCE_3}</li>
              <li>{ACCOUNT_DELETE_LABELS.CONSEQUENCE_4}</li>
            </ul>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delete-confirm">
              Type <span className="font-mono font-bold">{CONFIRMATION_TEXT}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={CONFIRMATION_TEXT}
              disabled={deleting}
              autoComplete="off"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Account: <span className="font-mono">{userEmail}</span>
          </p>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={confirmation !== CONFIRMATION_TEXT || deleting}
          >
            {deleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {ACCOUNT_DELETE_LABELS.DELETING}
              </>
            ) : (
              ACCOUNT_DELETE_LABELS.CONFIRM_BUTTON
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
