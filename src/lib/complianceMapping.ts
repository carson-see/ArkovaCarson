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
  /**
   * Framework name.
   * SCRUM-2283: 'EU-US DPF' removed — Arkova does NOT hold an active EU-US Data
   * Privacy Framework certification, so asserting it as a compliance framework on
   * secured anchors (public verification page + compliance dashboard) was a false
   * external-status claim (R-7 claims gate / §1.5). Do not re-add without a
   * counsel-confirmed, verifiable certification.
   */
  framework: 'SOC 2' | 'GDPR' | 'FERPA' | 'ISO 27001' | 'eIDAS' | 'HIPAA' | 'Kenya DPA' | 'APP' | 'POPIA' | 'NDPA' | 'LGPD' | 'PDPA' | 'LFPDPPP';
  /** Human-readable control name */
  label: string;
  /** What this control proves about the anchor */
  description: string;
  /** Badge color class (Tailwind) */
  color: string;
}

/** Framework badge colors — single source, keyed by framework name */
const FRAMEWORK_COLORS: Record<ComplianceControl['framework'], string> = {
  'SOC 2': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  'GDPR': 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300',
  'FERPA': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  'ISO 27001': 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  'eIDAS': 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  'HIPAA': 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  'Kenya DPA': 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  'APP': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  'POPIA': 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  'NDPA': 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  'LGPD': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  'PDPA': 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  'LFPDPPP': 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300',
  // SCRUM-2283: 'EU-US DPF' color removed with the framework (see above).
};

/** Helper to build a control entry with color derived from framework */
function ctrl(id: string, framework: ComplianceControl['framework'], label: string, description: string): ComplianceControl {
  return { id, framework, label, description, color: FRAMEWORK_COLORS[framework] };
}

/** All known compliance controls */
export const COMPLIANCE_CONTROLS: Record<string, ComplianceControl> = {
  'SOC2-CC6.1': ctrl('SOC2-CC6.1', 'SOC 2', 'SOC 2 CC6.1', 'Logical and physical access controls — document integrity protected by cryptographic fingerprinting'),
  'SOC2-CC6.7': ctrl('SOC2-CC6.7', 'SOC 2', 'SOC 2 CC6.7', 'Data integrity in transmission and storage — immutable anchor on public network'),
  'GDPR-5.1f': ctrl('GDPR-5.1f', 'GDPR', 'GDPR Art. 5(1)(f)', 'Integrity and confidentiality — document processed client-side, only fingerprint stored'),
  'GDPR-25': ctrl('GDPR-25', 'GDPR', 'GDPR Art. 25', 'Data protection by design — privacy-preserving architecture, no PII on server'),
  'FERPA-99.31': ctrl('FERPA-99.31', 'FERPA', 'FERPA §99.31', 'Education record disclosure controls — verification without exposing student records'),
  'FERPA-99.31-DL': ctrl('FERPA-99.31-DL', 'FERPA', 'FERPA §99.31 Disclosure Log', 'Audit log of all education record disclosures per §99.32 — who accessed, when, and legitimate interest'),
  'FERPA-99.37': ctrl('FERPA-99.37', 'FERPA', 'FERPA §99.37 Directory Opt-Out', 'Directory information opt-out controls — students can restrict release of directory data'),
  'ISO27001-A.10': ctrl('ISO27001-A.10', 'ISO 27001', 'ISO 27001 A.10', 'Cryptographic controls — SHA-256 fingerprinting with public network anchoring'),
  'ISO27001-A.14': ctrl('ISO27001-A.14', 'ISO 27001', 'ISO 27001 A.14', 'System acquisition, development and maintenance — tamper-evident record keeping'),
  'eIDAS-25': ctrl('eIDAS-25', 'eIDAS', 'eIDAS Art. 25', 'Electronic signatures and seals — timestamped cryptographic proof of document state'),
  'eIDAS-35': ctrl('eIDAS-35', 'eIDAS', 'eIDAS Art. 35', 'Qualified electronic time stamps — network-observed timestamp via public anchoring'),
  'HIPAA-164.312': ctrl('HIPAA-164.312', 'HIPAA', 'HIPAA §164.312', 'Technical safeguards — integrity controls and audit controls for electronic PHI'),
  'HIPAA-164.312-MFA': ctrl('HIPAA-164.312-MFA', 'HIPAA', 'HIPAA §164.312(d) MFA', 'Person or entity authentication — multi-factor authentication enforced for PHI access'),
  'HIPAA-164.312-AUDIT': ctrl('HIPAA-164.312-AUDIT', 'HIPAA', 'HIPAA §164.312(b) Audit', 'Audit controls — hardware, software, and procedural mechanisms to record PHI access'),
  'HIPAA-164.312-SESSION': ctrl('HIPAA-164.312-SESSION', 'HIPAA', 'HIPAA §164.312(a)(2)(iii) Session', 'Automatic logoff — session timeout for inactive PHI access sessions'),
  // International frameworks (REG-27)
  'KENYA-DPA-25': ctrl('KENYA-DPA-25', 'Kenya DPA', 'Kenya DPA §25', 'Data protection principles — lawful, fair, and transparent processing of personal data'),
  'KENYA-DPA-48': ctrl('KENYA-DPA-48', 'Kenya DPA', 'Kenya DPA §48', 'Cross-border transfer controls — Standard Contractual Clauses for international transfers'),
  'APP-8': ctrl('APP-8', 'APP', 'APP 8', 'Cross-border disclosure — reasonable steps to ensure overseas recipient compliance'),
  'APP-11': ctrl('APP-11', 'APP', 'APP 11', 'Security of personal information — reasonable steps to protect from misuse, interference, and loss'),
  'APP-13': ctrl('APP-13', 'APP', 'APP 13', 'Correction of personal information — data correction workflow with 30-day response timeline'),
  'POPIA-19': ctrl('POPIA-19', 'POPIA', 'POPIA §19', 'Security safeguards — appropriate technical and organizational measures for personal information'),
  'POPIA-72': ctrl('POPIA-72', 'POPIA', 'POPIA §72', 'Transborder information flows — binding agreement required for cross-border transfers'),
  'NDPA-24': ctrl('NDPA-24', 'NDPA', 'NDPA §24', 'Data protection principles — lawfulness, fairness, transparency, and purpose limitation'),
  'NDPA-43': ctrl('NDPA-43', 'NDPA', 'NDPA §43', 'Cross-border transfer — adequate data protection level or Standard Contractual Clauses'),
  // Brazil LGPD (INTL-01)
  'LGPD-6': ctrl('LGPD-6', 'LGPD', 'LGPD Art. 6', 'Data processing principles — purpose, adequacy, necessity, free access, quality, transparency, security, non-discrimination'),
  'LGPD-33': ctrl('LGPD-33', 'LGPD', 'LGPD Art. 33', 'International data transfer — adequate protection level, SCCs, or binding corporate rules'),
  // Singapore PDPA (INTL-02)
  'PDPA-24': ctrl('PDPA-24', 'PDPA', 'PDPA §24', 'Protection obligation — reasonable security arrangements to protect personal data'),
  'PDPA-26': ctrl('PDPA-26', 'PDPA', 'PDPA §26', 'Transfer limitation — overseas transfers only to jurisdictions with comparable protection or contractual safeguards'),
  // Mexico LFPDPPP (INTL-03)
  'LFPDPPP-6': ctrl('LFPDPPP-6', 'LFPDPPP', 'LFPDPPP Art. 6', 'Data protection principles — lawfulness, consent, information, quality, purpose, loyalty, proportionality, accountability'),
  'LFPDPPP-36': ctrl('LFPDPPP-36', 'LFPDPPP', 'LFPDPPP Art. 36', 'International transfer — recipient must assume same obligations, data subject consent required'),
  // SCRUM-2283 (TRUST-03 reverted): the DPF-NOTICE / DPF-ACCOUNTABILITY controls
  // asserting an EU-US Data Privacy Framework certification are removed. Arkova
  // does NOT hold an active certification, and these were in UNIVERSAL_CONTROLS
  // so they rendered a framework pill on EVERY secured anchor (unauthenticated
  // public verification page + compliance dashboard) — a false external-status
  // claim (R-7 / §1.5). Do not re-add without a verifiable, counsel-confirmed
  // certification and a corresponding measured/asserted/NOT-asserted proof note.
};

/** All tracked frameworks — derived from COMPLIANCE_CONTROLS to avoid duplication */
export const ALL_FRAMEWORKS = [...new Set(Object.values(COMPLIANCE_CONTROLS).map(c => c.framework))];

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
  // SCRUM-2283: DPF-NOTICE / DPF-ACCOUNTABILITY removed — see COMPLIANCE_CONTROLS.
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
  INSURANCE: ['HIPAA-164.312', 'HIPAA-164.312-MFA', 'HIPAA-164.312-AUDIT', 'HIPAA-164.312-SESSION', 'LGPD-6', 'PDPA-24'],
  FINANCIAL: ['ISO27001-A.14', 'LGPD-6', 'LFPDPPP-6'],
  SEC_FILING: ['ISO27001-A.14'],
  LEGAL: ['ISO27001-A.14', 'eIDAS-35', 'LGPD-33', 'PDPA-26', 'LFPDPPP-36'],
};

/**
 * Every control ID this module can attach to a credential — the union of the
 * universal set and every type-specific set.
 *
 * This is the CANONICAL catalogue of controls Arkova claims, and the thing the
 * worker mirror (`services/worker/src/utils/complianceMapping.ts`) must match.
 * `scripts/ci/check-compliance-mapping-mirror.ts` compares the two and fails CI
 * when they diverge — so removing a retired control from this file is now
 * sufficient to stop it being served, instead of relying on someone remembering
 * the second file (which is exactly how the EU-US DPF claim survived from
 * 2026-07-10 to 2026-08-01).
 *
 * Deliberately derived from the emitted arrays, NOT from `COMPLIANCE_CONTROLS`:
 * that dictionary is the definitions registry and legitimately carries
 * jurisdiction controls (Kenya DPA, APP, POPIA, NDPA) no credential type maps
 * to yet. Comparing against it would let an incomplete retirement — ID pulled
 * from the emitted arrays but left in the registry — pass unnoticed.
 */
export const EMITTABLE_CONTROL_IDS: ReadonlySet<string> = new Set([
  ...UNIVERSAL_CONTROLS,
  ...Object.values(TYPE_SPECIFIC_CONTROLS).flat(),
]);

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
