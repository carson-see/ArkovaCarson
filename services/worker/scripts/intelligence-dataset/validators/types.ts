/**
 * NVI (Nessie Verification Infrastructure) — shared types
 *
 * Every citation the Nessie intelligence model is trained to emit must be
 * anchored to an authoritative primary source (statute text, court opinion,
 * agency bulletin, or state statute). A validator's job is to:
 *
 *   1. Decide whether an `IntelligenceSource` registry entry LOOKS LIKE the
 *      kind of citation this validator handles (e.g. "is this a federal
 *      statute quote?" or "is this a case cite?"). Validators that say "not
 *      my jurisdiction" MUST return { applicable: false } — silent passes
 *      are the root of the NVI problem the gate is trying to prevent.
 *
 *   2. For applicable entries, perform structural + authority checks:
 *      canonical citation format, authoritative URL domain, reachable quote
 *      text (if a live-fetch mode is enabled), and sanity checks on the
 *      quote itself (length, presence of the section number, etc).
 *
 *   3. Return a deterministic, JSON-serializable `VerificationResult`. The
 *      verification registry (see verification-registry.ts) stores these so
 *      the CI guard (NVI-18) can block training-data emission when sources
 *      lack a passing verification.
 *
 * Scope: this is *structural* verification — it catches citations that are
 * not authoritative URLs, or whose section numbers don't match the quote
 * text. It cannot catch a well-formatted but fabricated quote without a
 * live fetch. Live fetching is an opt-in (--live) so unit tests stay
 * offline and CI stays deterministic.
 */

import type { IntelligenceSource } from '../types';

/** A validator is either applicable to a source or it isn't. */
export type Applicability =
  | { applicable: true }
  | { applicable: false; reason: string };

/**
 * Outcome of running a single validator against a single source.
 *
 * `passed: true` means the source meets this validator's bar. `passed:
 * false` with `hardFail: true` means the CI guard must block training on
 * this source. `passed: false` with `hardFail: false` is a warning — human
 * review needed but not a build-blocker.
 */
export interface VerificationResult {
  /** IntelligenceSource.id being verified. */
  sourceId: string;
  /** Kind of validator that produced this result. */
  validator: ValidatorKind;
  /** Did the source pass this validator? */
  passed: boolean;
  /** If passed=false: is this a hard failure (block CI) or soft (warn)? */
  hardFail: boolean;
  /** Human-readable description of what was checked + what was found. */
  notes: string;
  /** ISO date the verification was performed. */
  verifiedAt: string;
  /** Which live-fetch URLs were hit (if any). Empty in offline mode. */
  fetchedUrls?: string[];
}

/** Discriminator for validator kinds — wired to Jira NVI story IDs. */
export type ValidatorKind =
  | 'statute-quote'       // NVI-01
  | 'case-law'            // NVI-02
  | 'agency-bulletin'     // NVI-03
  | 'state-statute';      // NVI-04

/** A validator handles one ValidatorKind. */
export interface Validator {
  kind: ValidatorKind;
  isApplicable(source: IntelligenceSource): Applicability;
  validate(source: IntelligenceSource, opts?: ValidateOpts): Promise<VerificationResult>;
}

export interface ValidateOpts {
  /** Perform live HTTP fetches to verify quote text. Default: false. */
  live?: boolean;
  /** Override ISO date stamp (for deterministic tests). */
  now?: string;
}

/** Helper: current ISO timestamp respecting ValidateOpts.now override. */
export function stamp(opts?: ValidateOpts): string {
  return opts?.now ?? new Date().toISOString();
}
