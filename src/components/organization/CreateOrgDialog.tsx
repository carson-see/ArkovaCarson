/**
 * Create Organization Dialog
 *
 * Allows users to create a new organization from the OrganizationsListPage.
 * Uses the update_profile_onboarding RPC (same as onboarding flow).
 *
 * @see Session 10 — Sprint A fix for broken Create Organization button
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
} from '@/components/ui/dialog';
import { useOnboarding } from '@/hooks/useOnboarding';
import { useProfile } from '@/hooks/useProfile';

interface CreateOrgDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (orgId: string) => void;
}

export function CreateOrgDialog({ open, onOpenChange, onCreated }: CreateOrgDialogProps) {
  const { createOrg, loading, error, clearError } = useOnboarding();
  const { refreshProfile } = useProfile();
  const [displayName, setDisplayName] = useState('');
  const [domain, setDomain] = useState('');

  const handleSubmit = async () => {
    if (!displayName.trim()) return;

    const result = await createOrg({
      legalName: displayName.trim(),
      displayName: displayName.trim(),
      domain: domain.trim() || null,
    });

    if (result?.success) {
      toast.success('Organization created successfully');
      await refreshProfile();
      setDisplayName('');
      setDomain('');
      onOpenChange(false);
      if (result.org_id && onCreated) {
        onCreated(result.org_id);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (!o) {
        clearError();
        setDisplayName('');
        setDomain('');
      }
      onOpenChange(o);
    }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Organization</DialogTitle>
          <DialogDescription>
            Set up a new organization to manage team credentials.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="create-org-name">Organization Name</Label>
            <Input
              id="create-org-name"
              placeholder="Acme Corp"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-org-domain">Domain (optional)</Label>
            <Input
              id="create-org-domain"
              placeholder="acme.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              Used for verifier display on public verification pages
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !displayName.trim()}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Organization
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
