/**
 * Dashboard Page
 *
 * Main authenticated view showing user's secured records.
 * Serves both INDIVIDUAL and ORG_ADMIN users.
 * Uses approved terminology per Constitution.
 *
 * @see P3-TS-01 — Wired to real Supabase queries via useAnchors hook
 */

import { useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, CheckCircle, Clock, Plus, Shield, Eye, EyeOff, Copy, Check } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchors } from '@/hooks/useAnchors';
import { useRevokeAnchor } from '@/hooks/useRevokeAnchor';
import { AppShell } from '@/components/layout';
import { StatCard, EmptyState } from '@/components/dashboard';
import { SecureDocumentDialog } from '@/components/anchor';
import { RecordsList, type Record } from '@/components/records';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ROUTES, recordDetailPath } from '@/lib/routes';
import { IDENTITY_LABELS } from '@/lib/copy';

export function DashboardPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading, updateProfile } = useProfile();
  const { records, loading: recordsLoading, refreshAnchors } = useAnchors();
  const { revokeAnchor, error: revokeError, clearError: clearRevokeError } = useRevokeAnchor();
  const [secureDialogOpen, setSecureDialogOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  const handleCopyId = useCallback(async () => {
    if (profile?.public_id) {
      await navigator.clipboard.writeText(profile.public_id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    }
  }, [profile?.public_id]);

  // Privacy toggle — reads from DB, persisted via updateProfile
  const isPublicProfile = useMemo(() => profile?.is_public_profile ?? false, [profile]);
  const handleTogglePublicProfile = useCallback(async (checked: boolean) => {
    await updateProfile({ is_public_profile: checked });
  }, [updateProfile]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleSecureSuccess = useCallback(async () => {
    await refreshAnchors();
  }, [refreshAnchors]);

  const handleViewRecord = useCallback((record: Record) => {
    navigate(recordDetailPath(record.id));
  }, [navigate]);

  const handleDownloadProof = useCallback((_record: Record) => {
    // Proof download is implemented in P7-TS-07
  }, []);

  const handleRevokeRecord = useCallback(async (record: Record) => {
    const success = await revokeAnchor(record.id);
    if (success) {
      await refreshAnchors();
    }
  }, [revokeAnchor, refreshAnchors]);

  const stats = {
    total: records.length,
    secured: records.filter(r => r.status === 'SECURED').length,
    pending: records.filter(r => r.status === 'PENDING').length,
  };

  const loading = profileLoading || recordsLoading;

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      {/* Welcome section — stagger 1 */}
      <div className="mb-10 animate-in-view stagger-1">
        <h1 className="text-heading-lg font-bold tracking-tight">
          Welcome back{profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}
        </h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Manage and verify your secured documents
        </p>
      </div>

      {/* Stats grid — stagger 2 */}
      <div className="grid gap-5 grid-cols-1 sm:grid-cols-3 mb-10 animate-in-view stagger-2">
        <StatCard
          label="Total Records"
          value={stats.total}
          icon={FileText}
          variant="primary"
          loading={loading}
        />
        <StatCard
          label="Secured"
          value={stats.secured}
          icon={CheckCircle}
          variant="success"
          loading={loading}
        />
        <StatCard
          label="Pending"
          value={stats.pending}
          icon={Clock}
          variant="warning"
          loading={loading}
        />
      </div>

      {/* Privacy toggle — stagger 3 */}
      <Card className="mb-10 shadow-card-rest animate-in-view stagger-3">
        <CardContent className="flex items-center justify-between py-5 px-6">
          {profileLoading ? (
            <div className="flex items-center gap-4 w-full">
              <Skeleton className="h-10 w-10 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/8">
                  {isPublicProfile ? (
                    <Eye className="h-5 w-5 text-primary" />
                  ) : (
                    <EyeOff className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-0.5">
                  <Label htmlFor="public-profile" className="text-sm font-semibold">
                    Public Verification Profile
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {isPublicProfile
                      ? 'Your records can be verified by anyone with the fingerprint'
                      : 'Only you can access your verification records'}
                  </p>
                </div>
              </div>
              <Switch
                id="public-profile"
                checked={isPublicProfile}
                onCheckedChange={handleTogglePublicProfile}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* Revoke error */}
      {revokeError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription className="flex items-center justify-between">
            <span>{revokeError}</span>
            <Button variant="ghost" size="sm" onClick={clearRevokeError}>Dismiss</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Records section — stagger 4 */}
      <Card className="shadow-card-rest animate-in-view stagger-4">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4 px-6">
          <div>
            <CardTitle className="text-lg font-semibold tracking-tight">My Records</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {stats.total > 0 ? `${stats.total} document${stats.total !== 1 ? 's' : ''} secured` : 'No documents yet'}
            </p>
          </div>
          <Button
            onClick={() => setSecureDialogOpen(true)}
            className="shadow-glow-sm hover:shadow-glow-md transition-all duration-300"
          >
            <Plus className="mr-2 h-4 w-4" />
            Secure Document
          </Button>
        </CardHeader>
        <Separator />
        <CardContent className="pt-0 px-6">
          {!loading && records.length === 0 ? (
            <EmptyState
              title="No records yet"
              description="Secure your first document to create a permanent, tamper-proof record. Your documents never leave your device."
              actionLabel="Secure Document"
              onAction={() => setSecureDialogOpen(true)}
            />
          ) : (
            <RecordsList
              records={records}
              loading={recordsLoading}
              onViewRecord={handleViewRecord}
              onDownloadProof={handleDownloadProof}
              onRevokeRecord={handleRevokeRecord}
            />
          )}
        </CardContent>
      </Card>

      {/* Account info — stagger 5 */}
      {profile && (
        <Card className="mt-6 shadow-card-rest animate-in-view stagger-5">
          <CardContent className="py-5 px-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
                  <Shield className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold">Account Type</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {profile.role === 'ORG_ADMIN' ? 'Organization Administrator' : 'Individual Account'}
                  </p>
                </div>
              </div>
              <Badge variant="secondary" className="text-xs font-medium">
                {profile.role === 'ORG_ADMIN' ? 'Org Admin' : 'Individual'}
              </Badge>
            </div>
            {profile.public_id && (
              <>
                <Separator />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{IDENTITY_LABELS.USER_ID}</p>
                    <p className="text-xs text-muted-foreground">{IDENTITY_LABELS.USER_ID_DESC}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono bg-muted/80 rounded-md px-2.5 py-1.5 text-muted-foreground">
                      {profile.public_id}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:bg-primary/10 transition-colors duration-200"
                      onClick={handleCopyId}
                    >
                      {copiedId ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="sr-only">Copy User ID</span>
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Secure Document Dialog */}
      <SecureDocumentDialog
        open={secureDialogOpen}
        onOpenChange={setSecureDialogOpen}
        onSuccess={handleSecureSuccess}
      />
    </AppShell>
  );
}
