/**
 * Organization Profile Page
 *
 * Full org detail view with tabs: Overview, Members, Records, Settings.
 * Accessible by org members and platform admins.
 * Replaces the old single-org OrganizationPage for multi-org support.
 */

import { useState, useCallback, useEffect } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bell, Building2, ListChecks, Settings, Plus, UserPlus, Users, ArrowLeft, Crown, User, Loader2, Check, ExternalLink, Globe, MapPin, Calendar, Camera, Link2, ScrollText } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useOrganization } from '@/hooks/useOrganization';
import { useOrgMembers } from '@/hooks/useOrgMembers';
import { useOrgInvitations, type OrgInvitation } from '@/hooks/useOrgInvitations';
import { useAdminOrgMembers } from '@/hooks/useAdminOrgMembers';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { useInviteMember } from '@/hooks/useInviteMember';
import { supabase } from '@/lib/supabase';
import { AppShell } from '@/components/layout';
import { OrgRegistryTable, MembersTable, PendingInvitationsList, IssueCredentialForm, RevokeDialog, InviteMemberModal, AddExistingMemberModal } from '@/components/organization';
import { SecureDocumentDialog } from '@/components/anchor';
import { useCanIssueCredential } from '@/hooks/useCanIssueCredential';
import { useIssueCredentialSplit } from '@/hooks/useIssueCredentialSplit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ROUTES, issuerRegistryPath } from '@/lib/routes';
import { ORG_PAGE_LABELS, ORG_LOGO_LABELS, SUB_ORG_LABELS, INDUSTRY_TAG_OPTIONS, CONNECTIONS_LABELS, PENDING_INVITATIONS_LABELS } from '@/lib/copy';
import { isPlatformAdmin } from '@/lib/platform';
import { getOrganizationFoundedDisplay } from '@/lib/organizationDates';
import { OrgVerification } from '@/components/org/OrgVerification';
import { ManageSubOrgs, translateWorkerError, type SubOrgCounts } from '@/components/org/ManageSubOrgs';
import { RequestAffiliationDialog } from '@/components/org/RequestAffiliationDialog';
import { OrgVerifiedBadge, AffiliatedBadge } from '@/components/shared/VerifiedBadge';
import { DriveConnectorCard } from '@/components/integrations/DriveConnectorCard';
import { DocusignConnectorCard } from '@/components/integrations/DocusignConnectorCard';
import { MemberDocusignConnectorCard } from '@/components/integrations/MemberDocusignConnectorCard';
import { AdobeSignConnectorCard, adobeSignErrorCopy } from '@/components/integrations/AdobeSignConnectorCard';
import { WORKER_URL, workerFetch } from '@/lib/workerClient';
import type { Database } from '@/types/database.types';

type Anchor = Database['public']['Tables']['anchors']['Row'];

type OrgMemberRole = 'owner' | 'admin' | 'member';

/**
 * Shared tab-trigger styling. Extracted when the fourth tab (Affiliates) was
 * added — four copies of a 160-character class string had already started to
 * drift. `whitespace-nowrap` keeps the labels on one line inside the
 * horizontally scrolling row at 375 px.
 */
const TAB_TRIGGER_CLASS =
  'rounded-none border-b-2 border-transparent data-[state=active]:border-primary ' +
  'data-[state=active]:bg-transparent px-3 md:px-4 py-3 text-sm font-medium whitespace-nowrap';

export function OrgProfilePage() {
  const navigate = useNavigate();
  const { orgId } = useParams<{ orgId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const platformAdmin = isPlatformAdmin(profile);
  const { organization, updating: orgUpdating, updateOrganization } = useOrganization(orgId ?? null, platformAdmin);
  const { members: orgMembers, loading: orgMembersLoading, refreshMembers: refreshOrgMembers } = useOrgMembers(orgId ?? null);
  const { revokeAnchor } = useRevokeAnchor();
  const { inviteMember } = useInviteMember({ platformAdmin });

  // User's role in this org
  const [userRole, setUserRole] = useState<OrgMemberRole | null>(null);
  const [roleLoading, setRoleLoading] = useState(true);
  const isAdmin = userRole === 'owner' || userRole === 'admin' || platformAdmin;
  const issueCredentialRole = isAdmin ? 'ORG_ADMIN' : 'INDIVIDUAL';

  // Admin-only: the "Org admins can view invitations" RLS policy already
  // scopes reads to ORG_ADMIN, but gating the query too avoids a predictably
  // empty round-trip for non-admin viewers.
  const {
    invitations: pendingInvitations,
    loading: invitationsLoading,
    error: invitationsError,
    refreshInvitations,
  } = useOrgInvitations(isAdmin ? orgId ?? null : null, platformAdmin);

  // Platform-admin-viewing-a-foreign-org: the admin is NOT a member of this org,
  // so the browser's RLS-scoped queries (useOrgMembers, profiles search) return 0
  // rows. Route the roster + add-member flow through the service_role worker
  // endpoints instead. Real org members keep the client-side path untouched.
  const isForeignOrgAdmin = platformAdmin && !roleLoading && !userRole;
  const { members: adminMembers, loading: adminMembersLoading, refreshMembers: refreshAdminMembers } = useAdminOrgMembers(
    orgId ?? null,
    isForeignOrgAdmin,
  );
  const members = isForeignOrgAdmin ? adminMembers : orgMembers;
  const membersLoading = isForeignOrgAdmin ? adminMembersLoading : orgMembersLoading;
  const refreshMembers = isForeignOrgAdmin ? refreshAdminMembers : refreshOrgMembers;

  // Dialog state
  const [issueDialogOpen, setIssueDialogOpen] = useState(false);
  // SCRUM-1755 — universal "Secure Document" replaces the legacy bulk-only chooser.
  // Bulk auto-detection (multiple files OR CSV/XLSX) lives inside SecureDocumentDialog.
  const [secureDialogOpen, setSecureDialogOpen] = useState(false);
  // Fail-closed during the flag-fetch window: while loading, treat the flag as
  // ON so unauthorized org admins can't see the Issue Credential CTA briefly
  // before the flag resolves. (Pre-1755 behavior is preserved once we know the
  // flag is OFF.)
  const split = useIssueCredentialSplit();
  const issueGate = useCanIssueCredential({
    orgId: orgId ?? null,
    role: issueCredentialRole,
    profileLoading: profileLoading || roleLoading,
  });
  const splitEnforced = split.loading || split.enabled;
  const showIssueButton = isAdmin && (!splitEnforced || issueGate.allowed);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Anchor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [affiliationDialogOpen, setAffiliationDialogOpen] = useState(false);
  const [subOrgRefreshKey, setSubOrgRefreshKey] = useState(0);
  /**
   * Counts reported by ManageSubOrgs, or `null` while unknown / after a failed
   * load. Founder feedback 2026-09-13: a parent admin with an affiliation
   * request waiting had nothing on any screen telling them so — the Approve
   * button sat 2,396 px down the Settings tab at 1280 px and 2,996 px down at
   * 375 px (docs/uat/suborg-ux/discoverability-*.json). `null` renders no
   * badge at all, because a badge reading "0" after a failed fetch would be a
   * reassurance we have not earned.
   */
  const [subOrgCounts, setSubOrgCounts] = useState<SubOrgCounts | null>(null);

  // Org records count
  const [recordsCount, setRecordsCount] = useState<number | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);

  // Settings state
  const [orgDisplayName, setOrgDisplayName] = useState('');
  const [orgDomain, setOrgDomain] = useState('');
  const [orgDescription, setOrgDescription] = useState('');
  const [orgWebsiteUrl, setOrgWebsiteUrl] = useState('');
  const [orgType, setOrgType] = useState('');
  const [orgLinkedinUrl, setOrgLinkedinUrl] = useState('');
  const [orgTwitterUrl, setOrgTwitterUrl] = useState('');
  const [orgIndustryTag, setOrgIndustryTag] = useState('');
  const [orgLocation, setOrgLocation] = useState('');
  const [orgFoundedDate, setOrgFoundedDate] = useState('');
  const [orgSettingsInit, setOrgSettingsInit] = useState(false);
  const [orgSaved, setOrgSaved] = useState(false);

  // Logo upload state
  const [logoUploading, setLogoUploading] = useState(false);

  // Sub-org affiliation state
  const [parentOrgName, setParentOrgName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(() => {
    const requested = searchParams.get('tab');
    return requested === 'settings' || requested === 'affiliates' ? requested : 'home';
  });

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
        .is('deleted_at', null)
        .is('metadata->>pipeline_source', null);
      if (!countError && count !== null) {
        setRecordsCount(count);
      }
    }
    fetchRecordsCount();
  }, [orgId, refreshKey]);

  useEffect(() => {
    async function fetchUnreadNotifications() {
      if (!orgId || !userRole) return;
      try {
        const res = await workerFetch('/api/notifications/unread-count', { method: 'GET' });
        if (!res.ok) return;
        const body = await res.json().catch(() => ({})) as { count?: number };
        setUnreadNotifications(typeof body.count === 'number' ? body.count : 0);
      } catch {
        setUnreadNotifications(0);
      }
    }
    void fetchUnreadNotifications();
  }, [orgId, userRole]);

  // Fetch parent org name for child orgs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orgAny = organization as any;
  const parentOrgId = orgAny?.parent_org_id as string | null;
  const parentApprovalStatus = orgAny?.parent_approval_status as string | null;
  const isChildOrg = !!parentOrgId;
  const isVerifiedOrg = organization?.verification_status === 'VERIFIED';
  const parentOrgDisplayName = parentOrgName ?? SUB_ORG_LABELS.PARENT_ORGANIZATION;

  // Founder feedback 2026-09-13: this used to return early unless the status
  // was APPROVED, so the two states where a child most needs to know WHO to
  // chase — PENDING and REVOKED — rendered the literal fallback string
  // ("Affiliation revoked by parent organization", see
  // docs/uat/suborg-ux/step11-revoked-child-dead-end-1280.png). The gate on
  // status is removed; the query is attempted for any child with a parent now.
  //
  // CTO review (2026-09-13): removing the status gate does not, by itself,
  // make the name arrive. This is a direct `.from('organizations')` read, and
  // the ONLY SELECT policy on that table is `organizations_select_member`
  // (`supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`),
  // restricted to org ids in the CALLER's own `get_user_org_ids()`. A child
  // org's members are never added to the parent's `org_members` — only the
  // reverse happens, when a parent creates a new affiliate
  // (`buildAffiliateMembershipRows`, `services/worker/src/api/v1/orgSubOrgs.ts`)
  // — so for a child that REQUESTED affiliation into an existing parent (the
  // common path), RLS denies this read and PostgREST returns zero rows: no
  // thrown error, `data` is `null`, and the UI falls back to the generic
  // `SUB_ORG_LABELS.PARENT_ORGANIZATION` label below — gracefully, not a
  // crash or a leak, but also not the real name. `OrgProfilePageAffiliates.test.tsx`
  // pins both directions: the render-logic tests above (mocked as if RLS
  // allowed the read) AND the two tests under "when the parent-name read is
  // RLS-blocked" (the shape PostgREST actually returns). Making the name
  // reach the client for real needs a child-scoped SECURITY DEFINER RPC
  // (narrower than `search_organizations_public`, which searches by name/
  // domain, not by id) — a backend change, out of scope for a frontend-only
  // PR. Flagged as a follow-up; do not read this query's presence as proof
  // the feature works end to end.
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
    setOrgTwitterUrl((organization as Record<string, unknown>).twitter_url as string ?? '');
    setOrgIndustryTag((organization as Record<string, unknown>).industry_tag as string ?? '');
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
  const orgFoundedDisplay = getOrganizationFoundedDisplay(organization);
  const _isOwner = userRole === 'owner' || isPlatformAdmin(profile);

  useEffect(() => {
    const driveResult = searchParams.get('drive');
    const driveError = searchParams.get('drive_error');
    const docusignResult = searchParams.get('docusign');
    const docusignError = searchParams.get('docusign_error');
    const adobeSignResult = searchParams.get('adobe_sign');
    const adobeSignError = searchParams.get('adobe_sign_error');

    if (driveResult === 'connected') {
      toast.success('Google Drive connected.');
    } else if (driveError) {
      toast.error('Google Drive connection was not completed.');
    }

    if (docusignResult === 'connected') {
      toast.success(CONNECTIONS_LABELS.TOAST_CONNECTED);
    } else if (docusignError) {
      toast.error(`${CONNECTIONS_LABELS.TOAST_ERROR_PREFIX}${docusignError}`);
    }

    // SCRUM-1148 follow-up. Unlike Drive/DocuSign above, the Adobe error is not
    // a raw code echoed at the user: `webhook_registration_failed` means the
    // Adobe account plan does not grant `webhook_write`, and
    // `webhook_already_claimed` means another org holds this webhook id. Both
    // need copy that says what to actually do, so the code -> copy mapping goes
    // through `adobeSignErrorCopy()` (exported by the card, single source).
    if (adobeSignResult === 'connected') {
      toast.success(CONNECTIONS_LABELS.ADOBE_SIGN_TOAST_CONNECTED);
    } else if (adobeSignError) {
      toast.error(adobeSignErrorCopy(adobeSignError));
    }

    if (driveResult || driveError || docusignResult || docusignError || adobeSignResult || adobeSignError) {
      const next = new URLSearchParams(searchParams);
      next.delete('drive');
      next.delete('drive_error');
      next.delete('docusign');
      next.delete('docusign_error');
      next.delete('adobe_sign');
      next.delete('adobe_sign_error');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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

  const handleInvite = useCallback(async (email: string, role: 'INDIVIDUAL' | 'ORG_ADMIN'): Promise<boolean> => {
    if (!orgId) return false;
    // useInviteMember never rethrows (SCRUM-1979 toast-safety) — the boolean
    // is the only failure signal. Propagate it so InviteMemberModal can stay
    // open and show its inline Alert on failure (SCRUM-3524).
    const invited = await inviteMember({
      email,
      role,
      orgId,
      orgName: organization?.display_name ?? 'Your Organization',
      inviterName: profile?.full_name ?? undefined,
    });
    if (invited) {
      await refreshInvitations();
    }
    return invited;
  }, [inviteMember, orgId, organization?.display_name, profile?.full_name, refreshInvitations]);

  // Resend = a fresh invite_member RPC call + a fresh /api/send-invitation-email
  // send (same path as the original Invite Member action) rather than
  // re-emailing the old token: the old invitation's expires_at never moves,
  // so re-sending the SAME link would still read as expired the moment the
  // invitee clicks it. Refreshing the list afterward picks up the new
  // pending row created by the RPC alongside the stale one it doesn't touch.
  const handleResendInvitation = useCallback(async (invitation: OrgInvitation) => {
    if (!orgId) return;
    const invited = await inviteMember({
      email: invitation.email,
      // invite_member deliberately rejects ORG_ADMIN invitations. Resend the
      // replacement as an individual; an admin can promote after acceptance.
      role: 'INDIVIDUAL',
      orgId,
      orgName: organization?.display_name ?? 'Your Organization',
      inviterName: profile?.full_name ?? undefined,
    });
    if (invited) {
      await refreshInvitations();
    }
  }, [inviteMember, orgId, organization?.display_name, profile?.full_name, refreshInvitations]);

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
  if (!userRole && !isPlatformAdmin(profile)) {
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
                  <img src={orgLogoUrl} alt={organization?.display_name ? `${organization.display_name} organization logo` : 'Organization logo'} className="h-full w-full object-cover" loading="lazy" decoding="async" width={112} height={112} />
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
            <div className="flex flex-wrap justify-end gap-2 pb-2">
              {userRole && (
                <Badge variant="outline" className="text-xs h-8 px-3">
                  {userRole === 'owner' && <Crown className="mr-1.5 h-3.5 w-3.5" />}
                  {userRole === 'admin' && <ArkovaIcon className="mr-1.5 h-3.5 w-3.5" />}
                  {userRole === 'member' && <User className="mr-1.5 h-3.5 w-3.5" />}
                  {userRole.charAt(0).toUpperCase() + userRole.slice(1)}
                </Badge>
              )}
              <Button variant="outline" size="sm" onClick={() => navigate(ROUTES.RULES)}>
                <ScrollText className="mr-2 h-4 w-4" />
                Rules
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate(ROUTES.ANCHOR_QUEUE)}>
                <ListChecks className="mr-2 h-4 w-4" />
                Queue
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => navigate(ROUTES.ANCHOR_QUEUE)}
                aria-label="Open queue notifications"
                className="relative"
              >
                <Bell className="h-4 w-4" />
                {unreadNotifications > 0 && (
                  <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                    {unreadNotifications > 99 ? '99+' : unreadNotifications}
                  </span>
                )}
              </Button>
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
            {orgFoundedDisplay && (
              <span className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                {ORG_PAGE_LABELS.FOUNDED} {orgFoundedDisplay}
              </span>
            )}
          </div>

          {/* Stats row — LinkedIn-style follower/connection counts */}
          <div className="flex items-center gap-6 mt-4 pb-4 text-sm">
            <span className="text-muted-foreground">
              <strong className="text-foreground font-semibold">{(recordsCount ?? 0).toLocaleString()}</strong> records
            </span>
            <span className="text-muted-foreground">
              <strong className="text-foreground font-semibold">{members.length}</strong> {members.length === 1 ? 'member' : 'members'}
            </span>
          </div>
        </CardContent>

        {/* Tabs integrated into the card bottom — like LinkedIn */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          {/*
            Four tabs no longer fit one 375 px row at the old padding, so the
            row scrolls horizontally and the labels never wrap. Founder
            feedback 2026-09-13 added Affiliates here: the panel it opens used
            to be reachable only from the bottom of Settings.
          */}
          <div className="border-t border-border/50 px-4 md:px-6 overflow-x-auto">
            <TabsList className="h-auto bg-transparent p-0 gap-0">
              <TabsTrigger value="home" className={TAB_TRIGGER_CLASS}>
                Home
              </TabsTrigger>
              <TabsTrigger value="people" className={TAB_TRIGGER_CLASS}>
                People
              </TabsTrigger>
              {isAdmin && (
                <TabsTrigger value="affiliates" className={TAB_TRIGGER_CLASS}>
                  {SUB_ORG_LABELS.TAB_LABEL}
                  {/*
                    The queue is visible from the tab row itself. Rendered only
                    for a known, non-zero count: `subOrgCounts === null` means
                    the list has not loaded or failed to load, and a "0" there
                    would claim there is nothing waiting when we do not know.
                  */}
                  {subOrgCounts !== null && subOrgCounts.pending > 0 && (
                    <span
                      aria-label={`${subOrgCounts.pending} ${SUB_ORG_LABELS.TAB_PENDING_BADGE_LABEL}`}
                      className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 text-xs font-semibold text-amber-400"
                    >
                      {subOrgCounts.pending}
                    </span>
                  )}
                </TabsTrigger>
              )}
              {isAdmin && (
                <TabsTrigger value="settings" className={TAB_TRIGGER_CLASS}>
                  Settings
                </TabsTrigger>
              )}
            </TabsList>
          </div>

        {/* Home Tab — About + Records (like LinkedIn posts feed) */}
        <TabsContent value="home" className="p-4 md:p-6">
          {/* About section — shown when org has a description */}
          {orgDescription && (
            <div className="mb-6 rounded-lg border bg-card p-4">
              <h2 className="text-sm font-semibold text-muted-foreground mb-2">{ORG_PAGE_LABELS.ABOUT}</h2>
              <p className="text-sm leading-relaxed whitespace-pre-line">{orgDescription}</p>
            </div>
          )}

          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Records</h2>
            {isAdmin && (
              <div className="flex gap-2">
                {/* SCRUM-1755 — single Secure Document button. Auto-detects bulk
                    (multiple files OR a CSV/XLSX) inside SecureDocumentDialog;
                    no separate "Bulk Upload" chooser. */}
                <Button size="sm" onClick={() => setSecureDialogOpen(true)} className="bg-[#00d4ff] text-[#0a0f14] hover:bg-[#00a3cc]">
                  <Plus className="mr-2 h-4 w-4 shrink-0" />
                  <span className="hidden sm:inline">{ORG_PAGE_LABELS.SECURE_DOCUMENT}</span>
                  <span className="sm:hidden">{ORG_PAGE_LABELS.SECURE_DOCUMENT_MOBILE}</span>
                </Button>
                {/* SCRUM-1755 — Issue Credential is a distinct, gated action. Pre-flag
                    behavior preserved for any admin (legacy). Post-flag (or while the
                    flag fetch is in flight — fail-closed), only verified orgs (and
                    APPROVED sub-orgs of verified parents) see this button. */}
                {showIssueButton && (
                  <Button size="sm" variant="outline" onClick={() => setIssueDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4 shrink-0" />
                    <span className="hidden sm:inline">{ORG_PAGE_LABELS.ISSUE_CREDENTIAL}</span>
                    <span className="sm:hidden">{ORG_PAGE_LABELS.ISSUE_CREDENTIAL_MOBILE}</span>
                  </Button>
                )}
              </div>
            )}
          </div>
          {/* SCRUM-3010 STEP 1 (frontend gate): the org-wide registry + its CSV
              export are admin-only. A non-admin member is scoped to their OWN
              rows (by user_id) so a coworker's records never leak. RLS tightening
              is deferred to STEP 2 (T3), post-soak. */}
          <OrgRegistryTable
            key={refreshKey}
            orgId={orgId}
            isAdmin={isAdmin}
            currentUserId={user?.id}
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
          {isAdmin && (
            invitationsError ? (
              <Alert variant="destructive" className="mt-6">
                <AlertTitle>{PENDING_INVITATIONS_LABELS.SECTION_TITLE}</AlertTitle>
                <AlertDescription>{PENDING_INVITATIONS_LABELS.LOAD_FAILED}</AlertDescription>
              </Alert>
            ) : (
              <PendingInvitationsList
                invitations={pendingInvitations}
                loading={invitationsLoading}
                onResend={handleResendInvitation}
              />
            )
          )}
        </TabsContent>

        {/* Settings Tab (admin only) */}

        {/*
          Affiliates tab (founder feedback 2026-09-13). This whole block used
          to be the last thing inside the Settings tab, below fifteen profile
          fields, the verification card and four connector cards: 2,396 px of
          scrolling at 1280 px and 2,996 px at 375 px before its heading
          appeared (docs/uat/suborg-ux/discoverability-*.json). Nothing about
          the markup changed except where it lives, what the revoked child is
          offered, and that the panel now reports its counts upward for the
          tab badge.
        */}
        {isAdmin && (
          <TabsContent value="affiliates" className="p-4 md:p-6">
            <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
              <Link2 className="h-5 w-5" />
              {SUB_ORG_LABELS.SECTION_TITLE}
            </h3>

            {/* Child org view: show parent affiliation status */}
            {isChildOrg && (
              <div className="mb-6 p-4 rounded-lg border border-border/50 bg-card">
                {parentApprovalStatus === 'APPROVED' && (
                  <div className="flex flex-wrap items-center gap-3">
                    <AffiliatedBadge parentName={parentOrgDisplayName} />
                    <span className="text-sm text-muted-foreground">
                      {SUB_ORG_LABELS.AFFILIATED_WITH} <strong className="text-foreground">{parentOrgDisplayName}</strong>
                    </span>
                  </div>
                )}
                {parentApprovalStatus === 'PENDING' && (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-3">
                        <Badge variant="outline" className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-xs">
                          {SUB_ORG_LABELS.STATUS_PENDING}
                        </Badge>
                        <span className="text-sm text-muted-foreground">
                          {SUB_ORG_LABELS.PENDING_APPROVAL} <strong className="text-foreground">{parentOrgDisplayName}</strong>
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">{SUB_ORG_LABELS.PENDING_EXPLAINER}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-400 border-red-500/20 hover:bg-red-500/10 sm:shrink-0"
                      onClick={async () => {
                        // Every failure path here used to be silent: the toast
                        // fired only on `response.ok` and the catch was empty,
                        // so a 500, a 403 or a dropped connection left the
                        // button looking inert with the request still pending.
                        // Same shape as the panel's own handlers — worker codes
                        // through translateWorkerError, generic fallback for
                        // anything unrecognised or thrown.
                        try {
                          const { data: { session } } = await supabase.auth.getSession();
                          if (!session?.access_token) throw new Error('Not authenticated');
                          const response = await fetch(`${WORKER_URL}/api/v1/org/sub-orgs/cancel`, {
                            method: 'POST',
                            headers: {
                              'Content-Type': 'application/json',
                              'Authorization': `Bearer ${session.access_token}`,
                            },
                          });
                          if (!response.ok) {
                            // A 5xx can answer with an HTML error page, so a
                            // body that will not parse must still reach the
                            // user as the generic failure rather than as a
                            // throw indistinguishable from a network drop.
                            const data = await response.json().catch(() => ({})) as { error?: string };
                            toast.error(translateWorkerError(data.error, SUB_ORG_LABELS.CANCEL_FAILED));
                            return;
                          }
                          toast.success(SUB_ORG_LABELS.CANCEL_SUCCESS);
                          window.location.reload();
                        } catch {
                          toast.error(SUB_ORG_LABELS.CANCEL_FAILED);
                        }
                      }}
                    >
                      {SUB_ORG_LABELS.CANCEL_REQUEST}
                    </Button>
                  </div>
                )}
                {parentApprovalStatus === 'REVOKED' && (
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/20 text-xs">
                        {SUB_ORG_LABELS.STATUS_REVOKED}
                      </Badge>
                      <span className="text-sm text-muted-foreground">
                        {SUB_ORG_LABELS.REVOKED_BY} <strong className="text-foreground">{parentOrgDisplayName}</strong>
                      </span>
                    </div>
                    {/* Said nothing about what being revoked means for them. */}
                    <p className="text-sm text-muted-foreground">{SUB_ORG_LABELS.REVOKED_EXPLAINER}</p>
                  </div>
                )}
              </div>
            )}

            {/*
              Request affiliation. The condition used to be `!isChildOrg`
              alone, but a revoked child KEEPS its `parent_org_id`, so the one
              organization that most needs this control was the one that could
              not see it — a dead end with no way back
              (docs/uat/suborg-ux/step11-revoked-child-dead-end-1280.png). The
              comment on the original markup already said "for non-child orgs
              or revoked"; the code did not.
            */}
            {(!isChildOrg || parentApprovalStatus === 'REVOKED') && (
              <div className="mb-6">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAffiliationDialogOpen(true)}
                >
                  <Link2 className="mr-2 h-4 w-4" />
                  {parentApprovalStatus === 'REVOKED'
                    ? SUB_ORG_LABELS.REQUEST_AGAIN
                    : SUB_ORG_LABELS.REQUEST_AFFILIATION}
                </Button>
              </div>
            )}

            {/* Parent org view: manage sub-orgs (only for verified orgs or orgs with existing sub-orgs) */}
            {(isVerifiedOrg || !isChildOrg) && orgId && (
              <ManageSubOrgs
                key={subOrgRefreshKey}
                orgId={orgId}
                onCountsChange={setSubOrgCounts}
              />
            )}
          </TabsContent>
        )}
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
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-type">Organization Type</Label>
                <select
                  id="org-type"
                  value={orgType}
                  onChange={(e) => { setOrgType(e.target.value); setOrgSaved(false); }}
                  disabled={orgUpdating}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
                  <Label htmlFor="org-twitter">X / Twitter</Label>
                  <Input
                    id="org-twitter"
                    value={orgTwitterUrl}
                    onChange={(e) => { setOrgTwitterUrl(e.target.value); setOrgSaved(false); }}
                    placeholder="https://x.com/..."
                    disabled={orgUpdating}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                <div className="space-y-2">
                  <Label htmlFor="org-industry">Industry</Label>
                  <select
                    id="org-industry"
                    value={orgIndustryTag}
                    onChange={(e) => { setOrgIndustryTag(e.target.value); setOrgSaved(false); }}
                    disabled={orgUpdating}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">Select industry...</option>
                    {INDUSTRY_TAG_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
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
                    twitter_url: orgTwitterUrl.trim() || undefined,
                    industry_tag: orgIndustryTag || undefined,
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

              <div className="mt-8">
                <DriveConnectorCard orgId={orgId} />
              </div>

              <div className="mt-8">
                <DocusignConnectorCard orgId={orgId} />
              </div>

              <div className="mt-8">
                <AdobeSignConnectorCard orgId={orgId} />
              </div>

              <div className="mt-8">
                <MemberDocusignConnectorCard orgId={orgId} />
              </div>
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
        orgId={orgId}
        role={issueCredentialRole}
        profileLoading={profileLoading || roleLoading}
      />

      {/* SCRUM-1755 — universal Secure Document dialog. Bulk auto-detected. */}
      <SecureDocumentDialog
        open={secureDialogOpen}
        onOpenChange={(open) => {
          setSecureDialogOpen(open);
          if (!open) setRefreshKey((k) => k + 1);
        }}
        onSuccess={() => setRefreshKey((k) => k + 1)}
        orgId={orgId ?? null}
      />

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
          useAdminEndpoints={isForeignOrgAdmin}
          onMemberAdded={() => {
            setRefreshKey((k) => k + 1);
            void refreshMembers();
          }}
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
