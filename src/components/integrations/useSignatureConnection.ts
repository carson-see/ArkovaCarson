import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface SignatureConnection {
  id: string;
  account_label: string | null;
  account_id: string | null;
  connected_at: string | null;
  scope: string | null;
}

type SignatureProvider = 'adobe_sign' | 'docusign';

/**
 * Org-level connections live in `org_integrations`; per-member DocuSign lives
 * in `member_integrations`. Both store the same public columns and are read
 * under the caller's RLS, so one query serves both — the table is a parameter,
 * never a free-form string.
 */
export type SignatureConnectionTable = 'org_integrations' | 'member_integrations';

/** These two providers store a public account label; Drive's label contains secrets. */
async function loadSignatureConnection(
  orgId: string,
  provider: SignatureProvider,
  table: SignatureConnectionTable,
) {
  // The generated frontend types predate org_integrations. Keep the cast at this
  // single query seam and pin the public projection rather than fetching secrets.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (supabase as any).from(table)
    .select('id, account_label, account_id, connected_at, scope')
    .eq('org_id', orgId).eq('provider', provider).is('revoked_at', null)
    .order('connected_at', { ascending: false }).limit(1).maybeSingle() as {
      data: SignatureConnection | null;
      error: unknown;
    };
}

export function useSignatureConnection(
  orgId: string,
  provider: SignatureProvider,
  loadFailure: string,
  table: SignatureConnectionTable = 'org_integrations',
) {
  const [connection, setConnection] = useState<SignatureConnection | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshConnection = useCallback(async () => {
    setStatusLoading(true);
    setError(null);
    try {
      const result = await loadSignatureConnection(orgId, provider, table);
      if (result.error) throw result.error;
      setConnection(result.data ?? null);
    } catch {
      setError(loadFailure);
      setConnection(null);
    } finally {
      setStatusLoading(false);
    }
  }, [orgId, provider, loadFailure, table]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async Supabase refresh settles after the effect returns
    void refreshConnection();
  }, [refreshConnection]);

  return { connection, setConnection, statusLoading, error, setError };
}
