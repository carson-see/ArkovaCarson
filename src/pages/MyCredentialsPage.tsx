/**
 * My Credentials Page
 *
 * Shows credentials issued TO the current user (recipient inbox).
 * Uses the get_my_credentials() RPC to fetch via anchor_recipients table.
 *
 * @see UF-03
 */

import { useNavigate } from 'react-router-dom';
import {
  Award,
  Building2,
  Calendar,
  ExternalLink,
  Loader2,
  Inbox,
  Plus,
} from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useMyCredentials, type ReceivedCredential } from '@/hooks/useMyCredentials';
import { AppShell } from '@/components/layout';
import { CredentialSourceImportDialog } from '@/components/credentials';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ROUTES, verifyPath } from '@/lib/routes';
import {
  MY_CREDENTIALS_LABELS,
  ANCHOR_STATUS_LABELS,
  CREDENTIAL_TYPE_LABELS,
} from '@/lib/copy';

const statusVariants: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  PENDING: 'outline',
  SECURED: 'default',
  REVOKED: 'secondary',
  EXPIRED: 'secondary',
};

function formatDate(dateString: string | null): string {
  if (!dateString) return '';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function CredentialCard({ credential }: Readonly<{ credential: ReceivedCredential }>) {
  const navigate = useNavigate();
  const statusLabel = ANCHOR_STATUS_LABELS[credential.status as keyof typeof ANCHOR_STATUS_LABELS] ?? credential.status;
  const typeLabel = credential.credentialType
    ? CREDENTIAL_TYPE_LABELS[credential.credentialType as keyof typeof CREDENTIAL_TYPE_LABELS] ?? credential.credentialType
    : null;

  return (
    <Card className="shadow-card-rest hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 shrink-0">
              <Award className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{credential.filename}</p>
              {typeLabel && (
                <p className="text-sm text-muted-foreground">{typeLabel}</p>
              )}
              {credential.orgName && (
                <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                  <Building2 className="h-3 w-3 shrink-0" />
                  <span>{MY_CREDENTIALS_LABELS.ISSUED_BY} {credential.orgName}</span>
                </div>
              )}
              {credential.createdAt && (
                <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3 shrink-0" />
                  <span>{MY_CREDENTIALS_LABELS.RECEIVED_ON} {formatDate(credential.createdAt)}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <Badge variant={statusVariants[credential.status] ?? 'outline'}>
              {statusLabel}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => navigate(verifyPath(credential.publicId))}
            >
              <ExternalLink className="mr-1 h-3 w-3" />
              {MY_CREDENTIALS_LABELS.VERIFY_CREDENTIAL}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function MyCredentialsPage() {
  const navigate = useNavigate();
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { credentials, loading, refreshCredentials } = useMyCredentials();

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Inbox className="h-6 w-6 text-primary" />
            {MY_CREDENTIALS_LABELS.PAGE_TITLE}
          </h1>
          <p className="text-muted-foreground mt-1">
            {MY_CREDENTIALS_LABELS.PAGE_SUBTITLE}
          </p>
        </div>
        <Button onClick={() => setImportDialogOpen(true)} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          {MY_CREDENTIALS_LABELS.ADD_SOURCE}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : credentials.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 px-4">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted mb-6">
              <Inbox className="h-10 w-10 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-center">
              {MY_CREDENTIALS_LABELS.EMPTY_TITLE}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground text-center max-w-sm">
              {MY_CREDENTIALS_LABELS.EMPTY_DESC}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {credentials.map((cred) => (
            <div key={cred.recipientId} className="animate-in-view">
              <CredentialCard credential={cred} />
            </div>
          ))}
        </div>
      )}

      <CredentialSourceImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onImported={refreshCredentials}
      />
    </AppShell>
  );
}
