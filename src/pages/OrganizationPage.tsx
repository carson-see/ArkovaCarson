/**
 * Organization Page
 *
 * Shows org members and org-wide records for ORG_ADMIN users.
 * For INDIVIDUAL users, shows a prompt to join an organization.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Users, Plus, Settings, Loader2, Check, Upload, UserPlus } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useOrgMembers } from '@/hooks/useOrgMembers';
import { useOrganization } from '@/hooks/useOrganization';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { useInviteMember } from '@/hooks/useInviteMember';
import { AppShell } from '@/components/layout';
import { OrgRegistryTable, MembersTable, IssueCredentialForm, RevokeDialog, InviteMemberModal } from '@/components/organization';
import { BulkUploadWizard } from '@/components/upload';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ROUTES, recordDetailPath } from '@/lib/routes';
import type { Database } from '@/types/database.types';

type Anchor = Database['public']['Tables']['anchors']['Row'];

export function OrganizationPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { members, loading: membersLoading } = useOrgMembers(profile?.org_id);
  const { organization, updating: orgUpdating, updateOrganization } = useOrganization(profile?.org_id);
  const { revokeAnchor } = useRevokeAnchor();
  const { inviteMember } = useInviteMember();
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Anchor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [orgDisplayName, setOrgDisplayName] = useState('');
  const [orgDomain, setOrgDomain] = useState('');
  const [orgSettingsInit, setOrgSettingsInit] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);

  // Initialize org settings fields
  if (organization && !orgSettingsInit) {
    setOrgDisplayName(organization.display_name ?? '');
    setOrgDomain(organization.domain ?? '');
    setOrgSettingsInit(true);
  }

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleViewAnchor = useCallback((anchor: Anchor) => {
    navigate(recordDetailPath(anchor.id));
  }, [navigate]);

  const handleRevokeAnchor = useCallback((anchor: Anchor) => {
    setRevokeTarget(anchor);
  }, []);

  const handleConfirmRevoke = useCallback(async (reason: string) => {
    if (!revokeTarget) return;
    const success = await revokeAnchor(revokeTarget.id, reason);
    if (success) {
      setRevokeTarget(null);
      setRefreshKey((k) => k + 1);
    }
  }, [revokeTarget, revokeAnchor]);

  const handleInvite = useCallback(async (email: string, role: 'INDIVIDUAL' | 'ORG_ADMIN') => {
    if (!profile?.org_id) return;
    await inviteMember(email, role, profile.org_id);
  }, [inviteMember, profile?.org_id]);

  // Individual users without an org see a placeholder
  if (!profileLoading && profile && !profile.org_id) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut} orgName={organization?.display_name}>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
            <Building2 className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-semibold mb-2">No Organization</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            You are not currently part of an organization. Join an organization to share verification capabilities with your team.
          </p>
          <Badge variant="secondary" className="mt-4">Coming Soon</Badge>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut} orgName={organization?.display_name}>
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
        <p className="text-muted-foreground mt-1">
          Manage team members and organization records
        </p>
      </div>

      {/* Members section */}
      <Card className="mb-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Users className="h-5 w-5" />
            Team Members
            {!membersLoading && members.length > 0 && (
              <Badge variant="secondary">{members.length}</Badge>
            )}
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Invite Member
          </Button>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          <MembersTable
            members={members}
            loading={membersLoading}
            currentUserId={user?.id}
          />
        </CardContent>
      </Card>

      {/* Org settings section */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Organization Settings
          </CardTitle>
          <CardDescription>
            Update your organization display name and domain
          </CardDescription>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4 space-y-4 max-w-lg">
          <div className="space-y-2">
            <Label htmlFor="org-display-name">Display Name</Label>
            <Input
              id="org-display-name"
              value={orgDisplayName}
              onChange={(e) => { setOrgDisplayName(e.target.value); setOrgSaved(false); }}
              placeholder="Organization display name"
              disabled={orgUpdating}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-domain">Domain</Label>
            <Input
              id="org-domain"
              value={orgDomain}
              onChange={(e) => { setOrgDomain(e.target.value); setOrgSaved(false); }}
              placeholder="example.com"
              disabled={orgUpdating}
            />
            <p className="text-xs text-muted-foreground">
              Used for verifier display on public verification pages
            </p>
          </div>
          <Button
            onClick={async () => {
              const success = await updateOrganization({
                display_name: orgDisplayName.trim(),
                domain: orgDomain.trim() || null,
              });
              if (success) {
                setOrgSaved(true);
                setTimeout(() => setOrgSaved(false), 2000);
              }
            }}
            disabled={orgUpdating || !orgDisplayName.trim()}
            size="sm"
          >
            {orgUpdating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (orgSaved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Saved
              </>
            ) : (
              'Save Settings'
            ))}
          </Button>
        </CardContent>
      </Card>

      {/* Org records section */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Organization Records</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setBulkUploadOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              Bulk Upload
            </Button>
            <Button onClick={() => setIssueDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Issue Credential
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          {profile?.org_id ? (
            <OrgRegistryTable
              key={refreshKey}
              orgId={profile.org_id}
              onViewAnchor={handleViewAnchor}
              onRevokeAnchor={handleRevokeAnchor}
            />
          ) : null}
        </CardContent>
      </Card>

      {/* Issue Credential Dialog */}
      <IssueCredentialForm
        open={issueDialogOpen}
        onOpenChange={(open) => {
          setIssueDialogOpen(open);
          if (!open) setRefreshKey((k) => k + 1);
        }}
      />

      {/* Bulk Upload Dialog */}
      <Dialog open={bulkUploadOpen} onOpenChange={setBulkUploadOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Upload</DialogTitle>
          </DialogHeader>
          <BulkUploadWizard
            onComplete={() => {
              setBulkUploadOpen(false);
              setRefreshKey((k) => k + 1);
            }}
            onCancel={() => setBulkUploadOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Invite Member Modal */}
      <InviteMemberModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvite={handleInvite}
      />

      {/* Revoke Dialog */}
      <RevokeDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        recordName={revokeTarget?.filename ?? ''}
        onConfirm={handleConfirmRevoke}
      />
    </AppShell>
  );
}
