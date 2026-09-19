/**
 * useReferrals — SCRUM-5024.
 *
 * Reads the organization's ACTIVE referral code and the organizations that code
 * introduced, straight from Supabase (§1.2: once the table exists, no mock data
 * and no `useState` arrays).
 *
 * Minting is an EXPLICIT action — `mint()` is only called from the button. The
 * hook never mints on load: a partner code is a durable, shareable identifier,
 * and creating one as a side effect of someone opening a settings page mints
 * codes for organizations that never wanted one.
 *
 * There is no `?? []` anywhere in here. A failed read sets `error` and leaves
 * `referred` empty *with* that error set, so the panel can tell "you have no
 * referrals" apart from "we could not find out".
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';

export interface ReferredOrganization {
  /** Undefined for an organization with no public id. Never null. */
  organizationPublicId?: string;
  displayName: string;
  referredAt: string;
  verificationStatus: string;
}

export interface UseReferralsResult {
  loading: boolean;
  /** Non-null when the last read failed. `referred` is then not trustworthy. */
  error: string | null;
  code: string | null;
  shareUrl: string | null;
  referred: ReferredOrganization[];
  minting: boolean;
  mintError: string | null;
  mint: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface ReferralRow {
  organization_public_id: string | null;
  display_name: string | null;
  referred_at: string | null;
  verification_status: string | null;
}

export function buildShareUrl(code: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/signup?ref=${encodeURIComponent(code)}`;
}

export function useReferrals(orgId: string | null): UseReferralsResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [referred, setReferred] = useState<ReferredOrganization[]>([]);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  // Guards against a late response from a previous orgId overwriting a newer
  // one, and against setState after unmount.
  const requestSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    if (!orgId) {
      setLoading(false);
      setError(null);
      setCode(null);
      setReferred([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data: codeRow, error: codeError } = await supabase
        .from('referral_codes')
        .select('code')
        .eq('org_id', orgId)
        .eq('active', true)
        .maybeSingle();

      if (codeError) throw new Error(codeError.message);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: rows, error: rpcError } = await (supabase as any).rpc('get_org_referrals', {
        p_org_id: orgId,
      });

      if (rpcError) throw new Error(rpcError.message);

      if (seq !== requestSeq.current) return;

      setCode((codeRow as { code?: string } | null)?.code ?? null);
      setReferred(
        (rows as ReferralRow[]).map((row) => ({
          ...(row.organization_public_id ? { organizationPublicId: row.organization_public_id } : {}),
          displayName: row.display_name ?? '',
          referredAt: row.referred_at ?? '',
          verificationStatus: row.verification_status ?? 'UNVERIFIED',
        })),
      );
      setLoading(false);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      const message = err instanceof Error ? err.message : 'Failed to load referrals';
      console.error('[useReferrals] load failed', { orgId, message });
      // Deliberately NOT falling back to an empty list as if it were an answer.
      setError(message);
      setReferred([]);
      setCode(null);
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    // `load` sets state (loading/error/code/referred) before its first
    // `await` in the common path, so it is deferred by a microtask instead of
    // invoked directly — react-hooks/set-state-in-effect flags a *synchronous*
    // setState inside the effect body; this defers to the next microtask
    // instead, which is not observable to callers awaiting `refresh()` or
    // polling via `waitFor`.
    void Promise.resolve().then(() => load());
    return () => {
      // Invalidate any in-flight response for this instance.
      requestSeq.current += 1;
    };
  }, [load]);

  const mint = useCallback(async (): Promise<void> => {
    if (!orgId) return;
    setMinting(true);
    setMintError(null);
    try {
      // Idempotent server-side: a second call returns the existing code.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase as any).rpc('ensure_org_referral_code', {
        p_org_id: orgId,
      });
      if (rpcError) throw new Error(rpcError.message);
      const minted = typeof data === 'string' ? data : null;
      if (!minted) throw new Error('The service did not return a referral code.');
      setCode(minted);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create a referral code';
      console.error('[useReferrals] mint failed', { orgId, message });
      setMintError(message);
    } finally {
      setMinting(false);
    }
  }, [orgId]);

  const shareUrl =
    code && typeof window !== 'undefined' ? buildShareUrl(code, window.location.origin) : null;

  return { loading, error, code, shareUrl, referred, minting, mintError, mint, refresh: load };
}
