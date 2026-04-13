/**
 * HIPAA MFA Enforcement Gate — REG-05 (SCRUM-564)
 *
 * Checks if the current org requires MFA for healthcare credential access.
 * When a user tries to access healthcare credential types (INSURANCE, MEDICAL_LICENSE, etc.)
 * in an org with hipaa_mfa_required=true, this hook blocks access until MFA is enrolled.
 *
 * Section 164.312(d): Person or entity authentication.
 */

import { useState, useEffect, useCallback } from 'react';
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
  const [status, setStatus] = useState<HipaaMfaStatus>('loading');
  const [orgRequiresMfa, setOrgRequiresMfa] = useState(false);
  const [mfaEnrolled, setMfaEnrolled] = useState(false);

  useEffect(() => {
    if (!orgId) {
      setStatus('not_required');
      return;
    }

    let cancelled = false;

    async function check() {
      // Check org's HIPAA MFA setting (column from migration 0197, not yet in generated types)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: org } = await (supabase as any)
        .from('organizations')
        .select('hipaa_mfa_required')
        .eq('id', orgId!)
        .single();

      if (cancelled) return;

      const required = org?.hipaa_mfa_required ?? false;
      setOrgRequiresMfa(required);

      if (!required) {
        setStatus('not_required');
        return;
      }

      // Check MFA enrollment
      const { data: factors } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;

      const enrolled = (factors?.totp ?? []).some(f => f.status === 'verified');
      setMfaEnrolled(enrolled);
      setStatus(enrolled ? 'mfa_enrolled' : 'mfa_needed');
    }

    void check();
    return () => { cancelled = true; };
  }, [orgId]);

  const checkCredentialAccess = useCallback((credentialType: string | null): boolean => {
    if (!credentialType) return true;
    const isHealthcare = (HEALTHCARE_CREDENTIAL_TYPES as readonly string[]).includes(credentialType);
    if (!isHealthcare) return true;
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
