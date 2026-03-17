/**
 * Settings Page
 *
 * User account settings: profile info and privacy toggle.
 *
 * @see P3-TS-03
 */

import { useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Settings, User, Shield, Eye, EyeOff, Loader2, Check, Copy, Fingerprint, Key, Webhook, FileText, ChevronRight, Trash2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { SETTINGS_PAGE_LABELS } from '@/lib/copy';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/routes';
import { NAV_LABELS, USER_ROLE_LABELS, IDENTITY_LABELS, NAV_POLISH_LABELS, SHARE_LABELS, ACCOUNT_DELETE_LABELS } from '@/lib/copy';
import { DeleteAccountDialog } from '@/components/auth/DeleteAccountDialog';

export function SettingsPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading, updating, updateProfile } = useProfile();

  const [fullName, setFullName] = useState('');
  const [nameInitialized, setNameInitialized] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initialize name field once profile loads
  if (profile && !nameInitialized) {
    setFullName(profile.full_name ?? '');
    setNameInitialized(true);
  }

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

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

  const handleTogglePublicProfile = useCallback(async (checked: boolean) => {
    await updateProfile({ is_public_profile: checked });
  }, [updateProfile]);

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Settings className="h-6 w-6 text-primary" />
          {NAV_LABELS.SETTINGS}
        </h1>
        <p className="text-muted-foreground mt-1">
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
              <Shield className="h-5 w-5" />
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
            </CardContent>
          </Card>
        )}

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
