/**
 * Settings Page
 *
 * User account settings: profile info and privacy toggle.
 *
 * @see P3-TS-03
 */

import { useState, useCallback } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Link } from 'react-router-dom';
import { Settings, User, Eye, EyeOff, Loader2, Check, Copy, Fingerprint, Key, Webhook, FileText, ChevronRight, Trash2, Globe, Gift, Bot, Camera } from 'lucide-react';
import { LinkedinIcon as Linkedin, GithubIcon as Github, TwitterIcon as Twitter } from '@/components/shared/SocialIcons';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { SETTINGS_PAGE_LABELS, PROFILE_MEDIA_LABELS } from '@/lib/copy';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/routes';
import { NAV_LABELS, USER_ROLE_LABELS, IDENTITY_LABELS, NAV_POLISH_LABELS, SHARE_LABELS, ACCOUNT_DELETE_LABELS, PROFILE_LABELS, DATA_CORRECTION_LABELS } from '@/lib/copy';
import { DeleteAccountDialog } from '@/components/auth/DeleteAccountDialog';
import { ExportDataButton } from '@/components/auth/ExportDataButton';
import { DataCorrectionForm } from '@/components/auth/DataCorrectionForm';
import { TwoFactorSetup } from '@/components/auth/TwoFactorSetup';
import { IdentityVerification } from '@/components/auth/IdentityVerification';
import { UserVerifiedBadge } from '@/components/shared/VerifiedBadge';
import { parseSocialLinksForWrite, pickSocialLinks } from '@/lib/socialLinks';
import { ProfileMediaImage } from '@/components/shared/ProfileMediaImage';
import { useProfileMediaUpload, type ProfileMediaKind } from '@/hooks/useProfileMediaUpload';
import { sessionHasAal2 } from '@/lib/mfaSessionKey';

export function SettingsPage() {
  const { user, session, signOut } = useAuth();
  const { profile, loading: profileLoading, updating, updateProfile, refreshProfile } = useProfile();

  const [fullName, setFullName] = useState('');
  const [bio, setBio] = useState('');
  const [socialLinks, setSocialLinks] = useState<{ linkedin?: string; twitter?: string; github?: string; website?: string }>({});
  const [nameInitialized, setNameInitialized] = useState(false);
  const [saved, setSaved] = useState(false);
  const [bioSaved, setBioSaved] = useState(false);
  const [socialSaved, setSocialSaved] = useState(false);
  const [socialError, setSocialError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initialize fields once profile loads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const profileAny = profile as any;
  if (profile && !nameInitialized) {
    setFullName(profile.full_name ?? '');
    setBio(profileAny?.bio ?? '');
    // Legacy keys outside the four we render are dropped here so they can
    // never block a save (the write schema strips them too).
    setSocialLinks(pickSocialLinks(profileAny?.social_links));
    setNameInitialized(true);
  }

  const handleSignOut = signOut;

  const handleSaveName = useCallback(async () => {
    const trimmed = fullName.trim();
    if (!trimmed) return;
    setError(null);

    const success = await updateProfile({ full_name: trimmed });
    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } else {
      setError('Failed to update profile');
    }
  }, [fullName, updateProfile]);

  const handleCopy = useCallback(async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    toast.success(SHARE_LABELS.COPIED_TOAST);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const handleSaveBio = useCallback(async () => {
    setError(null);
    const success = await updateProfile({ bio: bio.trim() || null } );
    if (success) {
      setBioSaved(true);
      setTimeout(() => setBioSaved(false), 2000);
    } else {
      setError('Failed to update bio');
    }
  }, [bio, updateProfile]);

  const handleSaveSocial = useCallback(async () => {
    setSocialError(null);
    // SCRUM-4989: Zod on the write path (Constitution §1.1) — anything that is
    // not an http(s) URL / @handle never reaches profiles.social_links. The
    // message renders inside THIS card: the page-level `error` Alert lives in
    // the profile card far above, where a rejection from this form is off
    // screen and the Save button just looks inert.
    const parsed = parseSocialLinksForWrite(socialLinks);
    if (!parsed.ok) {
      setSocialError(PROFILE_LABELS.socialLinks.invalid[parsed.key]);
      return;
    }
    const success = await updateProfile({ social_links: parsed.value } );
    if (success) {
      setSocialSaved(true);
      setTimeout(() => setSocialSaved(false), 2000);
    } else {
      setSocialError('Failed to update social links');
    }
  }, [socialLinks, updateProfile]);

  const handleTogglePublicProfile = useCallback(async (checked: boolean) => {
    await updateProfile({ is_public_profile: checked });
  }, [updateProfile]);

  const mediaField = (kind: ProfileMediaKind) => kind === 'avatar' ? 'avatar_storage_path' as const : 'banner_storage_path' as const;
  const media = useProfileMediaUpload({
    scope: 'users',
    scopeId: profile?.public_id ?? null,
    ownerId: user?.id ?? null,
    previousPathFor: (kind) => profile?.[mediaField(kind)] ?? null,
    commit: useCallback((kind: ProfileMediaKind, path: string, previousPath: string | null) => {
      const field = kind === 'avatar' ? 'avatar_storage_path' as const : 'banner_storage_path' as const;
      return updateProfile({ [field]: path }, { field, expected: previousPath });
    }, [updateProfile]),
    successMessage: (kind) => kind === 'avatar' ? PROFILE_MEDIA_LABELS.PROFILE_PHOTO_UPDATED : PROFILE_MEDIA_LABELS.PROFILE_BANNER_UPDATED,
    // The storage write policy requires an AAL2 session; at AAL1 the input is
    // disabled rather than failing with an RLS rejection nobody can act on.
    canUpload: sessionHasAal2(session?.access_token ?? null, user?.id ?? null),
  });
  const mediaUploading = media.uploading;

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="mb-6">
        <h1 className="text-[24px] font-bold tracking-tight">
          {NAV_LABELS.SETTINGS}
        </h1>
        <p className="text-[13px] text-muted-foreground mt-1">
          Manage your account and privacy preferences
        </p>
      </div>

      <div className="space-y-6 max-w-2xl">
        {/* Profile Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Profile
              {profileAny?.identity_verification_status === 'verified' && (
                <UserVerifiedBadge />
              )}
            </CardTitle>
            <CardDescription>
              Your account information
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                value={user?.email ?? ''}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                Email is managed by your authentication provider
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="full-name">Full Name</Label>
              <div className="flex gap-2">
                <Input
                  id="full-name"
                  value={fullName}
                  onChange={(e) => {
                    setFullName(e.target.value);
                    setSaved(false);
                  }}
                  placeholder="Enter your full name"
                  disabled={updating}
                />
                <Button
                  onClick={handleSaveName}
                  disabled={updating || !fullName.trim() || fullName.trim() === (profile?.full_name ?? '')}
                  size="sm"
                  className="shrink-0"
                >
                  {updating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (saved ? (
                    <>
                      <Check className="mr-1 h-4 w-4" />
                      Saved
                    </>
                  ) : (
                    'Save'
                  ))}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Role</Label>
              <Input
                value={
                  profile?.role
                    ? USER_ROLE_LABELS[profile.role as keyof typeof USER_ROLE_LABELS] ?? profile.role
                    : 'Not set'
                }
                disabled
                className="bg-muted"
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Camera className="h-5 w-5" />{PROFILE_MEDIA_LABELS.SECTION_TITLE}</CardTitle>
            <CardDescription>{PROFILE_MEDIA_LABELS.SECTION_DESCRIPTION}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center gap-4">
              <ProfileMediaImage storagePath={profile?.avatar_storage_path} fallbackUrl={profile?.avatar_url} alt={PROFILE_MEDIA_LABELS.CURRENT_PROFILE} className="h-20 w-20 rounded-full object-cover" />
              <div className="flex-1 space-y-2"><Label htmlFor="profile-avatar">{PROFILE_MEDIA_LABELS.PROFILE_PHOTO}</Label><Input id="profile-avatar" type="file" accept="image/png,image/jpeg,image/webp" disabled={media.busy} onChange={(event) => { void media.onInputChange('avatar')(event); }} /></div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-banner">{PROFILE_MEDIA_LABELS.PROFILE_BANNER}</Label>
              <ProfileMediaImage storagePath={profile?.banner_storage_path} alt={PROFILE_MEDIA_LABELS.CURRENT_PROFILE_BANNER} className="h-28 w-full rounded-lg object-cover" />
              <Input id="profile-banner" type="file" accept="image/png,image/jpeg,image/webp" disabled={media.busy} onChange={(event) => { void media.onInputChange('banner')(event); }} />
            </div>
            {media.blocked && <p className="text-sm text-muted-foreground">{PROFILE_MEDIA_LABELS.MFA_REQUIRED}</p>}
            {mediaUploading && <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />{mediaUploading === 'avatar' ? PROFILE_MEDIA_LABELS.UPLOADING_PROFILE_PHOTO : PROFILE_MEDIA_LABELS.UPLOADING_PROFILE_BANNER}</p>}
          </CardContent>
        </Card>

        {/* Bio (IDT-02) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              {PROFILE_LABELS.bio.label}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={bio}
              onChange={(e) => {
                setBio(e.target.value.slice(0, 500));
                setBioSaved(false);
              }}
              placeholder={PROFILE_LABELS.bio.placeholder}
              rows={3}
              disabled={updating}
              className="resize-none"
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {bio.length}/500 {PROFILE_LABELS.bio.hint.toLowerCase().replace('up to 500 characters', '')}
              </p>
              <Button
                onClick={handleSaveBio}
                disabled={updating || bio === (profileAny?.bio ?? '')}
                size="sm"
              >
                {updating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : bioSaved ? (
                  <><Check className="mr-1 h-4 w-4" />Saved</>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Social Links (IDT-02) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              {PROFILE_LABELS.socialLinks.heading}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Linkedin className="h-4 w-4" />
                {PROFILE_LABELS.socialLinks.linkedin.label}
              </Label>
              <Input
                value={socialLinks.linkedin ?? ''}
                onChange={(e) => { setSocialLinks(prev => ({ ...prev, linkedin: e.target.value })); setSocialSaved(false); setSocialError(null); }}
                placeholder={PROFILE_LABELS.socialLinks.linkedin.placeholder}
                disabled={updating}
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Twitter className="h-4 w-4" />
                {PROFILE_LABELS.socialLinks.twitter.label}
              </Label>
              <Input
                value={socialLinks.twitter ?? ''}
                onChange={(e) => { setSocialLinks(prev => ({ ...prev, twitter: e.target.value })); setSocialSaved(false); setSocialError(null); }}
                placeholder={PROFILE_LABELS.socialLinks.twitter.placeholder}
                disabled={updating}
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Github className="h-4 w-4" />
                {PROFILE_LABELS.socialLinks.github.label}
              </Label>
              <Input
                value={socialLinks.github ?? ''}
                onChange={(e) => { setSocialLinks(prev => ({ ...prev, github: e.target.value })); setSocialSaved(false); setSocialError(null); }}
                placeholder={PROFILE_LABELS.socialLinks.github.placeholder}
                disabled={updating}
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {PROFILE_LABELS.socialLinks.website.label}
              </Label>
              <Input
                value={socialLinks.website ?? ''}
                onChange={(e) => { setSocialLinks(prev => ({ ...prev, website: e.target.value })); setSocialSaved(false); setSocialError(null); }}
                placeholder={PROFILE_LABELS.socialLinks.website.placeholder}
                disabled={updating}
              />
            </div>
            {socialError && (
              <Alert variant="destructive">
                <AlertDescription>{socialError}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-end">
              <Button
                onClick={handleSaveSocial}
                disabled={updating}
                size="sm"
              >
                {updating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : socialSaved ? (
                  <><Check className="mr-1 h-4 w-4" />Saved</>
                ) : (
                  'Save'
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Identity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Fingerprint className="h-5 w-5" />
              Identity
            </CardTitle>
            <CardDescription>
              {IDENTITY_LABELS.USER_ID_DESC}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {profile?.public_id && (
              <div className="space-y-2">
                <Label>{IDENTITY_LABELS.USER_ID}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs break-all">
                    {profile.public_id}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => handleCopy(profile.public_id!, 'userId')}
                  >
                    {copied === 'userId' ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}
            {profile?.org_id && (
              <div className="space-y-2">
                <Label>{IDENTITY_LABELS.ORG_ID}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs break-all">
                    {profile.org_id}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() => handleCopy(profile.org_id!, 'orgId')}
                  >
                    {copied === 'orgId' ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {IDENTITY_LABELS.ORG_ID_DESC}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Privacy Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArkovaIcon className="h-5 w-5" />
              Privacy
            </CardTitle>
            <CardDescription>
              Control who can see your profile
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {profile?.is_public_profile ? (
                  <Eye className="h-5 w-5 text-primary" />
                ) : (
                  <EyeOff className="h-5 w-5 text-muted-foreground" />
                )}
                <div>
                  <p className="text-sm font-medium">Public Profile</p>
                  <p className="text-xs text-muted-foreground max-w-md">
                    {profile?.is_public_profile
                      ? NAV_POLISH_LABELS.PUBLIC_PROFILE_DESC_ON
                      : NAV_POLISH_LABELS.PUBLIC_PROFILE_DESC_OFF}
                  </p>
                </div>
              </div>
              <Switch
                checked={profile?.is_public_profile ?? false}
                onCheckedChange={handleTogglePublicProfile}
                disabled={profileLoading || updating}
              />
            </div>
          </CardContent>
        </Card>

        {/* Identity Verification (IDT WS1) */}
        <IdentityVerification
          status={profileAny?.identity_verification_status ?? 'unstarted'}
          verifiedAt={profileAny?.identity_verified_at ?? null}
          onVerified={refreshProfile}
        />

        {/* Two-Factor Authentication */}
        <TwoFactorSetup />

        {/* Sub-page Navigation */}
        {profile?.role === 'ORG_ADMIN' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                {SETTINGS_PAGE_LABELS.ORG_TITLE}
              </CardTitle>
              <CardDescription>
                {SETTINGS_PAGE_LABELS.ORG_DESCRIPTION}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              <Link
                to={ROUTES.CREDENTIAL_TEMPLATES}
                className="flex items-center justify-between rounded-lg px-3 py-3 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{SETTINGS_PAGE_LABELS.CREDENTIAL_TEMPLATES}</p>
                    <p className="text-xs text-muted-foreground">{SETTINGS_PAGE_LABELS.CREDENTIAL_TEMPLATES_DESC}</p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
              <Link
                to={ROUTES.SETTINGS_WEBHOOKS}
                className="flex items-center justify-between rounded-lg px-3 py-3 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Webhook className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{SETTINGS_PAGE_LABELS.WEBHOOKS}</p>
                    <p className="text-xs text-muted-foreground">{SETTINGS_PAGE_LABELS.WEBHOOKS_DESC}</p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
              <Link
                to={ROUTES.SETTINGS_API_KEYS}
                className="flex items-center justify-between rounded-lg px-3 py-3 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Key className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{SETTINGS_PAGE_LABELS.API_KEYS}</p>
                    <p className="text-xs text-muted-foreground">{SETTINGS_PAGE_LABELS.API_KEYS_DESC}</p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
              {/* SPEC-AGENTS-UI — ComputeID / agent passport management. The
                  backend (services/worker/src/api/v1/agents.ts) shipped with
                  no reachable frontend; this is the only in-product link. */}
              <Link
                to={ROUTES.SETTINGS_AGENTS}
                className="flex items-center justify-between rounded-lg px-3 py-3 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Bot className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{SETTINGS_PAGE_LABELS.AGENTS}</p>
                    <p className="text-xs text-muted-foreground">{SETTINGS_PAGE_LABELS.AGENTS_DESC}</p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
              {/* SCRUM-5024 — partner referrals */}
              <Link
                to={ROUTES.SETTINGS_REFERRALS}
                className="flex items-center justify-between rounded-lg px-3 py-3 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Gift className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{SETTINGS_PAGE_LABELS.REFERRALS}</p>
                    <p className="text-xs text-muted-foreground">{SETTINGS_PAGE_LABELS.REFERRALS_DESC}</p>
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            </CardContent>
          </Card>
        )}

        <Separator />

        {/* Your Data Rights — REG-11 (SCRUM-572): GDPR Art. 15 + 20, Kenya DPA s. 31, APP 12, POPIA s. 23, NDPA */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Your data rights
            </CardTitle>
            <CardDescription>
              Download a machine-readable copy of everything Arkova stores about you. Includes your profile, credentials, and audit trail. Limited to one download per 24 hours.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ExportDataButton />
          </CardContent>
        </Card>

        {/* Data Correction — REG-19 / APP 13 (SCRUM-580) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {DATA_CORRECTION_LABELS.TITLE}
            </CardTitle>
            <CardDescription>
              {DATA_CORRECTION_LABELS.DESCRIPTION}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataCorrectionForm />
          </CardContent>
        </Card>

        <Separator />

        {/* Danger Zone */}
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              {ACCOUNT_DELETE_LABELS.DANGER_ZONE_TITLE}
            </CardTitle>
            <CardDescription>
              {ACCOUNT_DELETE_LABELS.DANGER_ZONE_DESCRIPTION}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{ACCOUNT_DELETE_LABELS.DELETE_BUTTON}</p>
                <p className="text-xs text-muted-foreground max-w-md">
                  {ACCOUNT_DELETE_LABELS.DANGER_ZONE_DETAIL}
                </p>
              </div>
              <DeleteAccountDialog userEmail={user?.email ?? ''} />
            </div>
          </CardContent>
        </Card>

        {/* Sign Out */}
        <div className="flex justify-end">
          <Button variant="outline" onClick={handleSignOut} className="text-destructive hover:text-destructive">
            {NAV_POLISH_LABELS.SIGN_OUT}
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
