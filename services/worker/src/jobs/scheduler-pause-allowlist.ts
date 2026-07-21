/**
 * Maintenance-pause allowlist (SCRUM-2900 dead-man wiring).
 *
 * The scheduler manifest (scheduler-manifest.ts) codifies DURABLE intent:
 * a job that is meant to stay paused is recorded `enabled:false` with actor
 * attribution. This allowlist covers the other legitimate case — a job the
 * manifest says should be ENABLED that is TEMPORARILY paused on purpose
 * (founder-gated feeder drain rehearsal, rig maintenance, incident triage)
 * without a manifest flip.
 *
 * Rot control is the whole point (the 2026-05 feeder pause sat untracked for
 * ~10 weeks): every entry MUST carry a reason, an approver, and a hard
 * `expiresAt` review marker. Past `expiresAt` the entry stops sanctioning the
 * pause — the dead-man fires on the still-paused job as `expired-sanction` —
 * AND `validateMaintenancePauseAllowlist` reports it as an error, so the unit
 * gate stays red until the entry is renewed (with a fresh approval) or
 * removed. A pause can therefore never outlive its stated justification
 * silently.
 *
 * Code-level config on purpose, matching the manifest pattern: the allowlist
 * changes through a reviewed PR (who / why / until-when in the diff), not
 * through mutable console or table state — which is exactly the untracked
 * surface this story exists to eliminate.
 *
 * Constitution §1.5: the SHIPPED allowlist states what IS sanctioned. It
 * ships EMPTY — no sanctioned live pause exists in prod today (feeders are
 * verified ACTIVE; D12 is an undecided ruling). Fixtures in the unit tests
 * exercise the machinery.
 */

export interface MaintenancePauseAllowlistEntry {
  /** Manifest job id (scheduler-manifest.ts) this sanction covers. */
  jobId: string;
  /** Why the pause is sanctioned (human-readable, lands in the finding). */
  reason: string;
  /** Who approved the pause (operator identity — operational data, not user PII). */
  approvedBy: string;
  /**
   * ISO datetime the sanction ENDS (exclusive — at this instant the entry is
   * already expired). Doubles as the review marker: renewing requires a new
   * reviewed edit with a fresh approval.
   */
  expiresAt: string;
}

/**
 * The shipped allowlist. EMPTY today — no sanctioned live pause exists in
 * prod (§1.5). Add entries via reviewed PR only; the unit gate fails on any
 * expired entry until it is renewed or removed.
 */
export const MAINTENANCE_PAUSE_ALLOWLIST: MaintenancePauseAllowlistEntry[] = [];

export type MaintenancePauseLookup =
  | { status: 'active'; entry: MaintenancePauseAllowlistEntry }
  | { status: 'expired'; entry: MaintenancePauseAllowlistEntry }
  | { status: 'absent' };

/**
 * Look up the sanction state for a job at `nowMs`.
 *
 * Fail closed: an unparseable `expiresAt` NEVER yields `active` — a sanction
 * whose end cannot be established is treated as already expired.
 */
export function lookupMaintenancePause(
  jobId: string,
  nowMs: number,
  allowlist: MaintenancePauseAllowlistEntry[] = MAINTENANCE_PAUSE_ALLOWLIST,
): MaintenancePauseLookup {
  const entry = allowlist.find((e) => e.jobId === jobId);
  if (!entry) return { status: 'absent' };

  const expiresMs = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiresMs) || nowMs >= expiresMs) {
    return { status: 'expired', entry };
  }
  return { status: 'active', entry };
}

/**
 * Structural + rot validation. Returns human-readable errors (empty when
 * valid) so a unit gate keeps the shipped allowlist honest:
 *   - unique jobIds (one sanction per job — no ambiguity about which applies)
 *   - non-empty reason and approver
 *   - parseable expiry
 *   - NO expired entries (rot must be renewed with fresh approval, or removed)
 */
export function validateMaintenancePauseAllowlist(
  allowlist: MaintenancePauseAllowlistEntry[],
  nowMs: number,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const entry of allowlist) {
    if (seen.has(entry.jobId)) errors.push(`duplicate allowlist jobId: ${entry.jobId}`);
    seen.add(entry.jobId);

    if (!entry.reason.trim()) {
      errors.push(`${entry.jobId}: allowlist entry missing a reason`);
    }
    if (!entry.approvedBy.trim()) {
      errors.push(`${entry.jobId}: allowlist entry missing approvedBy`);
    }

    const expiresMs = Date.parse(entry.expiresAt);
    if (Number.isNaN(expiresMs)) {
      errors.push(`${entry.jobId}: allowlist expiresAt is not a parseable ISO datetime`);
    } else if (nowMs >= expiresMs) {
      errors.push(
        `${entry.jobId}: allowlist entry expired at ${entry.expiresAt} — renew with fresh approval or remove it (pauses must not rot)`,
      );
    }
  }

  return errors;
}
