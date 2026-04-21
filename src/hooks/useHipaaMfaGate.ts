/**
 * HIPAA MFA Enforcement Gate — REG-05 (SCRUM-564)
 *
 * Checks if the current org requires MFA for healthcare credential access.
 * Section 164.312(d): Person or entity authentication.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';

/** Credential types that trigger HIPAA MFA enforcement */
const HEALTHCARE_CREDENTIAL_TYPES = [
  'INSURANCE',
  'MEDICAL',
  'MEDICAL_LICENSE',
  'IMMUNIZATION',
] as const;

export type HipaaMfaStatus = 'loading' | 'not_required' | 'mfa_enrolled' | 'mfa_needed';

interface UseHipaaMfaGateResult {
  status: HipaaMfaStatus;
  isMfaRequired: boolean;
  isMfaEnrolled: boolean;
  isBlocked: boolean;
  checkCredentialAccess: (credentialType: string | null) => boolean;
}

export function useHipaaMfaGate(orgId: string | null): UseHipaaMfaGateResult {
  const [orgRequiresMfa, setOrgRequiresMfa] = useState(false);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!orgId) {
      async function markLoaded() { setLoaded(true); }
      void markLoaded();
      return;
    }

    let cancelled = false;

    async function check() {
      // Parallel fetch: org MFA setting + user MFA enrollment
      const [orgResult, factorsResult] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).from('organizations').select('hipaa_mfa_required').eq('id', orgId!).single(),
        supabase.auth.mfa.listFactors(),
      ]);

      if (cancelled) return;

      const required = orgResult.data?.hipaa_mfa_required ?? false;
      setOrgRequiresMfa(required);

      const enrolled = (factorsResult.data?.totp ?? []).some(f => f.status === 'verified');
      setMfaEnrolled(enrolled);
      setLoaded(true);
    }

    void check();
    return () => { cancelled = true; };
  }, [orgId]);

  // Derive status from state — no separate status useState that can drift
  const status: HipaaMfaStatus = useMemo(() => {
    if (!loaded) return 'loading';
    if (!orgRequiresMfa) return 'not_required';
    return mfaEnrolled ? 'mfa_enrolled' : 'mfa_needed';
  }, [loaded, orgRequiresMfa, mfaEnrolled]);

  const checkCredentialAccess = useCallback((credentialType: string | null): boolean => {
    if (!credentialType) return true;
    if (!isHealthcareCredentialType(credentialType)) return true;
    if (!orgRequiresMfa) return true;
    return mfaEnrolled;
  }, [orgRequiresMfa, mfaEnrolled]);

  return {
    status,
    isMfaRequired: orgRequiresMfa,
    isMfaEnrolled: mfaEnrolled,
    isBlocked: status === 'mfa_needed',
    checkCredentialAccess,
  };
}

export function isHealthcareCredentialType(credentialType: string | null | undefined): boolean {
  if (!credentialType) return false;
  return (HEALTHCARE_CREDENTIAL_TYPES as readonly string[]).includes(credentialType);
}
