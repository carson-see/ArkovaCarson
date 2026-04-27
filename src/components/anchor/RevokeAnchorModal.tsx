/**
 * RevokeAnchorModal — confirmation dialog for SCRUM-1096 (ADMIN-VIEW-05).
 *
 * Required reason field (textarea, ≥4 chars). Disclaimer body explains the
 * on-chain anchor remains immutable. Loading state while revoke in flight.
 *
 * The actual permission check is enforced server-side by the `revoke_anchor`
 * RPC (Postgres SECURITY DEFINER + role gate emits `insufficient_privilege`).
 * The parent component is still responsible for not rendering this modal at
 * all when the user is not an ORG_ADMIN — defense in depth.
 */
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';

const MIN_REASON_CHARS = 4;
const MAX_REASON_CHARS = 1000;

export interface RevokeAnchorModalProps {
  open: boolean;
  onClose: () => void;
  anchorId: string;
  filename: string;
  onRevoked?: () => void;
}

export function RevokeAnchorModal({
  open,
  onClose,
  anchorId,
  filename,
  onRevoked,
}: Readonly<RevokeAnchorModalProps>) {
  const [reason, setReason] = useState('');
  const { revokeAnchor, loading } = useRevokeAnchor();

  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= MIN_REASON_CHARS && trimmed.length <= MAX_REASON_CHARS;

  const handleConfirm = async () => {
    if (!reasonValid || loading) return;
    const success = await revokeAnchor(anchorId, trimmed);
    if (success) {
      setReason('');
      onClose();
      onRevoked?.();
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && !loading) {
      setReason('');
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark as Revoked</DialogTitle>
          <DialogDescription>
            This marks the record &ldquo;{filename}&rdquo; as Revoked. The underlying network
            receipt remains immutable on the network — revocation is recorded as a separate,
            verifiable event so verifiers see the latest status while the original receipt is
            preserved.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 py-2">
          <Label htmlFor="revoke-reason">Reason (required)</Label>
          <Textarea
            id="revoke-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Issued in error, replaced by new version, …"
            rows={3}
            maxLength={MAX_REASON_CHARS}
            disabled={loading}
            aria-invalid={!reasonValid && reason.length > 0}
            aria-describedby="revoke-reason-help"
          />
          <p id="revoke-reason-help" className="text-xs text-muted-foreground">
            {trimmed.length === 0
              ? `Required. Minimum ${MIN_REASON_CHARS} characters — captured in the audit log.`
              : trimmed.length < MIN_REASON_CHARS
                ? `Add at least ${MIN_REASON_CHARS - trimmed.length} more character${
                    MIN_REASON_CHARS - trimmed.length === 1 ? '' : 's'
                  }.`
                : `${trimmed.length} / ${MAX_REASON_CHARS} characters`}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!reasonValid || loading}
          >
            {loading ? 'Revoking…' : 'Mark as Revoked'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
