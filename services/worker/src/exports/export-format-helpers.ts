/**
 * Shared field-mapping + formatting primitives for the compliance-log exporters
 * (CPE — SCRUM-1848, CLE — SCRUM-1870, and any future per-domain export).
 *
 * This module is the single definition the export modules import (rather than
 * each keeping its own copy), so it is the one place to change how raw
 * anchor/metadata values are coerced into auditor-safe record fields, and it
 * keeps the SonarCloud `new_duplicated_lines_density` gate green.
 *
 * Constitution refs:
 *   - 1.5 : timestamps rendered in UTC ("Network Observed Time" framing).
 *   - 1.6 : worker-only — no client-side fingerprint code is referenced here.
 */

/** Trimmed non-empty string, or null. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Finite number (accepts numeric strings), or null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Reduce an ISO date-time / date string to YYYY-MM-DD (or null). */
export function asDateOnly(value: unknown): string | null {
  const s = asString(value);
  if (!s) return null;
  const dateOnly = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateOnly) ? dateOnly : null;
}

/**
 * Strip any trailing slashes from a base URL before appending a path.
 *
 * A linear character scan, deliberately not a `/\/+$/` regex: SonarCloud's
 * S5852 ReDoS heuristic flags the `+`-then-`$` regex shape even though this
 * single-character pattern is backtrack-free. The scan is provably linear and
 * carries no backtracking, so it keeps the export Quality Gate green without a
 * per-line analyzer suppression.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return url.slice(0, end);
}

/** Format an ISO timestamp as "Mon DD, YYYY, HH:MM AM/PM UTC" (or em dash). */
export function formatUtc(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return (
    d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
  );
}
