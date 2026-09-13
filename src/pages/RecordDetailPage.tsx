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
import { RECORD_DETAIL_LABELS } from '@/lib/copy';
import { sourceProofInput } from '@/lib/sourceProofInput';
import { projectPublicRecordToTemplate, type ProjectedTemplate } from '@/lib/publicRecordTemplate';

const DESCRIPTION_FALLBACK_MAX_CODE_POINTS = 500;

/**
 * Truncates by Unicode CODE POINT (never UTF-16 code unit), so a truncation
 * boundary landing inside an astral-plane character (surrogate pair) keeps
 * the character whole instead of splitting it into a lone, invalid
 * surrogate — the exact 2026-08-17 `publicRecordDescription` poison-record
 * class in services/worker/src/jobs/publicRecordAnchor.ts, reproduced here
 * on the read side. `Array.from` iterates by code point.
 */
export function truncateCodePointSafe(value: string, maxCodePoints = DESCRIPTION_FALLBACK_MAX_CODE_POINTS): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxCodePoints) return value;
  return codePoints.slice(0, maxCodePoints).join('');
}

/**
 * A pipeline anchor's OWN `description` always wins when present. Only when
 * it is null/empty do we fall back to the linked public_records row's
 * metadata — abstract, then description, then summary, in that priority
 * order — truncated code-point-safely. Returns null when neither the
 * anchor nor the record has anything to show (degrades to today's
 * behavior).
 */
export function pipelineDescriptionFallback(
  record: { metadata: Record<string, unknown> } | null,
): string | null {
  if (!record) return null;
  const raw = (typeof record.metadata.abstract === 'string' ? record.metadata.abstract : null)
    ?? (typeof record.metadata.description === 'string' ? record.metadata.description : null)
    ?? (typeof record.metadata.summary === 'string' ? record.metadata.summary : null);
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return truncateCodePointSafe(trimmed);
}

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

  // SCRUM-5105: pipeline-anchored public records (OpenAlex, EDGAR, etc.)
  // carry only {pipeline_source, source_id, source_url, record_type} plus
  // merkle keys on anchors.metadata — the rich record (title, doi,
  // publication_date, authors, ...) lives on the linked public_records row
  // (public_records.anchor_id, btree-indexed). Fetch it once for a pipeline
  // anchor and project it onto template display keys so AssetDetailView /
  // CredentialRenderer can render labelled fields instead of the bare
  // pipeline stub. Never fetched for a non-pipeline (client-uploaded or
  // org-issued) anchor.
  const [pipelineTemplateMetadata, setPipelineTemplateMetadata] = useState<ProjectedTemplate>({});
  // Prod evidence (Sept sample): 293/400 recent pipeline anchors have
  // anchors.description NULL while public_records.metadata->>'abstract' is
  // present — early anchors wrote the abstract into description directly.
  // This is the read-side fix for legacy/current rows; the write side is
  // tracked separately. Only ever used when the anchor's OWN description is
  // null/empty (see pipelineDescriptionFallback above).
  const [pipelineDescription, setPipelineDescription] = useState<string | null>(null);
  useEffect(() => {
    const pipelineSource = (anchor?.metadata as Record<string, unknown> | null)?.pipeline_source;
    if (!anchor || typeof pipelineSource !== 'string') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear projected metadata for a non-pipeline anchor
      setPipelineTemplateMetadata({});
      setPipelineDescription(null);
      return;
    }

    let cancelled = false;
    async function fetchPublicRecord() {
      try {
        const { data, error: fetchError } = await supabase
          .from('public_records')
          .select('title, source, metadata')
          .eq('anchor_id', anchor!.id)
          .limit(1)
          .maybeSingle();

        if (cancelled) return;
        if (fetchError || !data) {
          // Degrade silently to today's behavior — never surface a fetch
          // failure for this enrichment as user-facing error state.
          setPipelineTemplateMetadata({});
          setPipelineDescription(null);
          return;
        }

        const recordMetadata = (data.metadata as Record<string, unknown> | null) ?? {};
        const projected = projectPublicRecordToTemplate(data.source, {
          title: data.title,
          metadata: recordMetadata,
        });
        setPipelineTemplateMetadata(projected);
        setPipelineDescription(pipelineDescriptionFallback({ metadata: recordMetadata }));
      } catch {
        if (!cancelled) {
          setPipelineTemplateMetadata({});
          setPipelineDescription(null);
        }
      }
    }
    fetchPublicRecord();

    return () => {
      cancelled = true;
    };
  }, [anchor]);

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
          // SCRUM-5105: project the linked public_records row's rich
          // metadata onto template display keys for pipeline anchors — the
          // anchor's own metadata keys win on collision (spread order).
          // When there is nothing projected (non-pipeline anchor, or the
          // fetch hasn't resolved / found nothing yet), this is byte-for-byte
          // the pre-existing `anchor.metadata ?? undefined` — an empty `{}`
          // here would otherwise make `credentialType || credentialMetadata`
          // truthy in AssetDetailView for every anchor, which is a behavior
          // change this PR must not make.
          metadata: Object.keys(pipelineTemplateMetadata).length > 0
            ? { ...pipelineTemplateMetadata, ...(anchor.metadata as Record<string, unknown> | null ?? {}) }
            : anchor.metadata as Record<string, unknown> | null ?? undefined,
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
          // The anchor's own description always wins when present (non-null,
          // non-empty). Only then does a pipeline anchor fall back to the
          // linked public_records row's abstract/description/summary — see
          // pipelineDescriptionFallback above.
          description: (anchor.description && anchor.description.trim())
            ? anchor.description
            : pipelineDescription ?? undefined,
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
