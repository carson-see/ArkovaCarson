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
import { supabase } from '@/lib/supabase';

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
}

export function AddExistingMemberModal({
  open,
  onOpenChange,
  orgId,
  onMemberAdded,
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
      // Search for user by email
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

      // Check if already a member
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: existing } = await (supabase as any)
        .from('org_memberships')
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
  }, [searchEmail, orgId]);

  const handleAdd = useCallback(async () => {
    if (!foundUser) return;

    setAdding(true);
    setError(null);

    try {
      // Add user to organization via RPC
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: addError } = await (supabase.rpc as any)('add_org_member', {
        p_user_id: foundUser.id,
        p_org_id: orgId,
        p_role: role,
      });

      if (addError) {
        // If the RPC doesn't exist, fall back to direct insert
        if (addError.message?.includes('function') && addError.message?.includes('does not exist')) {
          // Direct insert fallback
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: insertError } = await (supabase as any)
            .from('org_memberships')
            .insert({
              user_id: foundUser.id,
              org_id: orgId,
              role,
            });

          if (insertError) {
            setError(insertError.message || 'Failed to add member.');
            return;
          }

          // Also update the user's profile org_id if not set
          await supabase
            .from('profiles')
            .update({ org_id: orgId, role })
            .eq('id', foundUser.id)
            .is('org_id', null);
        } else {
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
  }, [foundUser, orgId, role, onMemberAdded, handleOpenChange]);

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
