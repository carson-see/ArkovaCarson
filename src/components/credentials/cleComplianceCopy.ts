/**
 * CLE Compliance Copy — local constants (SCRUM-1869 / CLE-R1)
 *
 * All user-visible strings for the CLE (Continuing Legal Education) compliance
 * display surface live here, sourced as a single local const object rather than
 * hardcoded inline in components.
 *
 * Why local (not src/lib/copy.ts)? `src/lib/copy.ts` is the canonical copy
 * registry but is LOCKED by concurrent PRs while this story ships. This file
 * follows the SCRUM-1847 `CPE_COMPLIANCE_COPY` precedent (sibling CPE-R1 work on
 * the same base branch) of a folder-local copy const, kept banned-term-free
 * (CLAUDE.md §1.3) so `npm run lint:copy` passes.
 *
 * CLE = Continuing Legal Education. "CLE", "ethics", "jurisdiction",
 * "credit(s)", "provider", and "state bar" are domain compliance terms, not
 * banned crypto terminology.
 *
 * @see SCRUM-1869, SCRUM-1865, SCRUM-1856 (NasbaStatusBadge pattern)
 */

/**
 * CLE provider approval status, as extracted/looked-up by the worker. Mirrors
 * services/worker/src/compliance/professional-education.ts
 * CleMetadataSchema.provider_approval_status.
 */
export type CleProviderApprovalStatus = 'approved' | 'not_approved' | 'unknown';

export const CLE_COMPLIANCE_COPY = {
  /** Disclaimer shown in the CleProviderBadge tooltip. Verbatim per SCRUM-1869 AC. */
  PROVIDER_DISCLAIMER:
    'Arkova displays provider approval status based on our reference registry. Your state bar has final authority on CLE credit acceptance.',

  /**
   * Inline banner shown when requires_manual_review === true. Carries
   * ethics-specific language. Verbatim per SCRUM-1869 AC.
   */
  REVIEW_BANNER:
    'CLE details require review — extracted fields may be incomplete. Ethics hours not confirmed.',

  /** Section heading for the CLE metadata block. */
  SECTION_TITLE: 'CLE Details',

  /** Provider approval badge visible labels, keyed by status. */
  PROVIDER_STATUS_LABELS: {
    approved: 'Approved Provider',
    unknown: 'Provider Status Unknown',
    not_approved: 'Provider Not Approved',
  } satisfies Record<CleProviderApprovalStatus, string>,

  /** Field labels for the CLE detail rows. */
  FIELD_LABELS: {
    credit_hours: 'Total CLE Credits',
    ethics_hours: 'Ethics Credits',
    jurisdiction: 'Jurisdiction',
    delivery_format: 'Delivery Format',
    provider_approval_status: 'Provider Status',
    approved_provider_name: 'Provider',
    course_title: 'Course Title',
    course_id: 'Course ID',
    completion_date: 'Completion Date',
    evidence_level: 'Evidence Level',
  },

  /** Accessible label for the provider approval badge tooltip trigger. */
  PROVIDER_TOOLTIP_ARIA: 'About provider approval status',
} as const;
