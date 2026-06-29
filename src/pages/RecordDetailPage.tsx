/**
 * Record Detail Page
 *
 * Renders AssetDetailView for a single anchor record.
 * Extracts the record ID from the URL via react-router-dom useParams.
 *
 * @see P4-TS-03 — Wire AssetDetailView to /records/:id route + real Supabase query
 */

import { useEffect, useState } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchor } from '@/hooks/useAnchor';
import { useHasCredentialImportEntitlement } from '@/hooks/useHasCredentialImportEntitlement';
import { supabase } from '@/lib/supabase';
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
  const { anchor, loading: anchorLoading, error, refreshAnchor } = useAnchor(id);
  // CPE-R1 (SCRUM-1847): the credential-detail CPE section is gated on the
  // `credential_source_import` entitlement, resolved read-only here (page-level
  // concern, mirroring how `canRevoke` is computed at the page). Fails closed.
  // NOTE: this gate is intentionally inert until the CSI track (SCRUM-1611)
  // ships a writer for the `credential_source_import` entitlement_type — nothing
  // writes that row today, so the hook returns false for everyone and the CPE
  // section stays hidden. See useHasCredentialImportEntitlement for the
  // org-wide grant semantics.
  const hasImportEntitlement = useHasCredentialImportEntitlement();

  // Fetch version lineage when anchor has parent or version > 1
  const [lineage, setLineage] = useState<{ id: string; versionNumber: number; status: string; createdAt: string; filename: string }[]>([]);
  useEffect(() => {
    if (!anchor) return;
    const hasLineage = anchor.version_number > 1 || anchor.parent_anchor_id;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear lineage when anchor has no version history
    if (!hasLineage) { setLineage([]); return; }

    // Walk up to find root, then fetch all descendants
    async function fetchLineage() {
      // Find root: walk parent chain up
      let rootId = anchor!.id;
      let parentId = anchor!.parent_anchor_id;
      const visited = new Set<string>([rootId]);

      while (parentId) {
        if (visited.has(parentId)) break;
        visited.add(parentId);
        const { data: parent } = await supabase
          .from('anchors')
          .select('id, parent_anchor_id')
          .eq('id', parentId)
          .is('deleted_at', null)
          .single();
        if (!parent) break;
        rootId = parent.id;
        parentId = parent.parent_anchor_id;
      }

      // Now collect all versions: root + descendants via parent_anchor_id chain
      const versions: { id: string; versionNumber: number; status: string; createdAt: string; filename: string }[] = [];

      // Fetch root
      const { data: root } = await supabase
        .from('anchors')
        .select('id, version_number, status, created_at, filename')
        .eq('id', rootId)
        .is('deleted_at', null)
        .single();
      if (root) {
        versions.push({ id: root.id, versionNumber: root.version_number, status: root.status, createdAt: root.created_at, filename: root.filename });
      }

      // Fetch children iteratively
      let currentParent = rootId;
      for (let i = 0; i < 50; i++) { // safety limit
        const { data: children } = await supabase
          .from('anchors')
          .select('id, version_number, status, created_at, filename')
          .eq('parent_anchor_id', currentParent)
          .is('deleted_at', null)
          .order('version_number', { ascending: true })
          .limit(1);
        if (!children || children.length === 0) break;
        const child = children[0];
        versions.push({ id: child.id, versionNumber: child.version_number, status: child.status, createdAt: child.created_at, filename: child.filename });
        currentParent = child.id;
      }

      setLineage(versions);
    }
    fetchLineage();
  }, [anchor]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleBack = () => {
    navigate(-1);
  };

  const handleRenameFile = async (newName: string) => {
    if (!anchor) return;
    const { error: updateError } = await supabase
      .from('anchors')
      .update({ filename: newName })
      .eq('id', anchor.id);
    if (updateError) {
      toast.error('Failed to rename document');
      throw updateError;
    }
    toast.success('Document renamed');
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
              <ArkovaIcon className="mr-2 h-4 w-4" />
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
        canRevoke={profile?.role === 'ORG_ADMIN' && anchor.org_id === profile?.org_id}
        onRevoked={() => { void refreshAnchor(); }}
        hasImportEntitlement={hasImportEntitlement}
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
          // CPE-R1 (SCRUM-1847): pass the structured CPE blob through so
          // AssetDetailView can render the (entitlement-gated) CPE section.
          // `cpe_metadata` is selected by useAnchor (select('*')).
          cpeMetadata: anchor.cpe_metadata as Record<string, unknown> | null ?? undefined,
          description: anchor.description ?? undefined,
          orgId: anchor.org_id ?? undefined,
          issuerName: (() => {
            const meta = anchor.metadata as Record<string, unknown> | null;
            const rawIssuer = meta?.issuer as string | undefined;
            // Pipeline records (public entities) — show issuer as-is
            if (meta?.pipeline_source) return rawIssuer;
            // Org-issued credentials — issuer is the org name (safe)
            if (anchor.org_id) return rawIssuer;
            // Individual uploads — anonymize to prevent PII leakage (SOC 2 / Privacy by Design)
            if (rawIssuer && anchor.public_id) return `ID: ${anchor.public_id.slice(0, 12)}`;
            return undefined;
          })(),
          versionNumber: anchor.version_number,
          parentAnchorId: anchor.parent_anchor_id ?? undefined,
          lineage: lineage.length > 1 ? lineage : undefined,
        }}
        onBack={handleBack}
        onRenameFile={handleRenameFile}
        onDownloadProof={async () => {
          try {
            // PROOF-04 (SCRUM-2337): embed the full machine-readable proof
            // packet so the certificate can be re-verified offline. The
            // packet fields live in `anchor_proofs`; fetch them for SECURED
            // records (RLS scopes the row to the viewer). Non-SECURED records
            // simply get the legacy certificate with no proof packet.
            let proof: import('@/lib/generateAuditReport').ProofInput | undefined;
            if (anchor.status === 'SECURED') {
              const { data: proofRow } = await supabase
                .from('anchor_proofs')
                .select(
                  'merkle_root, proof_path, merkle_index, block_hash, block_header, block_height, op_return_payload, proof_schema_version, block_timestamp, receipt_id',
                )
                .eq('anchor_id', anchor.id)
                .maybeSingle();
              if (proofRow) {
                const path = Array.isArray(proofRow.proof_path)
                  ? (proofRow.proof_path as unknown[]).filter((s): s is string => typeof s === 'string')
                  : null;
                proof = {
                  fingerprint: anchor.fingerprint,
                  merkle_root: proofRow.merkle_root,
                  merkle_proof: path,
                  merkle_index: proofRow.merkle_index,
                  tx_id: anchor.chain_tx_id ?? proofRow.receipt_id ?? null,
                  block_height: proofRow.block_height ?? anchor.chain_block_height ?? null,
                  block_hash: proofRow.block_hash,
                  block_header: proofRow.block_header,
                  op_return_payload: proofRow.op_return_payload,
                  proof_schema_version: proofRow.proof_schema_version,
                  observed_time: proofRow.block_timestamp ?? anchor.chain_timestamp ?? null,
                };
              }
            }
            const { generateAuditReport } = await import('@/lib/generateAuditReport');
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
              proof,
            });
          } catch {
            toast.error('Failed to generate proof certificate. Please try again.');
          }
        }}
        onDownloadProofJson={async () => {
          try {
            const { generateProofPackage, downloadProofPackage, getProofPackageFilename } = await import('@/lib/proofPackage');
            const proofPackage = generateProofPackage({
              id: anchor.id,
              fingerprint: anchor.fingerprint ?? '',
              filename: anchor.filename,
              file_size: anchor.file_size,
              file_mime: anchor.file_mime,
              status: anchor.status as 'PENDING' | 'SUBMITTED' | 'SECURED' | 'REVOKED' | 'EXPIRED',
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
          } catch {
            toast.error('Failed to generate proof package. Please try again.');
          }
        }}
      />
    </AppShell>
  );
}
