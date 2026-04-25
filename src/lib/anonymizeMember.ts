/**
 * SCRUM-1086 — TS mirror of the SQL `anonymize_member_display_name(text)`
 * helper from migration `0264_get_org_members_public.sql`.
 *
 * The SQL function is the AUTHORITATIVE implementation — it runs on the
 * server inside `get_org_members_public(...)` so private profiles never
 * leak. This TS mirror exists because:
 *   1. The frontend can preview anonymization (e.g. settings page where
 *      a user toggles `is_public_profile` and we show what their public
 *      member entry will look like).
 *   2. CI can unit-test the contract without a live database.
 *
 * If you change either implementation, update both. The behavior contract:
 *
 *   - null / empty / whitespace-only / single-token name → "Anonymous member"
 *   - "First Last" → "F. Last"
 *   - "First Middle Last" → "F. Last" (uses first + last token only)
 *   - case is preserved on the surname; only the leading initial is uppercased
 */
export function anonymizeMemberDisplayName(fullName: string | null | undefined): string {
  if (typeof fullName !== 'string') return 'Anonymous member';
  const trimmed = fullName.trim();
  if (trimmed.length === 0) return 'Anonymous member';
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return 'Anonymous member';
  const initial = parts[0].charAt(0).toUpperCase();
  const last = parts[parts.length - 1];
  return `${initial}. ${last}`;
}
