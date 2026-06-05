/**
 * CPE Compliance Copy — local constants (SCRUM-1847 / CPE-R1)
 *
 * All user-visible strings for the CPE (Continuing Professional Education)
 * compliance display surface live here, sourced as a single local const object
 * rather than hardcoded inline in components.
 *
 * Why local (not src/lib/copy.ts)? `src/lib/copy.ts` is the canonical copy
 * registry but was LOCKED by concurrent PRs while this story shipped. This file
 * follows the SCRUM-2214 `SUB_ORG_STATE_COPY` precedent of a folder-local copy
 * const, kept banned-term-free (CLAUDE.md §1.3) so `npm run lint:copy` passes.
 *
 * NASBA = National Association of State Boards of Accountancy. "NASBA",
 * "registry", "CPE", "credit(s)", and "field of study" are domain compliance
 * terms, not banned crypto terminology.
 *
 * @see SCRUM-1847, SCRUM-1856, SCRUM-1857, SCRUM-1858
 */

/** NASBA provider registry status, as extracted/looked-up by the worker. */
export type NasbaStatus = 'confirmed' | 'not_found' | 'unknown';

export const CPE_COMPLIANCE_COPY = {
  /** Disclaimer shown in the NASBA badge tooltip. Verbatim per SCRUM-1847 AC. */
  NASBA_DISCLAIMER:
    'Arkova displays NASBA registry status for your reference. State boards of accountancy have final authority on CPE credit acceptance.',

  /** Inline banner shown when requires_manual_review === true. Verbatim per AC. */
  REVIEW_BANNER: 'CPE details require review — extracted fields may be incomplete.',

  /** Section heading for the CPE metadata block. */
  SECTION_TITLE: 'CPE Details',

  /** NASBA badge visible labels, keyed by status. */
  NASBA_STATUS_LABELS: {
    confirmed: 'NASBA Registered',
    unknown: 'NASBA Status Unknown',
    not_found: 'Not in NASBA Registry',
  } satisfies Record<NasbaStatus, string>,

  /** Field labels for the CPE detail rows. */
  FIELD_LABELS: {
    credit_hours: 'CPE Credits',
    field_of_study: 'Field of Study',
    delivery_method: 'Delivery Method',
    nasba_status: 'NASBA Status',
    provider: 'Provider',
    title: 'Course Title',
    completion_date: 'Completion Date',
    evidence_level: 'Evidence Level',
  },

  /** Accessible label for the NASBA status badge tooltip trigger. */
  NASBA_TOOLTIP_ARIA: 'About NASBA registry status',
} as const;
