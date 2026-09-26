/**
 * PR #1944 review follow-up — canonical parser/writer for the Drive
 * `org_integrations.account_label` JSON shape.
 *
 * `account_label` for google_drive rows is always either `null` or the JSON
 * object `{ email, channel_token, resource_id }` (see `api/v1/integrations/
 * drive-oauth.ts`'s OAuth-callback write). Four call sites had each grown
 * their own inline `JSON.parse` + optional-chain idiom, disagreeing on
 * null/undefined handling:
 *   - `api/v1/webhooks/drive.ts` (`resolveDriveChannel`) — wants `channel_token`
 *     for the push-notification auth check.
 *   - `api/v1/integrations/drive-oauth.ts` (disconnect flow) — wants
 *     `resource_id` for best-effort remote channel cleanup.
 *   - `integrations/connectors/drive-subscription-renewal.ts` — wants the
 *     whole shape, to preserve `email` across a renewal-driven token rotation.
 *   - `api/connector-health.ts` (`sanitizeAccountLabel`, GH #1836) — wants
 *     `email` only, to strip `channel_token` before it reaches the org
 *     dashboard.
 *
 * `account_label` for OTHER providers (DocuSign, Adobe Sign, …) is a plain
 * display string, never JSON. `parseDriveAccountLabel` returns `null` for any
 * input that isn't a JSON object — covering null/absent input AND a non-Drive
 * plain string — so a caller that also handles non-Drive providers can branch
 * on that single `null` check instead of its own try/catch.
 */

export interface DriveAccountLabel {
  email: string | null;
  channel_token: string | null;
  resource_id: string | null;
  /**
   * SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): the
   * OAuth `client_id` that actually issued this row's refresh token —
   * written once at connect time by `drive-oauth.ts`'s callback from
   * `exchangeCode`'s return value. Public (it rides in the authorize URL,
   * never a secret) — safe to store alongside `email`. `null` for a row
   * connected before this field existed; `drive-changes-runner.ts`'s
   * `loadDriveAccessToken` falls back to the scope-string heuristic
   * (`isDriveLegacyGrant`) ONLY for those pre-existing rows, and logs that
   * fallback. Authoritative once present — a stored client_id is never
   * re-derived from the scope string.
   */
  oauth_client_id: string | null;
}

/**
 * Parse a Drive `account_label` value. Returns `null` when `raw` is
 * null/empty, not valid JSON, or valid JSON that isn't a plain object (covers
 * a non-Drive plain display string, and defends against an array/primitive)
 * — never throws. Unknown/missing keys on an otherwise-valid object resolve
 * to `null` individually rather than failing the whole parse.
 */
export function parseDriveAccountLabel(raw: string | null | undefined): DriveAccountLabel | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    email: typeof obj.email === 'string' ? obj.email : null,
    channel_token: typeof obj.channel_token === 'string' ? obj.channel_token : null,
    resource_id: typeof obj.resource_id === 'string' ? obj.resource_id : null,
    oauth_client_id: typeof obj.oauth_client_id === 'string' ? obj.oauth_client_id : null,
  };
}

/** Serialize the canonical Drive `account_label` shape. Pairs with {@link parseDriveAccountLabel}. */
export function stringifyDriveAccountLabel(label: DriveAccountLabel): string {
  return JSON.stringify(label);
}
