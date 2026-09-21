/**
 * Add Existing Member Modal
 *
 * Modal for adding existing platform users to an organization.
 * Searches profiles by email and adds them directly (no invitation needed).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Users, Loader2, Mail, AlertCircle, CheckCircle2 } from 'lucide-react';
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
import { z } from 'zod';
import { workerFetch } from '@/lib/workerClient';
import { ORG_MEMBER_ADD_LABELS } from '@/lib/copy';

const addMemberSchema = z.object({
  orgId: z.string().uuid(),
  email: z.string().trim().email().max(320),
  role: z.enum(['INDIVIDUAL', 'ORG_ADMIN']),
});

type MemberRole = 'INDIVIDUAL' | 'ORG_ADMIN';

interface AddedUser {
  email: string;
  fullName: string | null;
}

const addMemberResponse = z.object({
  success: z.literal(true),
  member: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    fullName: z.string().nullable(),
  }).strict(),
  idempotent: z.boolean(),
}).strict();

interface AddExistingMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  onMemberAdded: () => void;
  /**
   * Retained for caller compatibility. Both platform and organization admins
   * now use the same exact-org-authorized worker action.
   */
  useAdminEndpoints?: boolean;
}

export function AddExistingMemberModal({
  open,
  onOpenChange,
  orgId,
  onMemberAdded,
}: Readonly<AddExistingMemberModalProps>) {
  const [searchEmail, setSearchEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('INDIVIDUAL');
  const [adding, setAdding] = useState(false);
  const addPendingRef = useRef(false);
  const requestScopeRef = useRef(0);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [addedUser, setAddedUser] = useState<AddedUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const resetForm = useCallback(() => {
    requestScopeRef.current += 1;
    addPendingRef.current = false;
    setAdding(false);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setSearchEmail('');
    setRole('INDIVIDUAL');
    setAddedUser(null);
    setError(null);
    setSuccess(false);
  }, []);

  useEffect(() => {
    resetForm();
    return () => {
      requestScopeRef.current += 1;
      addPendingRef.current = false;
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [orgId, open, resetForm]);

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!adding) {
        onOpenChange(newOpen);
        if (!newOpen) {
          resetForm();
        }
      }
    },
    [adding, onOpenChange, resetForm]
  );

  const handleAdd = useCallback(async () => {
    if (addPendingRef.current) return;
    const parsed = addMemberSchema.safeParse({
      orgId,
      email: searchEmail,
      role,
    });

    if (!parsed.success) {
      setError('Invalid input. Please check the form and try again.');
      return;
    }

    addPendingRef.current = true;
    const requestScope = ++requestScopeRef.current;
    setAdding(true);
    setError(null);

    try {
      const res = await workerFetch(`/api/organization-members/${parsed.data.orgId}/existing`, {
        method: 'POST',
        body: JSON.stringify({ email: parsed.data.email, role: parsed.data.role }),
      });
      const rawBody: unknown = await res.json().catch(() => ({}));
      if (requestScope !== requestScopeRef.current) return;
      if (!res.ok) {
        const errorBody = z.object({ error: z.string().max(200) }).safeParse(rawBody);
        setError(errorBody.success && errorBody.data.error === 'membership_role_conflict'
          ? ORG_MEMBER_ADD_LABELS.ROLE_CONFLICT
          : errorBody.success ? errorBody.data.error : ORG_MEMBER_ADD_LABELS.FAILURE);
        return;
      }
      const body = addMemberResponse.safeParse(rawBody);
      if (!body.success) {
        setError(ORG_MEMBER_ADD_LABELS.FAILURE);
        return;
      }

      setAddedUser(body.data.member);
      setSuccess(true);
      onMemberAdded();

      // Auto-close after brief delay
      closeTimerRef.current = setTimeout(() => {
        if (requestScope !== requestScopeRef.current) return;
        handleOpenChange(false);
      }, 1500);
    } catch {
      setError('Failed to add member. Please try again.');
    } finally {
      if (requestScope === requestScopeRef.current) {
        addPendingRef.current = false;
        setAdding(false);
      }
    }
  }, [searchEmail, orgId, role, onMemberAdded, handleOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <DialogTitle>{ORG_MEMBER_ADD_LABELS.TITLE}</DialogTitle>
          </div>
          <DialogDescription>
            {ORG_MEMBER_ADD_LABELS.DESCRIPTION}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert className="border-green-200 bg-green-50 text-green-800">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription>
                {addedUser?.fullName || addedUser?.email} has been added to your organization!
              </AlertDescription>
            </Alert>
          )}

          {/* Search */}
          <div className="space-y-2">
            <Label htmlFor="search-email">{ORG_MEMBER_ADD_LABELS.EMAIL_LABEL}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="search-email"
                  type="email"
                  placeholder="user@example.com"
                  value={searchEmail}
                  onChange={(e) => {
                    setSearchEmail(e.target.value);
                    setAddedUser(null);
                    setError(null);
                    setSuccess(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAdd();
                    }
                  }}
                  disabled={adding || success}
                  className="pl-9"
                />
              </div>
              <Button
                type="button"
                onClick={handleAdd}
                disabled={adding || !searchEmail.trim() || success}
              >
                {adding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  ORG_MEMBER_ADD_LABELS.ACTION
                )}
              </Button>
            </div>
          </div>

          {!success && (
            <div className="rounded-lg border p-4 bg-muted/30">
              <div className="space-y-2">
                <Label htmlFor="member-role">Role</Label>
                <Select
                  value={role}
                  onValueChange={(value) => setRole(value as MemberRole)}
                  disabled={adding}
                >
                  <SelectTrigger id="member-role">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INDIVIDUAL">Member</SelectItem>
                    <SelectItem value="ORG_ADMIN">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={adding}
          >
            {success ? 'Close' : 'Cancel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
