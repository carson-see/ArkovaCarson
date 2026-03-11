/**
 * Invite Member Modal
 *
 * Modal for inviting new members to an organization by email.
 */

import { useState, useCallback } from 'react';
import { UserPlus, Loader2, Mail, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type InviteRole = 'INDIVIDUAL' | 'ORG_ADMIN';

interface InviteMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvite: (email: string, role: InviteRole) => Promise<void>;
}

export function InviteMemberModal({
  open,
  onOpenChange,
  onInvite,
}: InviteMemberModalProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('INDIVIDUAL');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setEmail('');
    setRole('INDIVIDUAL');
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!loading) {
        onOpenChange(newOpen);
        if (!newOpen) {
          resetForm();
        }
      }
    },
    [loading, onOpenChange, resetForm]
  );

  const validateEmail = (email: string): boolean => {
    // Non-backtracking email regex (avoids ReDoS)
    // Local part: one or more non-whitespace/non-@ chars
    // Domain: one or more segments of [a-zA-Z0-9-] separated by dots, ending with 2+ alpha TLD
    const emailRegex = /^[^\s@]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      const trimmedEmail = email.trim().toLowerCase();

      if (!trimmedEmail) {
        setError('Email address is required.');
        return;
      }

      if (!validateEmail(trimmedEmail)) {
        setError('Please enter a valid email address.');
        return;
      }

      setLoading(true);
      try {
        await onInvite(trimmedEmail, role);
        onOpenChange(false);
        resetForm();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to send invitation.';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [email, role, onInvite, onOpenChange, resetForm]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <UserPlus className="h-5 w-5 text-primary" />
            </div>
            <DialogTitle>Invite Team Member</DialogTitle>
          </div>
          <DialogDescription>
            Send an invitation to join your organization. They'll receive an email with
            instructions to create their account.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="invite-email">Email address</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="invite-email"
                type="email"
                placeholder="colleague@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
                className="pl-9"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as InviteRole)}
              disabled={loading}
            >
              <SelectTrigger id="invite-role">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="INDIVIDUAL">
                  <div className="flex flex-col items-start">
                    <span>Member</span>
                    <span className="text-xs text-muted-foreground">
                      Can view and create records
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="ORG_ADMIN">
                  <div className="flex flex-col items-start">
                    <span>Admin</span>
                    <span className="text-xs text-muted-foreground">
                      Full access including member management
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !email.trim()}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Send Invitation
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
