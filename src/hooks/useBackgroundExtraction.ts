/**
 * Background Extraction Hook
 *
 * Runs AI extraction asynchronously AFTER an anchor has already been created.
 * Flow: client-side OCR → PII strip → server API → update anchor metadata.
 * Also detects version chains: if the new anchor matches an expired/revoked
 * record (same credential type + issuer), it links them via parent_anchor_id.
 *
 * Constitution 1.6: OCR stays client-side. Only PII-stripped text sent to server.
 */

import { useCallback, useRef } from 'react';
import { runExtraction } from '@/lib/aiExtraction';
import { isAIExtractionEnabled } from '@/lib/switchboard';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';

interface ExtractionRequest {
  anchorId: string;
  file: File;
  fingerprint: string;
  userId: string;
}

// Fuzzy mapping: AI output → credential_type enum
const TYPE_MAP: Record<string, string> = {
  'DEGREE': 'DEGREE', 'DIPLOMA': 'DEGREE', 'BACHELOR': 'DEGREE', 'MASTER': 'DEGREE', 'PHD': 'DEGREE', 'DOCTORATE': 'DEGREE',
  'LICENSE': 'LICENSE', 'MEDICAL_LICENSE': 'LICENSE', 'NURSING_LICENSE': 'LICENSE', 'PE_LICENSE': 'LICENSE',
  'CERTIFICATE': 'CERTIFICATE', 'CERTIFICATION': 'CERTIFICATE', 'PMP': 'CERTIFICATE', 'INSURANCE': 'CERTIFICATE',
  'TRANSCRIPT': 'TRANSCRIPT', 'GRADE_REPORT': 'TRANSCRIPT',
  'PROFESSIONAL': 'PROFESSIONAL', 'PROFESSIONAL_CREDENTIAL': 'PROFESSIONAL',
  'CLE': 'CLE', 'CLE_CREDIT': 'CLE', 'CLE_ETHICS': 'CLE', 'CONTINUING_EDUCATION': 'CLE',
  'ATTESTATION': 'ATTESTATION', 'EMPLOYMENT_VERIFICATION': 'ATTESTATION', 'VERIFICATION_LETTER': 'ATTESTATION', 'LETTER_OF_RECOMMENDATION': 'ATTESTATION',
  'CONTRACT': 'OTHER', 'NDA': 'OTHER', 'AGREEMENT': 'OTHER',
  'OTHER': 'OTHER', 'GENERAL': 'OTHER', 'GENERAL_DOCUMENT': 'OTHER',
};

function resolveCredentialType(detected: string): string {
  const normalized = detected.toUpperCase().trim();
  return TYPE_MAP[normalized] ?? (
    Object.entries(TYPE_MAP).find(([k]) => normalized.includes(k))?.[1] ?? 'OTHER'
  );
}

/**
 * Detect if a new anchor supersedes an expired/revoked record.
 * Matches on: same user + same credential type + same issuer name.
 * Returns the most recent match's ID (to link as parent).
 */
async function detectVersionChain(
  userId: string,
  anchorId: string,
  credentialType: string,
  issuerName: string | undefined,
): Promise<string | null> {
  if (credentialType === 'OTHER' || !issuerName) return null;

  // Look for expired or revoked anchors with same type + issuer
  const { data: candidates } = await supabase
    .from('anchors')
    .select('id, status, metadata, expires_at, revoked_at')
    .eq('user_id', userId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .eq('credential_type', credentialType as any)
    .neq('id', anchorId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!candidates?.length) return null;

  // Find the best match: same issuer + expired or revoked
  const normalizedIssuer = issuerName.toLowerCase().trim();
  for (const candidate of candidates) {
    const meta = candidate.metadata as Record<string, string> | null;
    const candidateIssuer = meta?.issuerName?.toLowerCase().trim();
    if (!candidateIssuer || candidateIssuer !== normalizedIssuer) continue;

    const isExpired = candidate.expires_at && new Date(candidate.expires_at) < new Date();
    const isRevoked = candidate.revoked_at !== null;
    if (isExpired || isRevoked) {
      return candidate.id;
    }
  }

  return null;
}

export function useBackgroundExtraction() {
  const runningRef = useRef(false);

  const runInBackground = useCallback(async ({ anchorId, file, fingerprint, userId }: ExtractionRequest) => {
    if (runningRef.current) return;
    runningRef.current = true;

    try {
      const aiEnabled = await isAIExtractionEnabled().catch(() => false);
      if (!aiEnabled) return;

      const result = await runExtraction(file, fingerprint, 'OTHER');
      if (!result) return;

      // Build metadata from extracted fields
      const metadata: Record<string, string> = {};
      for (const field of result.fields) {
        if (field.value) {
          metadata[field.key] = field.value;
        }
      }

      // Determine credential type from AI detection
      const typeField = result.fields.find(f => f.key === 'credentialType');
      const credentialType = typeField?.value
        ? resolveCredentialType(typeField.value)
        : 'OTHER';

      // Auto-select template
      const { data: templates } = await supabase
        .from('credential_templates')
        .select('id, credential_type')
        .eq('is_system', true)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .eq('credential_type', credentialType as any)
        .limit(1);

      const templateId = templates?.[0]?.id ?? null;

      // Detect version chain — does this supersede an expired/revoked record?
      const issuerField = result.fields.find(f => f.key === 'issuerName');
      const parentId = await detectVersionChain(
        userId,
        anchorId,
        credentialType,
        issuerField?.value,
      );

      // Update anchor with extracted metadata + credential type + template + lineage
      const updatePayload: Record<string, unknown> = {};
      if (Object.keys(metadata).length > 0) {
        updatePayload.metadata = metadata;
      }
      if (credentialType !== 'OTHER') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updatePayload.credential_type = credentialType as any;
      }
      if (templateId) {
        updatePayload.template_id = templateId;
      }
      if (parentId) {
        updatePayload.parent_anchor_id = parentId;
      }

      if (Object.keys(updatePayload).length > 0) {
        await supabase
          .from('anchors')
          .update(updatePayload)
          .eq('id', anchorId);
      }

      const toastMsg = parentId
        ? 'AI analysis complete — linked to previous version'
        : 'AI analysis complete — credential details updated';
      toast.success(toastMsg);
    } catch {
      // Background extraction is best-effort — don't disturb the user
      console.warn('[BackgroundExtraction] Failed for anchor', anchorId);
    } finally {
      runningRef.current = false;
    }
  }, []);

  return { runInBackground };
}
