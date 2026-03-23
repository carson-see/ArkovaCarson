/**
 * Organization Profile Page
 *
 * Full org detail view with tabs: Overview, Members, Records, Settings.
 * Accessible by org members and platform admins.
 * Replaces the old single-org OrganizationPage for multi-org support.
 */

import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Building2, Users, FileText, Settings, Plus, Upload, UserPlus,
  ArrowLeft, Crown, Shield, User, Loader2, Check, ExternalLink,
  BarChart3,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useOrganization } from '@/hooks/useOrganization';
import { useOrgMembers } from '@/hooks/useOrgMembers';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { useInviteMember } from '@/hooks/useInviteMember';
import { supabase } from '@/lib/supabase';
import { AppShell } from '@/components/layout';
import { OrgRegistryTable, MembersTable, IssueCredentialForm, RevokeDialog, InviteMemberModal } from '@/components/organization';
import { BulkUploadWizard } from '@/components/upload';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ROUTES, issuerRegistryPath } from '@/lib/routes';
import { ORG_PAGE_LABELS } from '@/lib/copy';
import { isPlatformAdmin } from '@/lib/platform';
import type { Database } from '@/types/database.types';

type Anchor = Database['public']['Tables']['anchors']['Row'];

type OrgMemberRole = 'owner' | 'admin' | 'member';

export function OrgProfilePage() {
  const navigate = useNavigate();
  const { orgId } = useParams<{ orgId: string }>();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { organization, updating: orgUpdating, updateOrganization } = useOrganization(orgId ?? null);
  const { members, loading: membersLoading } = useOrgMembers(orgId ?? null);
  const { revokeAnchor } = useRevokeAnchor();
  const { inviteMember } = useInviteMember();

  // User's role in this org
  const [userRole, setUserRole] = useState<OrgMemberRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);

  // Dialog state
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Anchor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Settings state
  const [orgDisplayName, setOrgDisplayName] = useState('');
  const [orgDomain, setOrgDomain] = useState('');
  const [orgSettingsInit, setOrgSettingsInit] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);

  // Fetch user's role in this org
  useEffect(() => {
    async function fetchRole() {
      if (!user || !orgId) {
        setRoleLoading(false);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from('org_members')
        .select('role')
        .eq('user_id', user.id)
        .eq('org_id', orgId)
        .single();

      setUserRole((data?.role as OrgMemberRole) ?? null);
      setRoleLoading(false);
    }
    fetchRole();
  }, [user, orgId]);

  // Initialize settings fields when org loads
  if (organization && !orgSettingsInit) {
    setOrgDisplayName(organization.display_name ?? '');
    setOrgDomain(organization.domain ?? '');
    setOrgSettingsInit(true);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgPrefix = (organization as any)?.org_prefix as string | null;
  const isAdmin = userRole === 'owner' || userRole === 'admin' || isPlatformAdmin(user?.email);
  const _isOwner = userRole === 'owner' || isPlatformAdmin(user?.email);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleViewAnchor = useCallback((anchor: Anchor) => {
    navigate(`/records/${anchor.id}`);
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
    if (!orgId) return;
    await inviteMember(email, role, orgId);
  }, [inviteMember, orgId]);

  const handleChangeRole = useCallback(async (member: { id: string; fullName: string | null; email: string }, newRole: 'ORG_ADMIN' | 'INDIVIDUAL') => {
    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', member.id);
    if (error) {
      toast.error('Failed to update member role.');
    } else {
      toast.success(`${member.fullName || member.email} is now ${newRole === 'ORG_ADMIN' ? 'an Admin' : 'a Member'}.`);
    }
  }, []);

  if (!orgId) {
    navigate(ROUTES.ORGANIZATIONS);
    return null;
  }

  // Loading state
  if (roleLoading || profileLoading) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  // Access check: must be member or platform admin
  if (!userRole && !isPlatformAdmin(user?.email)) {
    return (
      <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
        <div className="flex flex-col items-center justify-center py-20 max-w-md mx-auto text-center">
          <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">Access Denied</h2>
          <p className="text-sm text-muted-foreground mb-6">
            You are not a member of this organization.
          </p>
          <Button variant="outline" onClick={() => navigate(ROUTES.ORGANIZATIONS)}>
            Back to Organizations
          </Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut} orgName={organization?.display_name}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(ROUTES.ORGANIZATIONS)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Building2 className="h-6 w-6 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight truncate">
                {organization?.display_name ?? 'Loading...'}
              </h1>
              {/* org_prefix added in migration 0085, cast until types regenerated */}
              {orgPrefix && (
                <Badge variant="secondary" className="font-mono text-[10px] shrink-0">
                  {orgPrefix}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {organization?.domain && <span>{organization.domain}</span>}
              {userRole && (
                <Badge variant="outline" className="text-[10px]">
                  {userRole === 'owner' && <Crown className="mr-1 h-3 w-3" />}
                  {userRole === 'admin' && <Shield className="mr-1 h-3 w-3" />}
                  {userRole === 'member' && <User className="mr-1 h-3 w-3" />}
                  {userRole.charAt(0).toUpperCase() + userRole.slice(1)}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(issuerRegistryPath(orgId))}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Public Profile
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Users className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">{members.length}</p>
              <p className="text-xs text-muted-foreground">Members</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">{refreshKey >= 0 ? '—' : '0'}</p>
              <p className="text-xs text-muted-foreground">Records</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">
                {organization?.verification_status === 'VERIFIED' ? 'Verified' : 'Pending'}
              </p>
              <p className="text-xs text-muted-foreground">Status</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-semibold">
                {organization?.created_at ? new Date(organization.created_at).toLocaleDateString() : '—'}
              </p>
              <p className="text-xs text-muted-foreground">Created</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabbed content */}
      <Tabs defaultValue="members" className="space-y-4">
        <TabsList>
          <TabsTrigger value="members" className="gap-2">
            <Users className="h-4 w-4" />
            Members
          </TabsTrigger>
          <TabsTrigger value="records" className="gap-2">
            <FileText className="h-4 w-4" />
            Records
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="settings" className="gap-2">
              <Settings className="h-4 w-4" />
              Settings
            </TabsTrigger>
          )}
        </TabsList>

        {/* Members Tab */}
        <TabsContent value="members">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5" />
                Team Members
                {!membersLoading && members.length > 0 && (
                  <Badge variant="secondary">{members.length}</Badge>
                )}
              </CardTitle>
              {isAdmin && (
                <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
                  <UserPlus className="mr-2 h-4 w-4" />
                  {ORG_PAGE_LABELS.INVITE_MEMBER}
                </Button>
              )}
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <MembersTable
                members={members}
                loading={membersLoading}
                currentUserId={user?.id}
                onChangeRole={isAdmin ? handleChangeRole : undefined}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Records Tab */}
        <TabsContent value="records">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-lg">Organization Records</CardTitle>
              {isAdmin && (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setBulkUploadOpen(true)}>
                    <Upload className="mr-2 h-4 w-4" />
                    {ORG_PAGE_LABELS.BULK_UPLOAD}
                  </Button>
                  <Button onClick={() => setIssueDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    {ORG_PAGE_LABELS.ISSUE_CREDENTIAL}
                  </Button>
                </div>
              )}
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <OrgRegistryTable
                key={refreshKey}
                orgId={orgId}
                onViewAnchor={handleViewAnchor}
                onRevokeAnchor={isAdmin ? handleRevokeAnchor : undefined}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings Tab (admin only) */}
        {isAdmin && (
          <TabsContent value="settings">
            <Card>
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
          </TabsContent>
        )}
      </Tabs>

      {/* Dialogs */}
      <IssueCredentialForm
        open={issueDialogOpen}
        onOpenChange={(open) => {
          setIssueDialogOpen(open);
          if (!open) setRefreshKey((k) => k + 1);
        }}
      />

      <Dialog open={bulkUploadOpen} onOpenChange={setBulkUploadOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ORG_PAGE_LABELS.BULK_UPLOAD_DIALOG_TITLE}</DialogTitle>
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

      <InviteMemberModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvite={handleInvite}
      />

      <RevokeDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        recordName={revokeTarget?.filename ?? ''}
        onConfirm={handleConfirmRevoke}
      />
    </AppShell>
  );
}
