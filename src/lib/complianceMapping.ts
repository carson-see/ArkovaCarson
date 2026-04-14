/**
 * Compliance Mapping (CML-01)
 *
 * Maps credential types to applicable regulatory controls.
 * Static mapping — no DB required for Level 1 (UI badges).
 *
 * Controls sourced from:
 *   - SOC 2 Trust Services Criteria (CC6.1, CC6.7)
 *   - GDPR Articles (Art. 5(1)(f), Art. 25)
 *   - FERPA (§99.31)
 *   - ISO 27001 Annex A (A.10, A.14)
 *   - eIDAS (Art. 25, Art. 35)
 *   - HIPAA (§164.312)
 */

/** A single regulatory control reference */
export interface ComplianceControl {
  /** Short identifier (e.g., "SOC2-CC6.7") */
  id: string;
  /** Framework name */
  framework: 'SOC 2' | 'GDPR' | 'FERPA' | 'ISO 27001' | 'eIDAS' | 'HIPAA' | 'Kenya DPA' | 'APP' | 'POPIA' | 'NDPA';
  /** Human-readable control name */
  label: string;
  /** What this control proves about the anchor */
  description: string;
  /** Badge color class (Tailwind) */
  color: string;
}

/** All known compliance controls */
export const COMPLIANCE_CONTROLS: Record<string, ComplianceControl> = {
  'SOC2-CC6.1': {
    id: 'SOC2-CC6.1',
    framework: 'SOC 2',
    label: 'SOC 2 CC6.1',
    description: 'Logical and physical access controls — document integrity protected by cryptographic fingerprinting',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  'SOC2-CC6.7': {
    id: 'SOC2-CC6.7',
    framework: 'SOC 2',
    label: 'SOC 2 CC6.7',
    description: 'Data integrity in transmission and storage — immutable anchor on public network',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  'GDPR-5.1f': {
    id: 'GDPR-5.1f',
    framework: 'GDPR',
    label: 'GDPR Art. 5(1)(f)',
    description: 'Integrity and confidentiality — document processed client-side, only fingerprint stored',
    color: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  },
  'GDPR-25': {
    id: 'GDPR-25',
    framework: 'GDPR',
    label: 'GDPR Art. 25',
    description: 'Data protection by design — privacy-preserving architecture, no PII on server',
    color: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  },
  'FERPA-99.31': {
    id: 'FERPA-99.31',
    framework: 'FERPA',
    label: 'FERPA §99.31',
    description: 'Education record disclosure controls — verification without exposing student records',
    color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  'FERPA-99.31-DL': {
    id: 'FERPA-99.31-DL',
    framework: 'FERPA',
    label: 'FERPA §99.31 Disclosure Log',
    description: 'Audit log of all education record disclosures per §99.32 — who accessed, when, and legitimate interest',
    color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  'FERPA-99.37': {
    id: 'FERPA-99.37',
    framework: 'FERPA',
    label: 'FERPA §99.37 Directory Opt-Out',
    description: 'Directory information opt-out controls — students can restrict release of directory data',
    color: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  },
  'ISO27001-A.10': {
    id: 'ISO27001-A.10',
    framework: 'ISO 27001',
    label: 'ISO 27001 A.10',
    description: 'Cryptographic controls — SHA-256 fingerprinting with public network anchoring',
    color: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  },
  'ISO27001-A.14': {
    id: 'ISO27001-A.14',
    framework: 'ISO 27001',
    label: 'ISO 27001 A.14',
    description: 'System acquisition, development and maintenance — tamper-evident record keeping',
    color: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  },
  'eIDAS-25': {
    id: 'eIDAS-25',
    framework: 'eIDAS',
    label: 'eIDAS Art. 25',
    description: 'Electronic signatures and seals — timestamped cryptographic proof of document state',
    color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  },
  'eIDAS-35': {
    id: 'eIDAS-35',
    framework: 'eIDAS',
    label: 'eIDAS Art. 35',
    description: 'Qualified electronic time stamps — network-observed timestamp via public anchoring',
    color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  },
  'HIPAA-164.312': {
    id: 'HIPAA-164.312',
    framework: 'HIPAA',
    label: 'HIPAA §164.312',
    description: 'Technical safeguards — integrity controls and audit controls for electronic PHI',
    color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  'HIPAA-164.312-MFA': {
    id: 'HIPAA-164.312-MFA',
    framework: 'HIPAA',
    label: 'HIPAA §164.312(d) MFA',
    description: 'Person or entity authentication — multi-factor authentication enforced for PHI access',
    color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  'HIPAA-164.312-AUDIT': {
    id: 'HIPAA-164.312-AUDIT',
    framework: 'HIPAA',
    label: 'HIPAA §164.312(b) Audit',
    description: 'Audit controls — hardware, software, and procedural mechanisms to record PHI access',
    color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  'HIPAA-164.312-SESSION': {
    id: 'HIPAA-164.312-SESSION',
    framework: 'HIPAA',
    label: 'HIPAA §164.312(a)(2)(iii) Session',
    description: 'Automatic logoff — session timeout for inactive PHI access sessions',
    color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  // International frameworks (REG-27)
  'KENYA-DPA-25': {
    id: 'KENYA-DPA-25',
    framework: 'Kenya DPA',
    label: 'Kenya DPA §25',
    description: 'Data protection principles — lawful, fair, and transparent processing of personal data',
    color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  },
  'KENYA-DPA-48': {
    id: 'KENYA-DPA-48',
    framework: 'Kenya DPA',
    label: 'Kenya DPA §48',
    description: 'Cross-border transfer controls — Standard Contractual Clauses for international transfers',
    color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  },
  'APP-8': {
    id: 'APP-8',
    framework: 'APP',
    label: 'APP 8',
    description: 'Cross-border disclosure — reasonable steps to ensure overseas recipient compliance',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  'APP-11': {
    id: 'APP-11',
    framework: 'APP',
    label: 'APP 11',
    description: 'Security of personal information — reasonable steps to protect from misuse, interference, and loss',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  'APP-13': {
    id: 'APP-13',
    framework: 'APP',
    label: 'APP 13',
    description: 'Correction of personal information — data correction workflow with 30-day response timeline',
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  'POPIA-19': {
    id: 'POPIA-19',
    framework: 'POPIA',
    label: 'POPIA §19',
    description: 'Security safeguards — appropriate technical and organizational measures for personal information',
    color: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  },
  'POPIA-72': {
    id: 'POPIA-72',
    framework: 'POPIA',
    label: 'POPIA §72',
    description: 'Transborder information flows — binding agreement required for cross-border transfers',
    color: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  },
  'NDPA-24': {
    id: 'NDPA-24',
    framework: 'NDPA',
    label: 'NDPA §24',
    description: 'Data protection principles — lawfulness, fairness, transparency, and purpose limitation',
    color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  },
  'NDPA-43': {
    id: 'NDPA-43',
    framework: 'NDPA',
    label: 'NDPA §43',
    description: 'Cross-border transfer — adequate data protection level or Standard Contractual Clauses',
    color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  },
} as const;

type CredentialType =
  | 'DEGREE' | 'LICENSE' | 'CERTIFICATE' | 'TRANSCRIPT'
  | 'PROFESSIONAL' | 'CLE' | 'SEC_FILING' | 'PATENT'
  | 'REGULATION' | 'PUBLICATION' | 'BADGE' | 'ATTESTATION'
  | 'FINANCIAL' | 'LEGAL' | 'INSURANCE' | 'OTHER';

/**
 * Universal controls that apply to ALL anchored credentials.
 * These are inherent to the anchoring process itself.
 */
const UNIVERSAL_CONTROLS = [
  'SOC2-CC6.1',
  'SOC2-CC6.7',
  'GDPR-5.1f',
  'GDPR-25',
  'ISO27001-A.10',
  'eIDAS-25',
  'eIDAS-35',
];

/**
 * Additional controls by credential type.
 * These are type-specific regulatory frameworks that apply
 * beyond the universal controls.
 */
const TYPE_SPECIFIC_CONTROLS: Partial<Record<CredentialType, string[]>> = {
  DEGREE: ['FERPA-99.31', 'FERPA-99.31-DL', 'FERPA-99.37'],
  TRANSCRIPT: ['FERPA-99.31', 'FERPA-99.31-DL', 'FERPA-99.37'],
  CERTIFICATE: ['ISO27001-A.14'],
  LICENSE: ['ISO27001-A.14'],
  PROFESSIONAL: ['ISO27001-A.14'],
  CLE: ['ISO27001-A.14'],
  INSURANCE: ['HIPAA-164.312', 'HIPAA-164.312-MFA', 'HIPAA-164.312-AUDIT', 'HIPAA-164.312-SESSION'],
  FINANCIAL: ['ISO27001-A.14'],
  SEC_FILING: ['ISO27001-A.14'],
  LEGAL: ['ISO27001-A.14', 'eIDAS-35'],
};

/**
 * Get all applicable compliance controls for a credential.
 *
 * @param credentialType - The credential's type
 * @param isSecured - Whether the anchor status is SECURED (controls only apply once anchored)
 * @returns Array of applicable compliance controls
 */
export function getComplianceControls(
  credentialType: string | null | undefined,
  isSecured: boolean,
): ComplianceControl[] {
  if (!isSecured) return [];

  const controlIds = new Set(UNIVERSAL_CONTROLS);

  const typeKey = credentialType as CredentialType | undefined;
  if (typeKey && TYPE_SPECIFIC_CONTROLS[typeKey]) {
    for (const id of TYPE_SPECIFIC_CONTROLS[typeKey]!) {
      controlIds.add(id);
    }
  }

  return [...controlIds]
    .map(id => COMPLIANCE_CONTROLS[id])
    .filter((c): c is ComplianceControl => !!c);
}

/**
 * Get unique frameworks that apply to a credential.
 * Useful for showing framework badge summary.
 */
export function getComplianceFrameworks(
  credentialType: string | null | undefined,
  isSecured: boolean,
): string[] {
  const controls = getComplianceControls(credentialType, isSecured);
  return [...new Set(controls.map(c => c.framework))];
}
