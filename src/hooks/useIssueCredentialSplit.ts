/**
 * useIssueCredentialSplit — read the ENABLE_ISSUE_CREDENTIAL_SPLIT flag with
 * a defined `loading` state so callers can fail-closed during the initial
 * fetch window. Replaces three near-identical inline `useState/useEffect`
 * blocks across DashboardPage, OrgProfilePage, and IssueCredentialForm.
 *
 * Why fail-closed matters (Codex P1, SCRUM-1755):
 * - The flag default of `false` was being applied to the rendered tree
 *   before the async fetch resolved. When the flag is actually ON, that
 *   meant `gateBlocked` started false, and an unauthorized org admin could
 *   submit during the few-hundred-ms window before the fetch returned.
 * - This hook makes the loading state explicit so the consumer can refuse
 *   submit while `loading === true`.
 */

import { useEffect, useState } from 'react';
import { isIssueCredentialSplitEnabled } from '@/lib/switchboard';

export interface IssueCredentialSplitState {
  /** Final flag value once resolved. Use `loading` to know if it's settled. */
  enabled: boolean;
  /** True while the flag fetch is in flight. Callers MUST treat the gate as
   *  blocked while this is true if they're relying on the flag to authorize
   *  the action. */
  loading: boolean;
}

export function useIssueCredentialSplit(): IssueCredentialSplitState {
  const [state, setState] = useState<IssueCredentialSplitState>({ enabled: false, loading: true });
  useEffect(() => {
    let cancelled = false;
    isIssueCredentialSplitEnabled()
      .then((enabled) => {
        if (!cancelled) setState({ enabled, loading: false });
      })
      .catch(() => {
        // Fail-closed: on RPC error, treat the flag as ON (= split enforced)
        // so an unauthorized org admin cannot bypass the gate by tripping the
        // network call. The DB-side RLS / RPC checks remain authoritative.
        if (!cancelled) setState({ enabled: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
