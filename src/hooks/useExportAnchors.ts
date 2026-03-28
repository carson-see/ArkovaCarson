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

interface UseExportAnchorsReturn {
  exportAnchors: (orgId: string) => Promise<boolean>;
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
  const exportImpl = useCallback(async (orgId: string): Promise<boolean> => {
    // Capped at 5000 rows to prevent browser OOM on large orgs
    const { data, error: fetchError } = await supabase
      .from('anchors')
      .select('*')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(5000);

    if (fetchError) {
      throw new Error(fetchError.message || 'Failed to fetch records for export.');
    }

    if (!data || data.length === 0) {
      throw new Error('No records to export.');
    }

    const csvContent = generateCsv(data, anchorColumns);
    const filename = generateExportFilename('org-records');
    downloadCsv(csvContent, filename);

    return true;
  }, []);

  const { execute, loading, error, clearError } = useAsyncAction(exportImpl);

  const exportAnchors = useCallback(
    async (orgId: string): Promise<boolean> => {
      try {
        return await execute(orgId);
      } catch {
        return false;
      }
    },
    [execute],
  );

  return { exportAnchors, loading, error, clearError };
}
