/**
 * Add Existing Member Modal
 *
 * Modal for adding existing platform users to an organization.
 * Searches profiles by email and adds them directly (no invitation needed).
 */

import { useState, useCallback } from 'react';
import { Users, Loader2, Mail, AlertCircle, CheckCircle2, Search } from 'lucide-react';
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
import { supabase } from '@/lib/supabase';
import { workerFetch } from '@/lib/workerClient';

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  orgId: z.string().uuid(),
  role: z.enum(['INDIVIDUAL', 'ORG_ADMIN']),
});

type MemberRole = 'INDIVIDUAL' | 'ORG_ADMIN';

interface FoundUser {
  id: string;
  email: string;
  full_name: string | null;
}

interface AddExistingMemberModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  onMemberAdded: () => void;
  /**
   * When true, search + add go through the service_role worker admin endpoints
   * instead of the browser's RLS-scoped Supabase queries. Set by OrgProfilePage
   * when the viewer is a platform admin who is NOT a member of this org — their
   * RLS-scoped `profiles`/`org_members` reads return 0 rows, so the client-side
   * path can't find users or detect existing members.
   */
  useAdminEndpoints?: boolean;
}

export function AddExistingMemberModal({
  open,
  onOpenChange,
  orgId,
  onMemberAdded,
  useAdminEndpoints = false,
}: Readonly<AddExistingMemberModalProps>) {
  const [searchEmail, setSearchEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('INDIVIDUAL');
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [foundUser, setFoundUser] = useState<FoundUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const resetForm = useCallback(() => {
    setSearchEmail('');
    setRole('INDIVIDUAL');
    setFoundUser(null);
    setError(null);
    setSuccess(false);
  }, []);

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

  const handleSearch = useCallback(async () => {
    const trimmed = searchEmail.trim().toLowerCase();
    if (!trimmed) {
      setError('Please enter an email address to search.');
      return;
    }

    setSearching(true);
    setError(null);
    setFoundUser(null);
    setSuccess(false);

    try {
      if (useAdminEndpoints) {
        // Platform admin viewing a foreign org: RLS hides profiles/org_members
        // from them, so search via the service_role worker endpoint. The
        // endpoint also tells us if the user already belongs (its add path
        // returns 409), but we surface the cleaner "already a member" message
        // up-front by relying on the add call's response.
        const res = await workerFetch(
          `/api/admin/users/search?email=${encodeURIComponent(trimmed)}`,
          { method: 'GET' },
        );
        if (!res.ok) {
          setError('Search failed. Please try again.');
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { user: FoundUser | null };
        if (!body.user) {
          setError('No user found with that email. Use "Invite Member" to send them an invitation instead.');
          return;
        }
        setFoundUser(body.user);
        return;
      }

      // Standard org-member path: search for user by email
      const { data: profiles, error: searchError } = await supabase
        .from('profiles')
        .select('id, email, full_name')
        .eq('email', trimmed)
        .limit(1);

      if (searchError) {
        setError('Search failed. Please try again.');
        return;
      }

      if (!profiles || profiles.length === 0) {
        setError('No user found with that email. Use "Invite Member" to send them an invitation instead.');
        return;
      }

      // Check if already a member.
      // The table is `org_members` (id, user_id, org_id, role, joined_at,
      // invited_by) — NOT `org_memberships`, which does not exist and returned
      // PGRST205 "table not found" (silently swallowed, so the guard never
      // fired).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await (supabase as any)
        .from('org_members')
        .select('id')
        .eq('user_id', profiles[0].id)
        .eq('org_id', orgId)
        .limit(1);

      if (existing && existing.length > 0) {
        setError('This user is already a member of your organization.');
        return;
      }

      setFoundUser(profiles[0]);
    } catch {
      setError('Search failed. Please try again.');
    } finally {
      setSearching(false);
    }
  }, [searchEmail, orgId, useAdminEndpoints]);

  const handleAdd = useCallback(async () => {
    if (!foundUser) return;

    // Validate inputs with Zod before calling RPC
    const parsed = addMemberSchema.safeParse({
      userId: foundUser.id,
      orgId,
      role,
    });

    if (!parsed.success) {
      setError('Invalid input. Please check the form and try again.');
      return;
    }

    setAdding(true);
    setError(null);

    try {
      if (useAdminEndpoints) {
        // Platform-admin path: the add_org_member RPC checks auth.uid() against
        // org_members and would reject a platform admin who isn't a member of
        // this org. Use the service_role worker endpoint instead.
        const res = await workerFetch(`/api/admin/organizations/${parsed.data.orgId}/members`, {
          method: 'POST',
          body: JSON.stringify({ user_id: parsed.data.userId, role: parsed.data.role }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error || 'Failed to add member.');
          return;
        }
      } else {
        // Standard org-admin path: add via SECURITY DEFINER RPC — no direct insert fallback
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: addError } = await (supabase as any).rpc('add_org_member', {
          p_user_id: parsed.data.userId,
          p_org_id: parsed.data.orgId,
          p_role: parsed.data.role,
        });

        if (addError) {
          setError(addError.message || 'Failed to add member.');
          return;
        }
      }

      setSuccess(true);
      onMemberAdded();

      // Auto-close after brief delay
      setTimeout(() => {
        handleOpenChange(false);
      }, 1500);
    } catch {
      setError('Failed to add member. Please try again.');
    } finally {
      setAdding(false);
    }
  }, [foundUser, orgId, role, onMemberAdded, handleOpenChange, useAdminEndpoints]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <DialogTitle>Add Existing Member</DialogTitle>
          </div>
          <DialogDescription>
            Search for an existing platform user by email and add them to your organization.
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
                {foundUser?.full_name || foundUser?.email} has been added to your organization!
              </AlertDescription>
            </Alert>
          )}

          {/* Search */}
          <div className="space-y-2">
            <Label htmlFor="search-email">Search by email</Label>
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
                    setFoundUser(null);
                    setError(null);
                    setSuccess(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSearch();
                    }
                  }}
                  disabled={searching || adding || success}
                  className="pl-9"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                aria-label="Search"
                onClick={handleSearch}
                disabled={searching || adding || !searchEmail.trim() || success}
              >
                {searching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Found user display */}
          {foundUser && !success && (
            <div className="rounded-lg border p-4 bg-muted/30">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {(foundUser.full_name?.[0] || foundUser.email[0]).toUpperCase()}
                </div>
                <div>
                  <p className="font-medium">{foundUser.full_name || 'No name set'}</p>
                  <p className="text-sm text-muted-foreground">{foundUser.email}</p>
                </div>
              </div>

              <div className="mt-3 space-y-2">
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
          {foundUser && !success && (
            <Button onClick={handleAdd} disabled={adding}>
              {adding ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Users className="mr-2 h-4 w-4" />
                  Add to Organization
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
