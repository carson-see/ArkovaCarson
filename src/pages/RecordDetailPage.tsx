/**
 * Record Detail Page
 *
 * Renders AssetDetailView for a single anchor record.
 * Extracts the record ID from the URL via react-router-dom useParams.
 *
 * @see P4-TS-03 — Wire AssetDetailView to /records/:id route + real Supabase query
 */

import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAnchor } from '@/hooks/useAnchor';
import { useAnchorVersions } from '@/hooks/useAnchorVersions';
import { useHasCredentialImportEntitlement } from '@/hooks/useHasCredentialImportEntitlement';
import { supabase } from '@/lib/supabase';
import { AppShell } from '@/components/layout';
import { AssetDetailView } from '@/components/anchor';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ROUTES } from '@/lib/routes';
import { RECORD_DETAIL_LABELS } from '@/lib/copy';
import { sourceProofInput } from '@/lib/sourceProofInput';
import { ZodError } from 'zod';

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

  // Version lineage (readability pass, founder-reported 2026-09-29): this
  // used to be an ad-hoc effect gated on `version_number > 1 ||
  // parent_anchor_id`, which MISSED the oldest/root version of a chain once a
  // newer child had already superseded it — the exact founder-reported
  // record. `useAnchorVersions` always attempts the walk and returns the full
  // chain newest-first; AssetDetailView only shows a version banner/list when
  // it resolves to more than one entry. See src/hooks/useAnchorVersions.ts.
  const { versions } = useAnchorVersions(
    anchor ? { id: anchor.id, versionNumber: anchor.version_number, parentAnchorId: anchor.parent_anchor_id, status: anchor.status } : null,
  );
  const lineage = versions.length > 1 ? versions : undefined;

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleBack = () => {
    navigate(-1);
  };

  const handleRenameFile = async (newName: string) => {
    if (!anchor) return;
    // `.select('id')` + row-count check (mirrors useFolders.assignRecord):
    // PostgREST returns HTTP 204 with `error: null` for an UPDATE whose RLS
    // USING clause matches zero rows, so checking `error` alone let a
    // non-owner rename fire the success toast while the row was unchanged.
    // RLS reality: `anchors_update_own` requires user_id = auth.uid(), and
    // migration 0393's trigger `restrict_org_admin_folder_update` narrows the
    // org-admin update policy to folder_id only — that path raises 42501.
    const { data, error: updateError } = await supabase
      .from('anchors')
      .update({ filename: newName })
      .eq('id', anchor.id)
      .select('id');
    if (updateError) {
      toast.error(
        updateError.code === '42501'
          ? RECORD_DETAIL_LABELS.ERR_RENAME_FORBIDDEN
          : RECORD_DETAIL_LABELS.ERR_RENAME,
      );
      throw updateError;
    }
    if (!data || data.length === 0) {
      toast.error(RECORD_DETAIL_LABELS.ERR_RENAME_FORBIDDEN);
      throw new Error(RECORD_DETAIL_LABELS.ERR_RENAME_FORBIDDEN);
    }
    toast.success(RECORD_DETAIL_LABELS.TOAST_RENAMED);
    // Realtime usually catches the UPDATE, but refresh explicitly so the
    // certificate header reflects the confirmed new name immediately.
    void refreshAnchor();
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
        canRename={!!user && user.id === anchor.user_id}
        onRevoked={() => { void refreshAnchor(); }}
        hasImportEntitlement={hasImportEntitlement}
        anchor={{
          id: anchor.id,
          publicId: anchor.public_id ?? undefined,
          filename: anchor.filename,
          fingerprint: anchor.fingerprint,
          // SCRUM-3818 (docusign-bilateral-2026-08): R19 evidence class
          // (`fingerprint_source`, migration 0376) — selected by useAnchor's
          // `select('*')`. Gates the connector re-verify caveat's
          // DECLARED_UNVERIFIED variant in AssetDetailView.
          fingerprintSource: anchor.fingerprint_source ?? undefined,
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
          // CLE-R1 (SCRUM-1869): the analogous CLE blob. AssetDetailView has
          // declared and consumed `cleMetadata` since CLE-R1, but nothing fed
          // it here, so the CLE detail section rendered nothing for every
          // record. Same `select('*')` source and same entitlement gate as CPE
          // — keep the two lines together so neither is dropped alone.
          cleMetadata: anchor.cle_metadata as Record<string, unknown> | null ?? undefined,
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
          lineage,
        }}
        onBack={handleBack}
        onRenameFile={handleRenameFile}
        onDownloadProof={async () => {
          try {
            // PROOF-04 (SCRUM-2337): embed the full machine-readable proof
            // packet so the certificate can be re-verified offline. The
            // packet fields live in `anchor_proofs`; `sourceProofInput` fetches
            // them for SECURED records (RLS scopes the row to the viewer) AND
            // derives `leaf_count` — the field that arms the CVE-2012-2459 guard
            // — the same way the server does (count the anchor_proofs rows
            // sharing this proof's batch_id, head:true → a number, no PII).
            // Non-SECURED records get the legacy certificate with no packet.
            const { proof, complete } = await sourceProofInput(supabase, {
              id: anchor.id,
              fingerprint: anchor.fingerprint,
              status: anchor.status,
              chain_tx_id: anchor.chain_tx_id ?? null,
              chain_block_height: anchor.chain_block_height ?? null,
              chain_block_hash: anchor.chain_block_hash ?? null,
              chain_timestamp: anchor.chain_timestamp ?? null,
            });
            // If a packet exists but `leaf_count` could not be sourced (a batch
            // member whose batch count failed), DO NOT present it as a complete
            // offline proof: the certificate marks the packet incomplete and we
            // warn the user. `complete` is true for single-leaf records and
            // fully-counted batches.
            if (proof && !complete) {
              toast.warning(
                'This certificate embeds the proof for inspection, but one field needed to run every offline check could not be loaded. Try again in a moment for a complete proof.',
              );
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
              blockHash: anchor.chain_block_hash ?? undefined,
              proof,
              proofComplete: complete,
            });
          } catch {
            toast.error('Failed to generate proof certificate. Please try again.');
          }
        }}
        onDownloadProofJson={async () => {
          try {
            // PROOF-06: the JSON export embeds the SAME canonical proof packet
            // the PDF certificate does (PROOF-04 above). Before this, it called
            // generateProofPackage with no proof argument, so `proof` was ALWAYS
            // null — for every record, including ones with a full per-document
            // branch in `anchor_proofs`. The JSON file is the machine-readable
            // artifact an auditor or partner feeds to a verifier, so a silently
            // empty proof is the one place it must not happen (§1.5).
            const { proof, complete } = await sourceProofInput(supabase, {
              id: anchor.id,
              fingerprint: anchor.fingerprint,
              status: anchor.status,
              chain_tx_id: anchor.chain_tx_id ?? null,
              chain_block_height: anchor.chain_block_height ?? null,
              chain_block_hash: anchor.chain_block_hash ?? null,
              chain_timestamp: anchor.chain_timestamp ?? null,
            });
            if (proof && !complete) {
              toast.warning(
                'This package embeds the proof for inspection, but one field needed to run every offline check could not be loaded. Try again in a moment for a complete proof.',
              );
            }
            // buildProofPacket applies the shared block-identity resolver and
            // preserves `{hash, position}` siblings verbatim; it returns null for
            // a non-downloadable status, a missing proof, or a block mismatch.
            const { buildProofPacket } = await import('@/lib/generateAuditReport');
            const proofBundle = buildProofPacket({
              publicId: anchor.public_id ?? anchor.id,
              filename: anchor.filename,
              fingerprint: anchor.fingerprint,
              status: anchor.status,
              createdAt: anchor.created_at,
              securedAt: anchor.chain_timestamp ?? undefined,
              networkReceipt: anchor.chain_tx_id ?? undefined,
              blockHeight: anchor.chain_block_height ?? undefined,
              blockHash: anchor.chain_block_hash ?? undefined,
              proof,
              proofComplete: complete,
            });
            const { generateProofPackage, downloadProofPackage, getProofPackageFilename } = await import('@/lib/proofPackage');
            const proofPackage = generateProofPackage(
              {
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
              },
              // Legacy humanized view, kept for back-compat. Populated from the
              // same packet so the two can no longer disagree.
              proofBundle
                ? {
                    merkle_root: proofBundle.merkle_root,
                    proof_path: proofBundle.merkle_proof?.map((e) => e.hash) ?? null,
                  }
                : undefined,
              proofBundle,
              complete,
            );
            const filename = getProofPackageFilename({
              filename: anchor.filename,
              public_id: anchor.public_id,
            });
            downloadProofPackage(proofPackage, filename);
          } catch (err) {
            // A stored branch whose sibling hash is malformed fails the
            // package schema. That is a permanent data defect, not a transient
            // one, so it must not be reported as "try again" — and the error is
            // logged rather than swallowed so the record can be found.
            const corruptProof = err instanceof ZodError;
            if (corruptProof) {
              console.error('Proof package rejected for record', anchor.public_id ?? anchor.id, err);
            }
            toast.error(
              corruptProof
                ? RECORD_DETAIL_LABELS.PROOF_PACKAGE_CORRUPT
                : RECORD_DETAIL_LABELS.PROOF_PACKAGE_FAILED,
            );
          }
        }}
      />
    </AppShell>
  );
}
