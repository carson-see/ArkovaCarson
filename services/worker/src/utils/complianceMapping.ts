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
];

/**
 * Type-specific controls — additional frameworks beyond universal.
 */
const TYPE_SPECIFIC_CONTROLS: Partial<Record<CredentialType, string[]>> = {
  DEGREE: ['FERPA-99.31'],
  TRANSCRIPT: ['FERPA-99.31'],
  CERTIFICATE: ['ISO27001-A.14'],
  LICENSE: ['ISO27001-A.14'],
  PROFESSIONAL: ['ISO27001-A.14'],
  CLE: ['ISO27001-A.14'],
  INSURANCE: ['HIPAA-164.312'],
  FINANCIAL: ['ISO27001-A.14'],
  SEC_FILING: ['ISO27001-A.14'],
  LEGAL: ['ISO27001-A.14', 'eIDAS-35'],
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
