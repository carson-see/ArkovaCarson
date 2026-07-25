/**
 * useExportAnchors Hook
 *
 * Hook for exporting organization anchors to CSV.
 */

import { useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import {
  generateCsv,
  downloadCsv,
  formatDateForCsv,
  generateExportFilename,
} from '@/lib/csvExport';
import type { Database } from '@/types/database.types';
import { useAsyncAction } from './useAsyncAction';

type Anchor = Database['public']['Tables']['anchors']['Row'];

/**
 * Row-scope for an export (SCRUM-3010 STEP 1 — frontend gate).
 * - `isAdmin: true`  → the export covers the whole organization (`org_id`).
 * - `isAdmin: false` → the export is restricted to the caller's OWN rows
 *   (`user_id`), mirroring the `useAnchors` INDIVIDUAL path. A non-admin member
 *   must never be able to pull a coworker's records. Fails closed when `userId`
 *   is missing.
 *
 * NOTE: this is the client-side gate only. The matching RLS tightening (so the
 * scope is enforced server-side, not just in the browser query) is deferred to
 * SCRUM-3010 STEP 2 (T3), post-soak.
 */
interface ExportScope {
  isAdmin: boolean;
  userId?: string | null;
}

interface UseExportAnchorsReturn {
  exportAnchors: (orgId: string, scope: ExportScope) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

const anchorColumns = [
  { header: 'ID', accessor: 'id' as const },
  { header: 'Filename', accessor: 'filename' as const },
  { header: 'Fingerprint', accessor: 'fingerprint' as const },
  { header: 'Status', accessor: 'status' as const },
  { header: 'Credential Type', accessor: (row: Anchor) => row.credential_type ?? '' },
  { header: 'Label', accessor: (row: Anchor) => row.label ?? '' },
  { header: 'Public ID', accessor: (row: Anchor) => row.public_id ?? '' },
  { header: 'File Size (bytes)', accessor: 'file_size' as const },
  { header: 'MIME Type', accessor: 'file_mime' as const },
  {
    header: 'Created At',
    accessor: (row: Anchor) => formatDateForCsv(row.created_at),
  },
  {
    header: 'Updated At',
    accessor: (row: Anchor) => formatDateForCsv(row.updated_at),
  },
  {
    header: 'Network Observed Time',
    accessor: (row: Anchor) => formatDateForCsv(row.chain_timestamp),
  },
  {
    header: 'Revoked At',
    accessor: (row: Anchor) => formatDateForCsv(row.revoked_at),
  },
  { header: 'Revocation Reason', accessor: (row: Anchor) => row.revocation_reason ?? '' },
  {
    header: 'Expires At',
    accessor: (row: Anchor) => formatDateForCsv(row.expires_at),
  },
  { header: 'Legal Hold', accessor: (row: Anchor) => row.legal_hold ? 'Yes' : 'No' },
];

export function useExportAnchors(): UseExportAnchorsReturn {
  const exportImpl = useCallback(async (orgId: string, scope: ExportScope): Promise<boolean> => {
    // SCRUM-3010 STEP 1: a non-admin member may only export their OWN rows.
    // Fail closed if we cannot identify the caller — never fall through to an
    // org-wide pull.
    if (!scope.isAdmin && !scope.userId) {
      throw new Error('You do not have permission to export these records.');
    }

    // Capped at 5000 rows to prevent browser OOM on large orgs.
    // Admin → org-wide (`org_id`); non-admin → own rows only (`user_id`).
    const scoped = supabase
      .from('anchors')
      .select('id, filename, fingerprint, status, credential_type, label, public_id, file_size, file_mime, created_at, updated_at, chain_timestamp, revoked_at, revocation_reason, expires_at, legal_hold');

    const filtered = scope.isAdmin
      ? scoped.eq('org_id', orgId)
      : scoped.eq('user_id', scope.userId as string);

    const { data, error: fetchError } = await filtered
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (fetchError) {
      throw new Error(fetchError.message || 'Failed to fetch records for export.');
    }

    if (!data || data.length === 0) {
      throw new Error('No records to export.');
    }

    const csvContent = generateCsv(data as Anchor[], anchorColumns);
    const filename = generateExportFilename('org-records');
    downloadCsv(csvContent, filename);

    return true;
  }, []);

  const { execute, loading, error, clearError } = useAsyncAction(exportImpl);

  const exportAnchors = useCallback(
    async (orgId: string, scope: ExportScope): Promise<boolean> => {
      try {
        return await execute(orgId, scope);
      } catch {
        return false;
      }
    },
    [execute],
  );

  return { exportAnchors, loading, error, clearError };
}
