/**
 * Compliance Mapping — Worker Side (CML-02)
 *
 * Maps credential types to regulatory control IDs for anchor metadata.
 * Auto-populates compliance_controls[] on SECURED anchors.
 *
 * Mirror of frontend src/lib/complianceMapping.ts (control IDs must match).
 */

type CredentialType =
  | 'DEGREE' | 'LICENSE' | 'CERTIFICATE' | 'TRANSCRIPT'
  | 'PROFESSIONAL' | 'CLE' | 'SEC_FILING' | 'PATENT'
  | 'REGULATION' | 'PUBLICATION' | 'BADGE' | 'ATTESTATION'
  | 'FINANCIAL' | 'LEGAL' | 'INSURANCE' | 'OTHER';

/**
 * Universal controls — inherent to the anchoring process.
 * Apply to ALL anchored credentials.
 */
const UNIVERSAL_CONTROLS = [
  'SOC2-CC6.1',   // Logical and physical access controls
  'SOC2-CC6.7',   // Data integrity in transmission and storage
  'GDPR-5.1f',    // Integrity and confidentiality
  'GDPR-25',      // Data protection by design
  'ISO27001-A.10', // Cryptographic controls
  'eIDAS-25',     // Electronic signatures and seals
  'eIDAS-35',     // Qualified electronic time stamps
  // SCRUM-2283: DPF-NOTICE / DPF-ACCOUNTABILITY removed. Arkova holds no active
  // EU-US Data Privacy Framework certification, so emitting them was a false
  // external-status claim (R-7 claims gate / §1.5). They were dropped from the
  // frontend mirror (`src/lib/complianceMapping.ts`) at the time; this worker
  // copy kept emitting them, which persisted the claim onto every SECURED
  // anchor and served it from `/api/v1/verify` and the audit export. Do not
  // re-add without a verifiable, counsel-confirmed certification.
];

/**
 * Control IDs that were once written to `anchors.compliance_controls` but must
 * no longer be surfaced. Historical rows still carry them (they were persisted
 * on every SECURED anchor until SCRUM-2227), and there is no migration that can
 * un-say a claim that already shipped — so read paths filter them instead.
 *
 * @see sanitizeStoredComplianceControls
 */
export const RETIRED_CONTROL_IDS: readonly string[] = [
  'DPF-NOTICE',
  'DPF-ACCOUNTABILITY',
];

/**
 * SCRUM-2227 — the informational-not-attestation note that MUST accompany any
 * surfaced `compliance_controls` value.
 *
 * Control IDs are a *mapping* from credential type to control identifier. They
 * are routinely misread as an assertion that the record, its issuer, or Arkova
 * has been assessed against the named framework — and for `eIDAS-25` / `eIDAS-35`
 * that misread ("qualified trust service") carries direct legal exposure. Per
 * §1.5 and the R-7 claims gate, the surface must state what is measured, what is
 * asserted, and what is NOT asserted.
 *
 * Rendered VERBATIM wherever `compliance_controls` appears: `/api/v1/verify`,
 * the AI accountability report, and the audit export (PDF + CSV). Wording follows
 * the shape of `JURISDICTION_INFORMATIONAL_DISCLAIMER`
 * (`services/worker/src/exports/cle-log-export.ts`) and deliberately avoids any
 * sufficiency or adequacy claim.
 *
 * NOTE FOR COUNSEL: drafted by engineering against the existing approved
 * disclaimers; not yet reviewed by counsel. See the PR body for SCRUM-2227.
 */
export const COMPLIANCE_CONTROLS_NOTE =
  'Compliance control identifiers are informational metadata only. They indicate '
  + 'which regulatory controls Arkova maps to this record\'s credential type. They are '
  + 'not an audit, certification, conformity assessment, or attestation that this '
  + 'record, its issuer, or Arkova satisfies any listed control, framework, or '
  + 'regulation. In particular, no identifier listed here asserts a qualified trust '
  + 'service, qualified electronic signature, or qualified electronic seal under '
  + 'eIDAS. Compliance determination remains the responsibility of the relying party '
  + 'and its auditors.';

/**
 * Filter retired control IDs out of an already-stored `compliance_controls`
 * value on the way to a consumer.
 *
 * Returns `null` when nothing survives, so callers can use the same
 * present/absent test they already use for a NULL column. Non-array values
 * (legacy object-shaped rows) are passed through unchanged — this function
 * removes claims, it does not reshape data it did not write.
 */
export function sanitizeStoredComplianceControls(stored: unknown): unknown {
  if (stored === null || stored === undefined) return null;
  if (!Array.isArray(stored)) return stored;

  const kept = stored.filter(
    (id): id is string => typeof id === 'string' && !RETIRED_CONTROL_IDS.includes(id),
  );
  return kept.length > 0 ? kept : null;
}

/**
 * Type-specific controls — additional frameworks beyond universal.
 */
const TYPE_SPECIFIC_CONTROLS: Partial<Record<CredentialType, string[]>> = {
  DEGREE: ['FERPA-99.31', 'FERPA-99.31-DL', 'FERPA-99.37'],
  TRANSCRIPT: ['FERPA-99.31', 'FERPA-99.31-DL', 'FERPA-99.37'],
  CERTIFICATE: ['ISO27001-A.14'],
  LICENSE: ['ISO27001-A.14'],
  PROFESSIONAL: ['ISO27001-A.14'],
  CLE: ['ISO27001-A.14'],
  INSURANCE: ['HIPAA-164.312', 'HIPAA-164.312-MFA', 'HIPAA-164.312-AUDIT', 'HIPAA-164.312-SESSION', 'LGPD-6', 'PDPA-24'],
  FINANCIAL: ['ISO27001-A.14', 'LGPD-6', 'LFPDPPP-6'],
  SEC_FILING: ['ISO27001-A.14'],
  LEGAL: ['ISO27001-A.14', 'eIDAS-35', 'LGPD-33', 'PDPA-26', 'LFPDPPP-36'],
};

/**
 * Get compliance control IDs for an anchor.
 *
 * @param credentialType - The anchor's credential_type
 * @returns Array of control ID strings (e.g., ["SOC2-CC6.1", "GDPR-5.1f", "FERPA-99.31"])
 */
export function getComplianceControlIds(
  credentialType: string | null | undefined,
): string[] {
  const controlIds = new Set(UNIVERSAL_CONTROLS);

  const typeKey = credentialType as CredentialType | undefined;
  if (typeKey && TYPE_SPECIFIC_CONTROLS[typeKey]) {
    for (const id of TYPE_SPECIFIC_CONTROLS[typeKey]!) {
      controlIds.add(id);
    }
  }

  return [...controlIds];
}
