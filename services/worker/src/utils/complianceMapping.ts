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
 * DOCUMENTATION + REGRESSION FIXTURE, NOT THE MECHANISM. Filtering is done by
 * allowlist against `EMITTABLE_CONTROL_IDS`, so an ID removed from the catalogs
 * above stops being served whether or not anyone remembers to list it here.
 * This list records which claims we know shipped, and pins them in tests.
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
 * Rendered VERBATIM wherever `compliance_controls` is actually surfaced:
 * `/api/v1/verify`, the AI accountability report JSON (its PDF branch renders
 * no controls), the audit export (PDF + CSV), and the GRC evidence push to
 * Vanta / Drata / Anecdotes. Wording follows
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
 * Filter a stored `compliance_controls` value down to the IDs this worker still
 * stands behind, on the way to a consumer.
 *
 * ALLOWLIST, not denylist. The filter is "is this ID in the catalog this file
 * currently emits?", not "is this ID on a list of known-bad ones". That matters:
 * SCRUM-2283 removed the DPF identifiers from one catalog and nothing else, and
 * the claim stayed live on every SECURED anchor for two months. A denylist would
 * recreate exactly that two-edit requirement — remove the ID from
 * `UNIVERSAL_CONTROLS` *and* remember to add it to a retired list. With an
 * allowlist, deleting an ID from the catalog above is sufficient: it stops being
 * written AND stops being served from history, in one edit.
 * (`RETIRED_CONTROL_IDS` is retained as documentation and as a regression test
 * fixture, not as the mechanism.) The frontend already works this way —
 * `ComplianceDashboardPage.tsx` intersects stored IDs against the live catalog.
 *
 * Returns `null` when nothing survives, so callers can use the same
 * present/absent test they already use for a NULL column.
 *
 * Non-array values return `null` (fail closed). The column has only ever held a
 * JSON array; an object-shaped row cannot be filtered ID-by-ID, so passing it
 * through would surface exactly the claims this function exists to strip — and
 * it would arrive carrying the informational note, which would then be vouching
 * for content nothing checked.
 */
export function sanitizeStoredComplianceControls(stored: unknown): string[] | null {
  if (!Array.isArray(stored)) return null;

  const kept = stored.filter(
    (id): id is string => typeof id === 'string' && EMITTABLE_CONTROL_IDS.has(id),
  );
  return kept.length > 0 ? kept : null;
}

/**
 * The single resolver for "which control IDs may this surface show?".
 *
 * Stored controls (CML-02) win, filtered to the current catalog. When nothing
 * survives — or nothing was stored — the caller decides whether to fall back to
 * the computed credential-type mapping by passing `fallbackCredentialType`:
 *
 *   - `/api/v1/verify` surfaces the STORED record only, so it omits the option
 *     and gets `null` rather than inventing controls the row never carried.
 *   - The audit export and the GRC push have always fallen back to the computed
 *     mapping (the credential type's controls are still accurate; it was only
 *     the persisted claim that was wrong), so they pass it.
 *
 * Exists because this rule was written twice — once in `audit-export.ts`, once
 * in the GRC sync service — which put the honesty guarantee in two files with
 * one test each.
 */
export function resolveComplianceControlIds(
  stored: unknown,
  options: { fallbackCredentialType?: string | null } = {},
): string[] | null {
  const sanitized = sanitizeStoredComplianceControls(stored);
  if (sanitized) return sanitized;
  if (!('fallbackCredentialType' in options)) return null;
  const computed = getComplianceControlIds(options.fallbackCredentialType);
  return computed.length > 0 ? computed : null;
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
 * Every control ID this worker is currently willing to emit — the union of the
 * universal set and every type-specific set above.
 *
 * This is the allowlist `sanitizeStoredComplianceControls` filters historical
 * rows against, so removing an ID from either catalog above is the ONLY edit
 * needed to stop serving it, on new anchors and on the ~2.9M back catalogue
 * alike. Declared after both catalogs because `const` is not hoisted; it is only
 * read from function bodies, which run long after module init.
 *
 * EXPORTED for `scripts/ci/check-compliance-mapping-mirror.ts`, which asserts
 * this set matches the frontend mirror's. That check is what makes retiring a
 * control a ONE-file edit instead of a two-file promise (SCRUM-2283).
 */
export const EMITTABLE_CONTROL_IDS: ReadonlySet<string> = new Set([
  ...UNIVERSAL_CONTROLS,
  ...Object.values(TYPE_SPECIFIC_CONTROLS).flat(),
]);

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
