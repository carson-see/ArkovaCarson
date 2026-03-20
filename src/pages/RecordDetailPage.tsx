/**
 * Record Detail Page
 *
 * Renders AssetDetailView for a single anchor record.
 * Extracts the record ID from the URL via react-router-dom useParams.
 *
 * @see P4-TS-03 — Wire AssetDetailView to /records/:id route + real Supabase query
 */

import { useParams, useNavigate } from 'react-router-dom';
import { Loader2, AlertCircle, Shield } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchor } from '@/hooks/useAnchor';
import { AppShell } from '@/components/layout';
import { AssetDetailView } from '@/components/anchor';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ROUTES } from '@/lib/routes';

export function RecordDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { anchor, loading: anchorLoading, error } = useAnchor(id);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleBack = () => {
    navigate(-1);
  };

  if (anchorLoading) {
    return (
      <AppShell
        user={user}
        profile={profile}
        profileLoading={profileLoading}
        onSignOut={handleSignOut}
      >
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </AppShell>
    );
  }

  if (error || !anchor) {
    return (
      <AppShell
        user={user}
        profile={profile}
        profileLoading={profileLoading}
        onSignOut={handleSignOut}
      >
        <Card className="max-w-md mx-auto mt-12">
          <CardContent className="flex flex-col items-center py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 mb-4">
              <AlertCircle className="h-7 w-7 text-destructive" />
            </div>
            <h2 className="text-lg font-semibold mb-1">Record Not Found</h2>
            <p className="text-sm text-muted-foreground mb-6">
              {error || 'The requested record does not exist or you do not have permission to view it.'}
            </p>
            <Button onClick={() => navigate(ROUTES.DASHBOARD)}>
              <Shield className="mr-2 h-4 w-4" />
              Back to Dashboard
            </Button>
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <AssetDetailView
        anchor={{
          id: anchor.id,
          publicId: anchor.public_id ?? undefined,
          filename: anchor.filename,
          fingerprint: anchor.fingerprint,
          status: anchor.status,
          createdAt: anchor.created_at,
          securedAt: anchor.chain_timestamp ?? undefined,
          issuedAt: anchor.issued_at ?? undefined,
          revokedAt: anchor.revoked_at ?? undefined,
          revocationReason: anchor.revocation_reason ?? undefined,
          expiresAt: anchor.expires_at ?? undefined,
          fileSize: anchor.file_size ?? 0,
          fileMime: anchor.file_mime ?? undefined,
          credentialType: anchor.credential_type ?? undefined,
          chainTxId: anchor.chain_tx_id ?? undefined,
          chainBlockHeight: anchor.chain_block_height ?? undefined,
          metadata: anchor.metadata as Record<string, unknown> | null ?? undefined,
          description: anchor.description ?? undefined,
          orgId: anchor.org_id ?? undefined,
          issuerName: (anchor.metadata as Record<string, unknown> | null)?.issuer as string | undefined,
        }}
        onBack={handleBack}
        onDownloadProof={() => {
          import('@/lib/generateAuditReport').then(({ generateAuditReport }) => {
            generateAuditReport({
              publicId: anchor.public_id ?? anchor.id,
              filename: anchor.filename,
              fingerprint: anchor.fingerprint,
              status: anchor.status,
              fileSize: anchor.file_size ?? undefined,
              credentialType: anchor.credential_type ?? undefined,
              createdAt: anchor.created_at,
              issuedAt: anchor.issued_at ?? undefined,
              securedAt: anchor.chain_timestamp ?? undefined,
              revokedAt: anchor.revoked_at ?? undefined,
              revocationReason: anchor.revocation_reason ?? undefined,
              expiresAt: anchor.expires_at ?? undefined,
              networkReceipt: anchor.chain_tx_id ?? undefined,
              blockHeight: anchor.chain_block_height ?? undefined,
            });
          });
        }}
        onDownloadProofJson={() => {
          import('@/lib/proofPackage').then(({ generateProofPackage, downloadProofPackage, getProofPackageFilename }) => {
            const proofPackage = generateProofPackage({
              id: anchor.id,
              fingerprint: anchor.fingerprint,
              filename: anchor.filename,
              file_size: anchor.file_size,
              file_mime: anchor.file_mime,
              status: anchor.status as 'PENDING' | 'SECURED' | 'REVOKED',
              public_id: anchor.public_id,
              chain_tx_id: anchor.chain_tx_id,
              chain_block_height: anchor.chain_block_height,
              chain_timestamp: anchor.chain_timestamp,
              created_at: anchor.created_at,
              user_id: anchor.user_id,
              org_id: anchor.org_id,
            });
            const filename = getProofPackageFilename({
              filename: anchor.filename,
              public_id: anchor.public_id,
            });
            downloadProofPackage(proofPackage, filename);
          });
        }}
      />
    </AppShell>
  );
}
