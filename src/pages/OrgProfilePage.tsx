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
  Building2, Settings, Plus, Upload, UserPlus, Users,
  ArrowLeft, Crown, Shield, User, Loader2, Check, ExternalLink,
  Globe, MapPin, Calendar, Camera, Link2,
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
import { OrgRegistryTable, MembersTable, IssueCredentialForm, RevokeDialog, InviteMemberModal, AddExistingMemberModal } from '@/components/organization';
import { BulkUploadWizard } from '@/components/upload';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ROUTES, issuerRegistryPath } from '@/lib/routes';
import { ORG_PAGE_LABELS, ORG_LOGO_LABELS, SUB_ORG_LABELS } from '@/lib/copy';
import { isPlatformAdmin } from '@/lib/platform';
import { OrgVerification } from '@/components/org/OrgVerification';
import { ManageSubOrgs } from '@/components/org/ManageSubOrgs';
import { RequestAffiliationDialog } from '@/components/org/RequestAffiliationDialog';
import { OrgVerifiedBadge, AffiliatedBadge } from '@/components/shared/VerifiedBadge';
import { WORKER_URL } from '@/lib/workerClient';
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
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Anchor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [affiliationDialogOpen, setAffiliationDialogOpen] = useState(false);
  const [subOrgRefreshKey, setSubOrgRefreshKey] = useState(0);

  // Org records count
  const [recordsCount, setRecordsCount] = useState<number | null>(null);

  // Settings state
  const [orgDisplayName, setOrgDisplayName] = useState('');
  const [orgDomain, setOrgDomain] = useState('');
  const [orgDescription, setOrgDescription] = useState('');
  const [orgWebsiteUrl, setOrgWebsiteUrl] = useState('');
  const [orgType, setOrgType] = useState('');
  const [orgLinkedinUrl, setOrgLinkedinUrl] = useState('');
  const [orgLocation, setOrgLocation] = useState('');
  const [orgFoundedDate, setOrgFoundedDate] = useState('');
  const [orgSettingsInit, setOrgSettingsInit] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);

  // Logo upload state
  const [logoUploading, setLogoUploading] = useState(false);

  // Sub-org affiliation state
  const [parentOrgName, setParentOrgName] = useState<string | null>(null);

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

  // Fetch org records count (personal anchors only, exclude pipeline)
  useEffect(() => {
    async function fetchRecordsCount() {
      if (!orgId) return;
      const { count, error: countError } = await supabase
        .from('anchors')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .is('deleted_at', null);
      if (!countError && count !== null) {
        setRecordsCount(count);
      }
    }
    fetchRecordsCount();
  }, [orgId, refreshKey]);

  // Fetch parent org name for child orgs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgAny = organization as any;
  const parentOrgId = orgAny?.parent_org_id as string | null;
  const parentApprovalStatus = orgAny?.parent_approval_status as string | null;
  const isChildOrg = !!parentOrgId;
  const isVerifiedOrg = organization?.verification_status === 'VERIFIED';

  useEffect(() => {
    async function fetchParentOrgName() {
      if (!parentOrgId) {
        setParentOrgName(null);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from('organizations')
        .select('display_name')
        .eq('id', parentOrgId)
        .single();
      setParentOrgName(data?.display_name ?? null);
    }
    fetchParentOrgName();
  }, [parentOrgId]);

  // Initialize settings fields when org loads
  if (organization && !orgSettingsInit) {
    setOrgDisplayName(organization.display_name ?? '');
    setOrgDomain(organization.domain ?? '');
    setOrgDescription((organization as Record<string, unknown>).description as string ?? '');
    setOrgWebsiteUrl((organization as Record<string, unknown>).website_url as string ?? '');
    setOrgType((organization as Record<string, unknown>).org_type as string ?? '');
    setOrgLinkedinUrl((organization as Record<string, unknown>).linkedin_url as string ?? '');
    setOrgLocation((organization as Record<string, unknown>).location as string ?? '');
    setOrgFoundedDate((organization as Record<string, unknown>).founded_date as string ?? '');
    setOrgSettingsInit(true);
  }

  // Logo upload handler
  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !orgId) return;

    // Validate file
    const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
    const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error('Please upload a PNG, JPG, or WebP image.');
      return;
    }
    if (file.size > MAX_SIZE) {
      toast.error('Logo must be under 2 MB.');
      return;
    }

    setLogoUploading(true);
    const ext = file.name.split('.').pop() ?? 'png';
    const path = `${orgId}/logo.${ext}`;

    // Upload to storage (upsert to overwrite existing)
    const { error: uploadError } = await supabase.storage
      .from('org-logos')
      .upload(path, file, { upsert: true, contentType: file.type });

    if (uploadError) {
      toast.error(ORG_LOGO_LABELS.UPLOAD_FAILED);
      setLogoUploading(false);
      return;
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from('org-logos').getPublicUrl(path);
    const logoUrl = urlData?.publicUrl;

    if (logoUrl) {
      // Update org record with logo_url
      await updateOrganization({ logo_url: logoUrl });
      toast.success(ORG_LOGO_LABELS.UPLOAD_SUCCESS);
    }

    setLogoUploading(false);
    // Reset the input so re-selecting the same file triggers onChange
    e.target.value = '';
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgPrefix = (organization as any)?.org_prefix as string | null;
  const orgLogoUrl = (organization as Record<string, unknown>)?.logo_url as string | null;
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
    await inviteMember({
      email,
      role,
      orgId,
      orgName: organization?.display_name ?? 'Your Organization',
      inviterName: profile?.full_name ?? undefined,
    });
  }, [inviteMember, orgId, organization?.display_name, profile?.full_name]);

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
      {/* LinkedIn-style profile card */}
      <Card className="mb-6 overflow-hidden border-border/50">
        {/* Cover banner — tall gradient with back button */}
        <div className="h-32 sm:h-40 md:h-48 bg-gradient-to-br from-primary/30 via-primary/15 to-primary/5 relative">
          <Button variant="ghost" size="icon" className="absolute top-3 left-3 bg-background/60 backdrop-blur-sm hover:bg-background/80" onClick={() => navigate(ROUTES.ORGANIZATIONS)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>

        {/* Profile info section */}
        <CardContent className="relative pt-0 pb-0">
          {/* Org logo overlapping banner */}
          <div className="-mt-14 mb-3 flex items-end justify-between">
            <div className="relative group">
              <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-lg border-4 border-background bg-card shadow-xl overflow-hidden">
                {orgLogoUrl ? (
                  <img src={orgLogoUrl} alt={organization?.display_name ?? 'Organization logo'} className="h-full w-full object-cover" />
                ) : (
                  <Building2 className="h-14 w-14 text-primary" />
                )}
              </div>
              {isAdmin && (
                <label
                  className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  aria-label={orgLogoUrl ? ORG_LOGO_LABELS.CHANGE_LOGO : ORG_LOGO_LABELS.UPLOAD_LOGO}
                >
                  {logoUploading ? (
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  ) : (
                    <Camera className="h-6 w-6 text-white" />
                  )}
                  <input
                    type="file"
                    className="sr-only"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleLogoUpload}
                    disabled={logoUploading}
                  />
                </label>
              )}
            </div>
            {/* Action buttons (top right) */}
            <div className="flex gap-2 pb-2">
              {userRole && (
                <Badge variant="outline" className="text-xs h-8 px-3">
                  {userRole === 'owner' && <Crown className="mr-1.5 h-3.5 w-3.5" />}
                  {userRole === 'admin' && <Shield className="mr-1.5 h-3.5 w-3.5" />}
                  {userRole === 'member' && <User className="mr-1.5 h-3.5 w-3.5" />}
                  {userRole.charAt(0).toUpperCase() + userRole.slice(1)}
                </Badge>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate(issuerRegistryPath(orgId))}>
                <ExternalLink className="mr-2 h-4 w-4" />
                View Public Page
              </Button>
            </div>
          </div>

          {/* Org name + verification badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">
              {organization?.display_name ?? 'Organization'}
            </h1>
            {organization?.verification_status === 'VERIFIED' && (
              <OrgVerifiedBadge />
            )}
          </div>

          {/* Tagline / description */}
          {organization?.legal_name && organization.legal_name !== organization.display_name && (
            <p className="text-sm text-muted-foreground mt-1">{organization.legal_name}</p>
          )}

          {/* Meta row: domain, location, founding date */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm text-muted-foreground">
            {organization?.domain && (
              <span className="flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" />
                {organization.domain}
              </span>
            )}
            {orgPrefix && (
              <span className="flex items-center gap-1.5 font-mono text-xs">
                <MapPin className="h-3.5 w-3.5" />
                {orgPrefix}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Founded {organization?.created_at ? new Date(organization.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'}
            </span>
          </div>

          {/* Stats row — LinkedIn-style follower/connection counts */}
          <div className="flex items-center gap-6 mt-4 pb-4 text-sm">
            <span className="text-muted-foreground">
              <strong className="text-foreground font-semibold">{recordsCount !== null ? recordsCount.toLocaleString() : '—'}</strong> records
            </span>
            <span className="text-muted-foreground">
              <strong className="text-foreground font-semibold">{members.length}</strong> {members.length === 1 ? 'member' : 'members'}
            </span>
          </div>
        </CardContent>

        {/* Tabs integrated into the card bottom — like LinkedIn */}
        <Tabs defaultValue="home" className="w-full">
          <div className="border-t border-border/50 px-4 md:px-6">
            <TabsList className="h-auto bg-transparent p-0 gap-0">
              <TabsTrigger value="home" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-3 text-sm font-medium">
                Home
              </TabsTrigger>
              <TabsTrigger value="people" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-3 text-sm font-medium">
                People
              </TabsTrigger>
              {isAdmin && (
                <TabsTrigger value="settings" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-3 text-sm font-medium">
                  Settings
                </TabsTrigger>
              )}
            </TabsList>
          </div>

        {/* Home Tab — Records (like LinkedIn posts feed) */}
        <TabsContent value="home" className="p-4 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Records</h2>
            {isAdmin && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setBulkUploadOpen(true)}>
                  <Upload className="mr-2 h-4 w-4" />
                  {ORG_PAGE_LABELS.BULK_UPLOAD}
                </Button>
                <Button size="sm" onClick={() => setIssueDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4 shrink-0" />
                  <span className="hidden sm:inline">{ORG_PAGE_LABELS.ISSUE_CREDENTIAL}</span>
                  <span className="sm:hidden">Issue</span>
                </Button>
              </div>
            )}
          </div>
          <OrgRegistryTable
            key={refreshKey}
            orgId={orgId}
            onViewAnchor={handleViewAnchor}
            onRevokeAnchor={isAdmin ? handleRevokeAnchor : undefined}
          />
        </TabsContent>

        {/* People Tab */}
        <TabsContent value="people" className="p-4 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              People
              {!membersLoading && members.length > 0 && (
                <Badge variant="secondary" className="text-xs">{members.length}</Badge>
              )}
            </h2>
            {isAdmin && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setAddMemberOpen(true)}>
                  <Users className="mr-2 h-4 w-4" />
                  Add Member
                </Button>
                <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
                  <UserPlus className="mr-2 h-4 w-4" />
                  {ORG_PAGE_LABELS.INVITE_MEMBER}
                </Button>
              </div>
            )}
          </div>
          <MembersTable
            members={members}
            loading={membersLoading}
            currentUserId={user?.id}
            onChangeRole={isAdmin ? handleChangeRole : undefined}
          />
        </TabsContent>

        {/* Settings Tab (admin only) */}
        {isAdmin && (
          <TabsContent value="settings" className="p-4 md:p-6">
            <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
              <Settings className="h-5 w-5" />
              Organization Settings
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              Manage your public organization profile. This information is visible on your public page.
            </p>
            <div className="space-y-5 max-w-xl">
              {/* Basic Info */}
              <div className="space-y-2">
                <Label htmlFor="org-display-name">Organization Name *</Label>
                <Input
                  id="org-display-name"
                  value={orgDisplayName}
                  onChange={(e) => { setOrgDisplayName(e.target.value); setOrgSaved(false); }}
                  placeholder="Acme Corporation"
                  disabled={orgUpdating}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-description">Description</Label>
                <textarea
                  id="org-description"
                  value={orgDescription}
                  onChange={(e) => { setOrgDescription(e.target.value); setOrgSaved(false); }}
                  placeholder="Brief description of your organization..."
                  disabled={orgUpdating}
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-type">Organization Type</Label>
                <select
                  id="org-type"
                  value={orgType}
                  onChange={(e) => { setOrgType(e.target.value); setOrgSaved(false); }}
                  disabled={orgUpdating}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Select type...</option>
                  <option value="corporation">Corporation</option>
                  <option value="university">University / Educational Institution</option>
                  <option value="government">Government Agency</option>
                  <option value="nonprofit">Non-Profit Organization</option>
                  <option value="law_firm">Law Firm</option>
                  <option value="healthcare">Healthcare Organization</option>
                  <option value="financial">Financial Institution</option>
                  <option value="other">Other</option>
                </select>
              </div>

              {/* Links & Location */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="org-domain">Domain</Label>
                  <Input
                    id="org-domain"
                    value={orgDomain}
                    onChange={(e) => { setOrgDomain(e.target.value); setOrgSaved(false); }}
                    placeholder="example.com"
                    disabled={orgUpdating}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-website">Website URL</Label>
                  <Input
                    id="org-website"
                    value={orgWebsiteUrl}
                    onChange={(e) => { setOrgWebsiteUrl(e.target.value); setOrgSaved(false); }}
                    placeholder="https://example.com"
                    disabled={orgUpdating}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="org-linkedin">LinkedIn Page</Label>
                  <Input
                    id="org-linkedin"
                    value={orgLinkedinUrl}
                    onChange={(e) => { setOrgLinkedinUrl(e.target.value); setOrgSaved(false); }}
                    placeholder="https://linkedin.com/company/..."
                    disabled={orgUpdating}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-location">Headquarters</Label>
                  <Input
                    id="org-location"
                    value={orgLocation}
                    onChange={(e) => { setOrgLocation(e.target.value); setOrgSaved(false); }}
                    placeholder="San Francisco, CA"
                    disabled={orgUpdating}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-founded">Founded</Label>
                <Input
                  id="org-founded"
                  type="date"
                  value={orgFoundedDate}
                  onChange={(e) => { setOrgFoundedDate(e.target.value); setOrgSaved(false); }}
                  disabled={orgUpdating}
                />
              </div>

              <Button
                onClick={async () => {
                  const updates: Parameters<typeof updateOrganization>[0] = {
                    display_name: orgDisplayName.trim(),
                    domain: orgDomain.trim() || undefined,
                    description: orgDescription.trim() || undefined,
                    website_url: orgWebsiteUrl.trim() || undefined,
                    org_type: orgType || undefined,
                    linkedin_url: orgLinkedinUrl.trim() || undefined,
                    location: orgLocation.trim() || undefined,
                    founded_date: orgFoundedDate || undefined,
                  };
                  // Remove undefined fields so Supabase only sends actual changes
                  const cleaned = Object.fromEntries(
                    Object.entries(updates).filter(([, v]) => v !== undefined)
                  );
                  const success = await updateOrganization(cleaned as Parameters<typeof updateOrganization>[0]);
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

              {/* Organization Verification (IDT WS4) */}
              <div className="mt-8">
                <OrgVerification
                  verificationStatus={organization?.verification_status ?? 'UNVERIFIED'}
                  domain={organization?.domain}
                  domainVerified={(organization as Record<string, unknown>)?.domain_verified as boolean | undefined}
                  hasEin={!!(organization as Record<string, unknown>)?.ein_tax_id}
                  onVerified={() => window.location.reload()}
                />
              </div>
            </div>

            {/* Sub-Organization Affiliation (IDT-11) */}
            <div className="mt-8">
              <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
                <Link2 className="h-5 w-5" />
                {SUB_ORG_LABELS.SECTION_TITLE}
              </h3>

              {/* Child org view: show parent affiliation status */}
              {isChildOrg && (
                <div className="mb-6 p-4 rounded-lg border border-border/50 bg-card">
                  {parentApprovalStatus === 'APPROVED' && parentOrgName && (
                    <div className="flex items-center gap-3">
                      <AffiliatedBadge parentName={parentOrgName} />
                      <span className="text-sm text-muted-foreground">
                        {SUB_ORG_LABELS.AFFILIATED_WITH} <strong className="text-foreground">{parentOrgName}</strong>
                      </span>
                    </div>
                  )}
                  {parentApprovalStatus === 'PENDING' && parentOrgName && (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">
                          {SUB_ORG_LABELS.STATUS_PENDING}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {SUB_ORG_LABELS.PENDING_APPROVAL} <strong className="text-foreground">{parentOrgName}</strong>
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-400 border-red-500/20 hover:bg-red-500/10"
                        onClick={async () => {
                          try {
                            const { data: { session } } = await supabase.auth.getSession();
                            if (!session?.access_token) return;
                            const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/cancel`, {
                              method: 'POST',
                              headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${session.access_token}`,
                              },
                            });
                            if (response.ok) {
                              toast.success(SUB_ORG_LABELS.CANCEL_SUCCESS);
                              window.location.reload();
                            }
                          } catch {
                            // Handle silently
                          }
                        }}
                      >
                        {SUB_ORG_LABELS.CANCEL_REQUEST}
                      </Button>
                    </div>
                  )}
                  {parentApprovalStatus === 'REVOKED' && parentOrgName && (
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20 text-xs">
                        {SUB_ORG_LABELS.STATUS_REVOKED}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {SUB_ORG_LABELS.REVOKED_BY} <strong className="text-foreground">{parentOrgName}</strong>
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Request affiliation button (for non-child orgs or revoked) */}
              {!isChildOrg && (
                <div className="mb-6">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAffiliationDialogOpen(true)}
                  >
                    <Link2 className="mr-2 h-4 w-4" />
                    {SUB_ORG_LABELS.REQUEST_AFFILIATION}
                  </Button>
                </div>
              )}

              {/* Parent org view: manage sub-orgs (only for verified orgs or orgs with existing sub-orgs) */}
              {(isVerifiedOrg || !isChildOrg) && orgId && (
                <ManageSubOrgs key={subOrgRefreshKey} orgId={orgId} />
              )}
            </div>
          </TabsContent>
        )}
        </Tabs>
      </Card>

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

      {orgId && (
        <AddExistingMemberModal
          open={addMemberOpen}
          onOpenChange={setAddMemberOpen}
          orgId={orgId}
          onMemberAdded={() => setRefreshKey((k) => k + 1)}
        />
      )}

      <RevokeDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        recordName={revokeTarget?.filename ?? ''}
        onConfirm={handleConfirmRevoke}
      />

      {orgId && (
        <RequestAffiliationDialog
          open={affiliationDialogOpen}
          onOpenChange={setAffiliationDialogOpen}
          currentOrgId={orgId}
          onRequested={() => {
            setSubOrgRefreshKey((k) => k + 1);
            window.location.reload();
          }}
        />
      )}
    </AppShell>
  );
}
