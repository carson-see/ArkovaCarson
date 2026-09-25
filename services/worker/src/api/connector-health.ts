/**
 * Connector Health Dashboard (SCRUM-1146)
 *
 * Read-side for the connector setup wizard. Returns one row per connector in
 * the catalog with:
 *   - state: connected / degraded / disconnected
 *   - kind: live / demo / gated
 *   - last_event_at: most recent rule event captured from this connector
 *   - last_renewal_at / next_expires_at: from connector_subscriptions
 *   - last_error / health_reason: distinguishes vendor_auth_revoked,
 *     subscription_expiry, processing_failure, none
 *
 * Org scoping is enforced via `.eq('org_id', orgId)` on every query. The
 * caller's `org_id` is never echoed back per CLAUDE.md §6.
 */
import type { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCallerOrgId } from './_org-auth.js';
import { parseDriveAccountLabel } from '../integrations/connectors/drive-account-label.js';
import {
  driveExistingGrantExcessScopes,
  isDriveLegacyGrant,
  DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_PREFIX,
} from '../integrations/oauth/drive.js';
import { DRIVE_FILE_CHANGED_JOB_TYPE } from '../integrations/connectors/drive-artifact-producer.js';
import { driveFolderIds } from '../integrations/connectors/drive-folder-bindings.js';
import { scanAllPages, PageScanError } from '../utils/postgrest-filter.js';

export type ConnectorKind = 'live' | 'demo' | 'gated';
export type ConnectorState = 'connected' | 'degraded' | 'disconnected';
export type HealthReason =
  | 'vendor_auth_revoked'
  // SCRUM-5287 (P1 security, fix-round item 5): the stored `scope` on this
  // integration EXCEEDS `DRIVE_DEFAULT_SCOPES` — a leaked refresh token for
  // this connection can reach more than the connector was ever meant to
  // touch. The OAuth callback now refuses to persist a NEW over-scoped
  // grant (drive-oauth.ts), but that guard is forward-only; an EXISTING row
  // connected before it (or before this connector's own scope allowlist was
  // last narrowed) needs its own visible signal so an admin can see it and
  // force a re-consent. Ranked ABOVE every other Drive reason — an
  // over-permissioned live grant is a standing security exposure, not an
  // operational degradation.
  | 'grant_exceeds_requested'
  // SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): a Drive
  // token refresh failed under BOTH configured OAuth clients with a
  // client-mismatch code (invalid_grant/unauthorized_client/invalid_client)
  // — `drive-changes-runner.ts`'s `loadDriveAccessToken` writes a
  // distinctly-prefixed `last_renewal_error`
  // (`DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_PREFIX`) after exhausting its
  // retry-once-with-the-other-client mitigation. NOT a confidentiality
  // finding (both clients are Arkova's own) — this is an availability
  // signal: the integration cannot refresh at all, which would otherwise
  // surface only as a generic `subscription_expiry` (same underlying
  // column) or, worse, a delayed, unexplained `cursor_stale` 6h later.
  // Ranked directly below `grant_exceeds_requested` (a security finding
  // still outranks it) and above the generic `subscription_expiry` it
  // would otherwise be misread as — see `classify()`.
  | 'oauth_client_mismatch'
  | 'subscription_expiry'
  // P0-2 (2026-09-14 hardening audit): a stuck/410 Drive changes cursor —
  // the exact condition that hid the #2903 class of bug. Distinct from
  // 'processing_failure' (a dispatched rule execution that failed) because
  // this fires even when NO rule execution ever ran — the pipeline stalled
  // upstream of that layer entirely.
  | 'cursor_stale'
  // Task 4 (orchestrator "make this failure loud" review, SCRUM-2903/3661
  // fields-mask incident follow-up): `cursor_stale` above is BLIND to a
  // cursor that has NEVER advanced (`last_token_advanced_at` null) — that
  // null is deliberately non-stale for an integration connected moments ago
  // (see `isDriveCursorStale`'s doc comment), but it is ALSO the exact,
  // indistinguishable state of an integration whose EVERY changes.list call
  // has failed since the day it connected — this incident's own prod shape:
  // 150 failures/day, zero successes, ever, for months, with the dashboard
  // reading 'connected'/'none' the entire time. There is no dedicated
  // "last changes.list error" column to persist a more specific signal
  // without a migration (verified: `org_integrations` has no such column —
  // grepped every migration touching that table; `last_renewal_error` is
  // semantically CHANNEL-RENEWAL-only, already drives `subscription_expiry`,
  // and is cleared on renewal success even while changes.list keeps
  // failing — reusing it would silently HIDE this exact failure the moment
  // a renewal sweep happens to succeed). This reuses the one anchor already
  // read without a migration — `connected_at` — as the staleness clock when
  // the cursor has never moved at all.
  | 'changes_list_never_succeeded'
  // Fix-round item 6 (SCRUM-2903/3661/5094/2330 scope-reality finding): a
  // SPECIFIC fetch-job failure reason — the grant does not cover this file
  // (`drive.file` only allows a file the app created or one selected
  // through Google's real Picker; Arkova's Connectors-page folder browser
  // is a custom component, not the Picker, so a newly-connected org will
  // 403 on ordinary files) or Google's own export size limit. Distinct
  // from the generic `fetch_job_failures` below so the admin view names
  // the ACTUAL cause on the very first customer hitting it, not just "some
  // fetch jobs failed."
  | 'file_access_not_granted'
  // Round-2 fix (fix-round item 2, corrected): a 410/404-style cursor
  // re-bootstrap DISCARDED a real change window — `drive-changes-processor.ts`
  // persists the gap bounds to `audit_events` (`event_type:
  // 'drive_changes_cursor_gap'`), and THIS is the read that actually surfaces
  // it here; before this fix the write existed but nothing ever read it back,
  // so an operator had no product-visible way to learn a gap occurred. Ranked
  // ABOVE the retryable fetch-failure signals below (data that is already
  // gone is worse than a fetch that can simply be retried) but BELOW the
  // signals for a CURRENTLY-broken connector (grant_exceeds_requested,
  // subscription_expiry, changes_list_never_succeeded, cursor_stale) — a gap
  // is, by construction, a PAST event the recovery already completed (the
  // cursor resumed advancing after a fresh token was minted), so an actively
  // broken connector right now is still the more urgent thing to surface
  // first. See `DRIVE_CHANGES_GAP_LOOKBACK_MS` for the bounded lookback
  // window and `DRIVE_HEALTH_PRIORITY` for the exact ranking.
  | 'changes_gap'
  // SCRUM-5287 follow-up (2026-09-21 drive.readonly cutover, task 2): this
  // connection's stored `scope` is exactly (a subset of) the scope set
  // Arkova requested BEFORE the cutover (`DRIVE_LEGACY_REQUESTED_SCOPES` —
  // drive.file + drive.metadata.readonly + drive.activity.readonly +
  // userinfo.email) and is NOT within the current `DRIVE_DEFAULT_SCOPES`
  // (drive.readonly + userinfo.email). This is deliberately NOT the
  // `grant_exceeds_requested` security finding above — it is a legitimate
  // historical grant that simply predates the request Arkova now makes
  // (`isDriveLegacyGrant` in oauth/drive.ts draws that line). It is,
  // however, the ROOT CAUSE of most `file_access_not_granted` symptoms an
  // org on this grant will see (`drive.file` only covers files the app
  // created or the user picked through Google's real Picker — see
  // oauth/drive.ts's doc comment on `DRIVE_DEFAULT_SCOPES`), so it is
  // checked, and ranked, ABOVE `file_access_not_granted` below — the admin
  // view should name the actual, fixable cause (reconnect) rather than the
  // downstream symptom. It does NOT rank above `changes_gap` or the
  // currently-broken-connector signals: this grant still lists changes
  // (drive.metadata.readonly is retained), so those are independent,
  // more urgent failures when they co-occur.
  | 'reconnect_required_scope_change'
  // P0-2: the `google_drive.file_changed` job_queue drain has failed/dead
  // rows — the document-fetch half of the pipeline that
  // organization_rule_executions cannot see (rule dispatch and document
  // fetch are two independent enqueues with independent failure modes).
  | 'fetch_job_failures'
  | 'processing_failure'
  | 'none';

export interface ConnectorCatalogEntry {
  id: string;
  label: string;
  kind: ConnectorKind;
  // The set of `vendor` strings the worker emits on `organization_rule_events`
  // for this connector. Microsoft Graph catalog entry covers BOTH SharePoint
  // and OneDrive (they share one OAuth integration but emit two distinct
  // vendor strings — see `adapters.ts:adaptMicrosoftGraph`).
  vendor_event_sources: readonly string[];
  description: string;
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: 'docusign',
    label: 'DocuSign',
    kind: 'live',
    vendor_event_sources: ['docusign'],
    description: 'Receive completed envelopes via DocuSign Connect.',
  },
  {
    // Catalog DEFAULT is 'gated', and it is overridden to 'live' per request by
    // `resolveConnectorKind()` below — never statically.
    //
    // History: PR #2519 corrected this from a hardcoded 'live' because Adobe
    // Sign had no connect flow at all and 100% of prod traffic to
    // /webhooks/adobe-sign returned 503; claiming 'live' asserted a capability
    // we did not hold (CLAUDE.md §1.13 R-7). The connect flow now exists
    // (`api/v1/integrations/adobe-sign-oauth.ts`), but existing is not the same
    // as working: prod still carries no Adobe credential and the flow is behind
    // a default-off flag. A static flip back to 'live' would re-assert exactly
    // the claim #2519 removed — so the kind is DERIVED from whether this
    // deployment can actually complete a connection.
    id: 'adobe_sign',
    label: 'Adobe Sign',
    kind: 'gated',
    vendor_event_sources: ['adobe_sign'],
    description: 'Receive completed agreements via Adobe Sign webhooks.',
  },
  {
    id: 'google_drive',
    label: 'Google Drive',
    kind: 'live',
    vendor_event_sources: ['google_drive'],
    description: 'Watch folders for added or modified files.',
  },
  {
    id: 'microsoft_graph',
    label: 'Microsoft 365 (SharePoint / OneDrive)',
    kind: 'live',
    vendor_event_sources: ['sharepoint', 'onedrive'],
    description: 'Watch SharePoint sites and OneDrive folders for changes.',
  },
  {
    id: 'demo',
    label: 'Demo events',
    kind: 'demo',
    vendor_event_sources: [],
    description: 'Inject sample events end-to-end without external accounts.',
  },
  {
    id: 'veremark',
    label: 'Veremark',
    kind: 'gated',
    vendor_event_sources: ['veremark'],
    description: 'Background-check connector — vendor agreement required.',
  },
  {
    id: 'checkr',
    label: 'Checkr',
    kind: 'gated',
    vendor_event_sources: ['checkr'],
    description: 'Background-check connector — vendor agreement required.',
  },
];

/**
 * Per-request connector kind.
 *
 * `adobe_sign` is the only entry whose kind is environment-dependent: it is
 * 'live' exactly when this deployment can actually complete a connection —
 * the connect flow is enabled AND an Adobe application's credentials are
 * present. Anything less is 'gated', which renders the request-access CTA
 * rather than implying a working connection (CLAUDE.md §1.13 R-7 / §1.5:
 * state what is measured, not what is hoped for).
 *
 * Deriving this instead of hardcoding it means the dashboard cannot drift from
 * reality in either direction: it stops claiming 'live' the moment credentials
 * are removed, and starts claiming it the moment they are provisioned, with no
 * code change and no chance of a stale assertion sitting in the catalog.
 *
 * Note this measures CONFIGURATION, not a live handshake with Adobe. A wrong
 * secret or an account tier missing `webhook_write` still reads 'live' here;
 * that failure surfaces at connect time as `webhook_registration_failed`.
 */
export function resolveConnectorKind(
  entry: ConnectorCatalogEntry,
  env: NodeJS.ProcessEnv = process.env,
): ConnectorKind {
  if (entry.id !== 'adobe_sign') return entry.kind;
  const connectEnabled = env.ENABLE_ADOBE_SIGN_OAUTH === 'true';
  const hasCredentials = Boolean(env.ADOBE_SIGN_CLIENT_ID?.trim()) && Boolean(env.ADOBE_SIGN_CLIENT_SECRET?.trim());
  return connectEnabled && hasCredentials ? 'live' : 'gated';
}

interface IntegrationRow {
  id: string;
  provider: string;
  account_label: string | null;
  connected_at: string | null;
  revoked_at: string | null;
  // PR #1944 review round 3: these four columns are how GH #1835's renewal
  // job (drive-subscription-renewal.ts) and the original OAuth callback
  // (drive-oauth.ts) actually track Drive's push-channel health — NOT
  // `connector_subscriptions` (see the note on SubscriptionRow below).
  // Selected for every provider (they live on the shared org_integrations
  // table) but only ACTED on for google_drive, in deriveDriveWatchHealth().
  subscription_expires_at: string | null;
  last_renewal_error: string | null;
  last_renewal_at: string | null;
  // P0-2: written by `advancePageToken` (drive-changes-processor.ts) on
  // every SUCCESSFUL page-advance — NOT touched by routine channel renewal
  // (only a null->bootstrap renewal sets it). A value that stops moving
  // while the channel is otherwise healthy is exactly the #2903-class
  // stuck-cursor symptom the audit found invisible to this dashboard.
  last_token_advanced_at: string | null;
  // SCRUM-5287 (P1 security fix-round item 5): the space-delimited scope
  // string Google actually granted at connect time, persisted verbatim by
  // drive-oauth.ts's callback. Selected for every provider but only ACTED
  // on for google_drive, in classify() — checked against
  // `driveExistingGrantExcessScopes` (the UNION-bound classifier — an
  // EXISTING row legitimately carrying the pre-cutover scope set is not an
  // over-grant; see that function's doc comment) so an EXISTING over-scoped
  // row (the callback guard only protects NEW connections going forward) is
  // still visible in the admin view.
  scope: string | null;
}

/**
 * PR #1944 review round 3: `connector_subscriptions` is real and IS the
 * source of truth for `microsoft_graph` (`microsoft-graph.ts` writes it).
 * It is NOT for `google_drive` — neither `drive-oauth.ts` nor
 * `drive-subscription-renewal.ts` (GH #1835) has ever written a
 * `google_drive` row into it. Left unfixed, `subscription` below is always
 * `undefined` for Drive, `classify()` always falls through to
 * `{state:'connected', reason:'none'}`, and `next_expires_at`/
 * `last_renewal_at` are always `null` — no matter how badly renewal is
 * failing or how high `watch_renewal_failure_count` climbs. See
 * `deriveDriveWatchHealth()` below for the google_drive-specific fix
 * (reads `org_integrations` directly instead).
 */
interface SubscriptionRow {
  provider: 'google_drive' | 'microsoft_graph';
  status: string;
  // Nullable so a never-bootstrapped Drive connection (no
  // subscription_expires_at yet) round-trips to next_expires_at: null below,
  // not an empty string (`?? null` only catches null/undefined, not '').
  expires_at: string | null;
  last_renewed_at: string | null;
  last_renewal_error: string | null;
}

/**
 * Synthesizes a `SubscriptionRow`-shaped view of a google_drive
 * `org_integrations` row from the columns `drive-oauth.ts` and
 * `drive-subscription-renewal.ts` actually maintain. `status: 'degraded'`
 * whenever `last_renewal_error` is non-null — that column is cleared to
 * `null` on every SUCCESSFUL renewal (`recordSetback`/the success branch in
 * `drive-subscription-renewal.ts`) and set on every failure, including the
 * original OAuth-callback bootstrap failure path (`drive-oauth.ts`'s
 * `watchColumns` failure arm) — so a non-null value here is a real,
 * current-as-of-last-attempt signal, not a stale one-time flag.
 */
function deriveDriveWatchHealth(integration: IntegrationRow): SubscriptionRow {
  return {
    provider: 'google_drive',
    status: integration.last_renewal_error ? 'degraded' : 'active',
    expires_at: integration.subscription_expires_at,
    last_renewed_at: integration.last_renewal_at,
    last_renewal_error: integration.last_renewal_error,
  };
}

interface RuleEventRow {
  vendor: string | null;
  created_at: string;
}

interface FailedExecutionRow {
  trigger_event_id: string;
  completed_at: string | null;
  error: string | null;
}

interface PerVendorFailure {
  vendor: string;
  error: string | null;
  completed_at: string | null;
}

interface ConnectorHealth {
  id: string;
  label: string;
  kind: ConnectorKind;
  state: ConnectorState;
  health_reason: HealthReason | null;
  account_label: string | null;
  last_event_at: string | null;
  last_renewal_at: string | null;
  next_expires_at: string | null;
  last_error: string | null;
}

/**
 * GH #1836 (SECURITY): `account_label` for some providers (currently only
 * google_drive) is a JSON blob that carries the push-channel `channel_token`
 * — a secret used to authenticate inbound webhook deliveries — alongside a
 * human-readable email. This dashboard read is scoped to the org's own
 * authenticated members (`.eq('org_id', orgId)` above), but the token has no
 * legitimate reason to ever reach a frontend response regardless (treat it as
 * a secret: never log it, never return it — same rule the connect flow
 * follows in drive-oauth.ts). Strip channel_token (and the opaque
 * resource_id) before surfacing account_label, keeping only the
 * human-readable email when present. Providers whose account_label is a
 * plain display string (DocuSign, Adobe Sign, …) are untouched —
 * `parseDriveAccountLabel` returns `null` for a non-Drive-shaped string, so
 * it passes through raw (PR #1944 review: this used to be an inline
 * JSON.parse copy — now routed through the one canonical parser shared with
 * `drive-subscription-renewal.ts`, `webhooks/drive.ts`, and
 * `drive-oauth.ts`'s disconnect flow).
 */
function sanitizeAccountLabel(raw: string | null): string | null {
  const parsed = parseDriveAccountLabel(raw);
  if (parsed) return parsed.email;
  return raw;
}

async function safeFetch<T>(promise: Promise<{ data: T | null; error: unknown }>, fallback: T): Promise<T> {
  try {
    const { data, error } = await promise;
    if (error) {
      logger.warn({ error }, 'connector health: query failed — using fallback');
      return fallback;
    }
    return data ?? fallback;
  } catch (err) {
    logger.warn({ error: err }, 'connector health: query threw — using fallback');
    return fallback;
  }
}

async function loadFailuresByVendor(
  orgId: string,
  failedExecutions: FailedExecutionRow[],
): Promise<Map<string, PerVendorFailure>> {
  const out = new Map<string, PerVendorFailure>();
  if (failedExecutions.length === 0) return out;
  const triggerEventIds = [...new Set(failedExecutions.map((e) => e.trigger_event_id))];
  if (triggerEventIds.length === 0) return out;
  const events = await safeFetch<Array<{ id: string; vendor: string | null }>>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('organization_rule_events')
      .select('id, vendor')
      .eq('org_id', orgId)
      .in('id', triggerEventIds),
    [],
  );
  const vendorById = new Map<string, string | null>();
  for (const e of events) vendorById.set(e.id, e.vendor);
  for (const exec of failedExecutions) {
    const vendor = vendorById.get(exec.trigger_event_id);
    if (!vendor) continue;
    if (!out.has(vendor)) {
      out.set(vendor, { vendor, error: exec.error, completed_at: exec.completed_at });
    }
  }
  return out;
}

/**
 * P0-2: default staleness threshold for the Drive changes cursor. Webhooks
 * fire on any change, so a healthy, rule-bound integration should advance
 * well inside this window during normal usage; 6h balances "loud enough to
 * matter" against "quiet orgs don't false-page."
 */
export const DRIVE_CURSOR_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Pure staleness check — P0-2. `null` (never-bootstrapped cursor) is
 * deliberately NOT stale here: that is the P0-1 / pre-#2903-fix bootstrap
 * gap, a different, already-tracked defect this PR does not fix (see the
 * hardening audit's P0-1 finding). This signal is specifically "the cursor
 * WAS advancing and then stopped."
 */
export function isDriveCursorStale(
  lastTokenAdvancedAt: string | null,
  now: Date = new Date(),
  thresholdMs: number = DRIVE_CURSOR_STALE_THRESHOLD_MS,
): boolean {
  if (!lastTokenAdvancedAt) return false;
  const advancedAtMs = Date.parse(lastTokenAdvancedAt);
  if (!Number.isFinite(advancedAtMs)) return false;
  return now.getTime() - advancedAtMs > thresholdMs;
}

/**
 * Task 4 gap fix — see the `changes_list_never_succeeded` doc comment on
 * `HealthReason`. `isDriveCursorStale` is deliberately blind to a NEVER-
 * advanced cursor; this covers exactly that case using `connected_at` (a
 * field already selected by the health query, so no migration is needed) as
 * the staleness clock instead. Returns false whenever the cursor HAS
 * advanced at least once — that is `isDriveCursorStale`'s case, not this
 * one; the two are mutually exclusive by construction.
 */
export function hasDriveChangesNeverSucceeded(
  lastTokenAdvancedAt: string | null,
  connectedAt: string | null,
  now: Date = new Date(),
  thresholdMs: number = DRIVE_CURSOR_STALE_THRESHOLD_MS,
): boolean {
  if (lastTokenAdvancedAt) return false;
  if (!connectedAt) return false;
  const connectedAtMs = Date.parse(connectedAt);
  if (!Number.isFinite(connectedAtMs)) return false;
  return now.getTime() - connectedAtMs > thresholdMs;
}

/**
 * SCRUM-5287 (P1 security, fix-round item 5): `driveExistingGrantExcessScopes`
 * returns `[]` for "within bounds" — this adapts that to `undefined` so
 * `DriveHealthSignals.grantExceedsRequested` reads as a clean "is there a
 * finding at all" check (`if (driveSignals?.grantExceedsRequested)`)
 * without every caller re-checking `.length > 0`. Deliberately uses the
 * UNION-bound classifier, not the narrower `driveGrantExcessScopes` (that
 * one is for OAuth-callback acceptance of a BRAND NEW grant, not for
 * classifying an existing row — see its doc comment in oauth/drive.ts).
 */
function excessScopesOrUndefined(storedScope: string | null): string[] | undefined {
  const excess = driveExistingGrantExcessScopes(storedScope);
  return excess.length > 0 ? excess : undefined;
}

/**
 * SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): recognizes
 * `loadDriveAccessToken`'s distinctly-prefixed `last_renewal_error` (see
 * `DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_PREFIX`'s doc comment in oauth/drive.ts
 * for why the constant lives there, not in drive-changes-runner.ts).
 * Returns the message itself when it matches (already bounded — no token,
 * no scope value, just a fixed prefix + an OAuth error CODE), `undefined`
 * otherwise so `driveSignals.oauthClientMismatch` reads as a clean
 * "is there a finding" check.
 */
function oauthClientMismatchOrUndefined(lastRenewalError: string | null): string | undefined {
  return lastRenewalError?.startsWith(DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_PREFIX) ? lastRenewalError : undefined;
}

/**
 * Round-2 fix (item 2): the exact `event_type` string
 * `drive-changes-runner.ts`'s `recordCursorGap` writes — must stay in sync
 * with that literal (no shared constant exists between the two modules
 * because `connector-health.ts` must not import worker runtime code that
 * pulls in `db`/`config` init at a different layer; this is a deliberate,
 * narrow string duplication, guarded by the cross-file test coverage in
 * both `drive-changes-runner.test.ts` and this file).
 */
const DRIVE_CHANGES_GAP_EVENT_TYPE = 'drive_changes_cursor_gap';

/**
 * Round-2 fix (item 2): how far back to look for a gap event. A gap is a
 * one-time, already-recovered-from event (the cursor resumed advancing once
 * the fresh token landed) — unlike `cursor_stale`/`changes_list_never_
 * succeeded`, which re-evaluate against the CURRENT clock on every request,
 * a gap that happened 3 weeks ago and was long since superseded by healthy
 * traffic is stale information, not an active finding. 7 days balances
 * "long enough that an admin checking in weekly still sees it" against "an
 * old, cold incident doesn't sit in the dashboard forever."
 */
export const DRIVE_CHANGES_GAP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

interface DriveGapAuditRow {
  target_id: string | null;
  created_at: string;
  details: string | null;
}

/** Round-2 fix (item 2): the two bounds a `changes_gap` signal carries. */
interface DriveGapSignal {
  gapStart: string | null;
  gapEnd: string | null;
}

/**
 * Round-2 fix (item 2): parses the bounded, PII-free `details` JSON
 * `recordCursorGap` writes (`{gap_start, gap_end, reason}` — see
 * `drive-changes-runner.ts`). Deliberately extracts ONLY `gap_start`/
 * `gap_end` as strings — never spreads or forwards the parsed object, so an
 * unexpected extra key in a row (this table is append-only; a future
 * writer could add one) can never reach `lastError` unnoticed. Never
 * throws: a malformed/foreign-shaped `details` value degrades to "a gap
 * happened, bounds unknown" rather than losing the signal entirely or
 * crashing the health endpoint.
 */
function parseDriveGapDetails(details: string | null): DriveGapSignal {
  if (!details) return { gapStart: null, gapEnd: null };
  try {
    const parsed: unknown = JSON.parse(details);
    if (!parsed || typeof parsed !== 'object') return { gapStart: null, gapEnd: null };
    const record = parsed as Record<string, unknown>;
    return {
      gapStart: typeof record.gap_start === 'string' ? record.gap_start : null,
      gapEnd: typeof record.gap_end === 'string' ? record.gap_end : null,
    };
  } catch {
    return { gapStart: null, gapEnd: null };
  }
}

/**
 * Round-2 fix (item 2): reduces the (already org_id + event_type + window
 * scoped) audit_events rows to the MOST RECENT gap per integration —
 * `target_id` is `org_integrations.id`. Rows are expected pre-sorted
 * `created_at DESC` by the caller's query (matches `lastEventByVendor`'s
 * existing "first occurrence wins" pattern in this same file), so this is a
 * single pass, not a sort.
 */
function latestDriveGapByIntegrationId(rows: DriveGapAuditRow[]): Map<string, DriveGapSignal> {
  const out = new Map<string, DriveGapSignal>();
  for (const row of rows) {
    if (!row.target_id) continue;
    if (out.has(row.target_id)) continue;
    out.set(row.target_id, parseDriveGapDetails(row.details));
  }
  return out;
}

interface DriveHealthSignals {
  /**
   * True only when: the cursor has not advanced past the threshold, AND the
   * org has at least one enabled WORKSPACE_FILE_MODIFIED rule bound to Drive
   * (otherwise a cursor that never advances is EXPECTED — nothing is
   * watching, so nothing should ever call advancePageToken — and flagging it
   * would be a false positive, not a finding).
   */
  cursorStale: boolean;
  /**
   * True only when: the cursor has NEVER advanced (null) past the threshold
   * since connection, AND the org has at least one enabled Drive rule. Same
   * false-positive guard as `cursorStale`, for the never-bootstrapped case
   * `cursorStale` cannot see — see the `changes_list_never_succeeded`
   * `HealthReason` doc comment.
   */
  neverSucceeded: boolean;
  /** Count of failed/dead google_drive.file_changed job_queue rows for this org. */
  fetchJobFailureCount: number;
  /**
   * Fix-round item 6: SUBSET of `fetchJobFailureCount` whose `last_error`
   * matches a `DriveFileAccessError`/`DriveExportSizeLimitError` message —
   * see `HealthReason`'s `file_access_not_granted` doc comment.
   */
  fileAccessDeniedCount: number;
  /**
   * SCRUM-5287 (P1 security, fix-round item 5): non-empty array of excess
   * scope names (`driveExistingGrantExcessScopes(integration.scope)`) when
   * the stored grant exceeds `DRIVE_DEFAULT_SCOPES` ∪
   * `DRIVE_LEGACY_REQUESTED_SCOPES`; `undefined` when it does not. No
   * false-positive guard needed here (unlike cursorStale/neverSucceeded) —
   * an over-grant is a real finding regardless of whether any rule is
   * enabled.
   */
  grantExceedsRequested?: string[];
  /**
   * SCRUM-5287 follow-up (2026-09-21 drive.readonly cutover, task 2): true
   * when `isDriveLegacyGrant(integration.scope)` — the stored grant is
   * (a subset of) the PRE-cutover requested set and not within the current
   * one. Mutually exclusive with `grantExceedsRequested` by construction
   * (see `isDriveLegacyGrant`'s doc comment in oauth/drive.ts).
   */
  legacyGrant?: boolean;
  /**
   * SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): set to
   * the bounded `last_renewal_error` STRING when it carries the
   * `DRIVE_OAUTH_CLIENT_MISMATCH_ERROR_PREFIX` prefix `loadDriveAccessToken`
   * writes after exhausting its retry-once mitigation; `undefined`
   * otherwise. No false-positive guard needed (like `grantExceedsRequested`)
   * — this is a real, current-as-of-last-attempt failure regardless of
   * whether any rule is enabled.
   */
  oauthClientMismatch?: string;
  /**
   * Round-2 fix (item 2): set when a `drive_changes_cursor_gap` audit_events
   * row exists for this integration within `DRIVE_CHANGES_GAP_LOOKBACK_MS`.
   * No enabled-rule guard (unlike cursorStale/neverSucceeded) — a gap
   * already happened regardless of whether a rule is enabled right now.
   */
  gap?: DriveGapSignal;
}

function classify(
  entry: ConnectorCatalogEntry,
  integration: IntegrationRow | undefined,
  subscription: SubscriptionRow | undefined,
  lastFailedExec: PerVendorFailure | undefined,
  driveSignals?: DriveHealthSignals,
): { state: ConnectorState; reason: HealthReason | null; lastError: string | null } {
  // Demo connector is always connected — its lifecycle is the dispatcher itself.
  if (entry.kind === 'demo') {
    return { state: 'connected', reason: null, lastError: null };
  }
  // Gated (vendor agreement pending) connectors stay disconnected with a
  // null reason so the wizard can render a "request access" CTA.
  if (entry.kind === 'gated' && !integration) {
    return { state: 'disconnected', reason: null, lastError: null };
  }
  if (!integration) {
    return { state: 'disconnected', reason: null, lastError: null };
  }
  if (integration.revoked_at) {
    return { state: 'disconnected', reason: 'vendor_auth_revoked', lastError: null };
  }
  // SCRUM-5287 (P1 security, fix-round item 5): checked BEFORE every other
  // reason — a security exposure on a live, active grant outranks an
  // operational degradation. Only computed for google_drive (driveSignals
  // is undefined for every other connector).
  if (driveSignals?.grantExceedsRequested) {
    return {
      state: 'degraded',
      reason: 'grant_exceeds_requested',
      lastError: `Granted OAuth scope exceeds what this connection requested: ${driveSignals.grantExceedsRequested.join(', ')}`,
    };
  }
  // SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): checked
  // BEFORE the generic subscription_expiry check below — both read
  // `last_renewal_error`, but a client-mismatch failure is a MORE SPECIFIC,
  // more actionable diagnosis of that same column than "the subscription
  // needs renewal." Only computed for google_drive, same scoping as the
  // check above (driveSignals is undefined for every other connector).
  if (driveSignals?.oauthClientMismatch) {
    return {
      state: 'degraded',
      reason: 'oauth_client_mismatch',
      lastError: driveSignals.oauthClientMismatch,
    };
  }
  if (subscription?.status === 'degraded') {
    return {
      state: 'degraded',
      reason: 'subscription_expiry',
      lastError: subscription.last_renewal_error ?? null,
    };
  }
  // P0-2 / Task 4: checked AFTER vendor_auth_revoked / subscription_expiry
  // (a broken channel already explains a stalled/never-advancing cursor —
  // that is not new information) but BEFORE the rule-execution-derived
  // 'processing_failure' below, since all three new signals catch failures
  // a rule execution never even got dispatched for. `neverSucceeded` is
  // checked first: it is the stronger claim ("this has NEVER once worked
  // since connecting", vs. cursorStale's "this worked before and stopped")
  // and the two are mutually exclusive by construction (see
  // hasDriveChangesNeverSucceeded's doc comment).
  if (driveSignals?.neverSucceeded) {
    const hours = Math.round(DRIVE_CURSOR_STALE_THRESHOLD_MS / (60 * 60 * 1000));
    return {
      state: 'degraded',
      reason: 'changes_list_never_succeeded',
      lastError: `Drive changes.list has never succeeded on this connection in over ${hours}h despite an enabled rule — Drive may be rejecting our requests`,
    };
  }
  if (driveSignals?.cursorStale) {
    const hours = Math.round(DRIVE_CURSOR_STALE_THRESHOLD_MS / (60 * 60 * 1000));
    return {
      state: 'degraded',
      reason: 'cursor_stale',
      lastError: `Drive changes cursor has not advanced in over ${hours}h despite an enabled rule and a healthy channel`,
    };
  }
  // Round-2 fix (item 2): checked AFTER every CURRENTLY-broken-connector
  // signal above (a gap is a past, already-recovered-from event — see the
  // `changes_gap` HealthReason doc comment) but BEFORE the retryable
  // fetch-failure signals below (data that is already gone outranks a fetch
  // that can simply be retried).
  if (driveSignals?.gap) {
    const { gapStart, gapEnd } = driveSignals.gap;
    const bounds = gapStart
      ? `between ${gapStart} and ${gapEnd ?? 'the recovery'}`
      : 'in a window whose exact bounds were not recorded';
    return {
      state: 'degraded',
      reason: 'changes_gap',
      lastError: `Drive changes were missed ${bounds} — a cursor re-bootstrap could not recover them (Drive does not allow enumerating a window after the token expires)`,
    };
  }
  // SCRUM-5287 follow-up (2026-09-21 cutover, task 2): checked BEFORE
  // `file_access_not_granted` — a legacy (pre-cutover) grant is the actual,
  // fixable CAUSE of most file_access_not_granted symptoms an org on it
  // will see; the admin view should name that, not the downstream symptom.
  // See the `reconnect_required_scope_change` HealthReason doc comment for
  // the full precedence rationale.
  if (driveSignals?.legacyGrant) {
    return {
      state: 'degraded',
      reason: 'reconnect_required_scope_change',
      lastError: 'This connection was authorized under a scope set Arkova no longer requests. '
        + 'Reconnect Google Drive to grant read access so file fetches and full folder browsing keep working.',
    };
  }
  // Fix-round item 6: checked BEFORE the generic fetch_job_failures below —
  // a specific, actionable cause outranks "some fetch jobs failed" once we
  // actually know why.
  if (driveSignals && driveSignals.fileAccessDeniedCount > 0) {
    return {
      state: 'degraded',
      reason: 'file_access_not_granted',
      lastError: `${driveSignals.fileAccessDeniedCount} file(s) could not be fetched — the connected account's grant does not cover them (re-consent required), or exceeded Google's export size limit`,
    };
  }
  if (driveSignals && driveSignals.fetchJobFailureCount > 0) {
    return {
      state: 'degraded',
      reason: 'fetch_job_failures',
      lastError: `${driveSignals.fetchJobFailureCount} google_drive.file_changed job(s) failed or dead-lettered`,
    };
  }
  if (lastFailedExec) {
    return {
      state: 'degraded',
      reason: 'processing_failure',
      lastError: lastFailedExec.error,
    };
  }
  return { state: 'connected', reason: 'none', lastError: null };
}

// A provider card summarizes every active Google account. Preserve classify's
// failure precedence across accounts; a healthy/revoked row must not hide an
// active account's failure. Equal reasons use newest connection then stable ID.
const DRIVE_HEALTH_PRIORITY: Record<HealthReason, number> = {
  grant_exceeds_requested: 10,
  // SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding): below the
  // security finding above, but ABOVE subscription_expiry — both read
  // last_renewal_error, and a client-mismatch failure is the more specific,
  // more actionable diagnosis of that same column. See both HealthReason
  // doc comments.
  oauth_client_mismatch: 9,
  subscription_expiry: 8, changes_list_never_succeeded: 7, cursor_stale: 6,
  // Round-2 fix (item 2): changes_gap sits BELOW every currently-broken-
  // connector signal above (a gap is a past, already-recovered-from event)
  // but ABOVE the retryable fetch-failure signals below (lost data outranks
  // a fetch that can simply be retried) — see the HealthReason doc comment.
  changes_gap: 5,
  // SCRUM-5287 follow-up (2026-09-21 cutover, task 2): below changes_gap
  // (this grant still lists changes; a gap is an independent, more urgent
  // failure when it co-occurs) but ABOVE file_access_not_granted (a legacy
  // grant is that symptom's actual cause) — see both HealthReason doc
  // comments.
  reconnect_required_scope_change: 4,
  file_access_not_granted: 3, fetch_job_failures: 2, processing_failure: 1,
  vendor_auth_revoked: 0, none: 0,
};

function compareDriveHealth(
  a: { integration: IntegrationRow; reason: HealthReason | null },
  b: { integration: IntegrationRow; reason: HealthReason | null },
): number {
  const severity = (DRIVE_HEALTH_PRIORITY[b.reason ?? 'none'] ?? 0)
    - (DRIVE_HEALTH_PRIORITY[a.reason ?? 'none'] ?? 0);
  if (severity) return severity;
  const timestamp = (value: string | null) => {
    const parsed = Date.parse(value ?? '');
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  };
  const left = timestamp(a.integration.connected_at);
  const right = timestamp(b.integration.connected_at);
  if (left !== right) return left > right ? -1 : 1;
  return a.integration.id.localeCompare(b.integration.id);
}

export async function handleConnectorHealth(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }

  let integrations: IntegrationRow[];
  let driveRuleRows: Array<{ trigger_config: unknown }>;
  try {
    // Complete means an empty terminal page, not a short PostgREST response.
    // These are request budgets, not a claimed account/rule product limit.
    const signal = AbortSignal.timeout(5_000);
    const budget = { maxRows: 5_000, maxPages: 20 };
    const [integrationScan, ruleScan] = await Promise.all([
      scanAllPages<IntegrationRow>((offset, limit) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).from('org_integrations')
          .select('id, provider, account_label, connected_at, revoked_at, subscription_expires_at, last_renewal_error, last_renewal_at, last_token_advanced_at, scope')
          .eq('org_id', orgId)
          .order('created_at', { ascending: true }).order('id', { ascending: true })
          .range(offset, offset + limit - 1).abortSignal(signal), budget),
      scanAllPages<{ trigger_config: unknown }>((offset, limit) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).from('organization_rules').select('trigger_config')
          .eq('org_id', orgId).eq('trigger_type', 'WORKSPACE_FILE_MODIFIED').eq('enabled', true)
          .order('id', { ascending: true }).range(offset, offset + limit - 1).abortSignal(signal), budget),
    ]);
    if (integrationScan.status !== 'complete' || ruleScan.status !== 'complete') throw new Error('Incomplete health inventory');
    integrations = integrationScan.rows;
    driveRuleRows = ruleScan.rows;
  } catch (error) {
    logger.error({ pgCode: error instanceof PageScanError ? error.pgCode : null }, 'Connector health inventory unavailable');
    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    res.status(503).json({ error: { code: 'connector_health_unavailable', message: 'Unable to load complete connector health' } });
    return;
  }

  const [subscriptions, recentEvents, recentExecutions, driveFetchFailureRows, driveGapRows] = await Promise.all([
    safeFetch<SubscriptionRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('connector_subscriptions')
        .select('provider, status, expires_at, last_renewed_at, last_renewal_error')
        .eq('org_id', orgId),
      [],
    ),
    safeFetch<RuleEventRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('organization_rule_events')
        .select('vendor, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(50),
      [],
    ),
    safeFetch<FailedExecutionRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('organization_rule_executions')
        .select('trigger_event_id, completed_at, error')
        .eq('org_id', orgId)
        .in('status', ['FAILED', 'DLQ'])
        .order('completed_at', { ascending: false })
        .limit(50),
      [],
    ),
    // P0-2: recent failed/dead google_drive.file_changed job_queue rows for
    // this org. job_queue has no org_id column — org_id lives on the JSONB
    // payload every enqueuer writes (DriveFileChangedJobPayload), so this
    // filters on the embedded field via PostgREST's `column->>key` syntax.
    // `last_error` (fix-round item 6) — bounded, PII-scrubbed by
    // `processNextJob`'s failure path, never document bytes — is read so
    // `file_access_not_granted` can be distinguished from an ordinary
    // fetch-job failure below.
    safeFetch<Array<{ status: string; last_error: string | null }>>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('job_queue')
        .select('status, last_error')
        .eq('type', DRIVE_FILE_CHANGED_JOB_TYPE)
        .eq('payload->>org_id', orgId)
        .in('status', ['failed', 'dead'])
        .limit(50),
      [],
    ),
    // Round-2 fix (item 2): gap-visibility read. `.eq('org_id', orgId)`
    // uses `idx_audit_events_org_id` (btree, WHERE org_id IS NOT NULL) —
    // this is a small, per-org-selective index scan, not a seq scan on the
    // full audit_events table; `.eq('event_type', ...)` further narrows
    // within that org-scoped set (also independently indexed via
    // `idx_audit_events_event_type`). `target_id` is filtered in JS
    // (`latestDriveGapByIntegrationId`) rather than a DB-side `.in()`,
    // matching this file's existing `loadFailuresByVendor` pattern of
    // "fetch a small, already-bounded rowset, correlate in JS" — the org
    // scoping alone already bounds this to a handful of rows for any real
    // org, so a second filter dimension buys nothing worth the extra query
    // complexity. Ordered newest-first + limited so a runaway sequence of
    // gaps on one integration cannot starve visibility into a DIFFERENT
    // integration's gap.
    safeFetch<DriveGapAuditRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('audit_events')
        .select('target_id, created_at, details')
        .eq('org_id', orgId)
        .eq('event_type', DRIVE_CHANGES_GAP_EVENT_TYPE)
        .gte('created_at', new Date(Date.now() - DRIVE_CHANGES_GAP_LOOKBACK_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(50),
      [],
    ),
  ]);

  const hasEnabledDriveRules = driveRuleRows.some((row) => driveFolderIds(row.trigger_config).length > 0);
  const driveFetchJobFailureCount = driveFetchFailureRows.length;
  // Fix-round item 6: a SUBSET of those failures whose recorded reason is
  // specifically "the grant does not cover this file" (DriveFileAccessError)
  // or "Google's export size limit" (DriveExportSizeLimitError) — see
  // oauth/drive.ts's doc comments on both classes. Message-prefix match on
  // `last_error` is the only signal available without a dedicated column;
  // `processDriveFileChangedJob`'s error path already writes `err.message`
  // verbatim into it via the shared job-queue failure handler.
  //
  // The alternation is grouped and BOTH branches are prefix-anchored
  // (SonarCloud typescript:S5850 — an ungrouped `^A|B` binds `^` to `A`
  // only, so `B` used to match "export size limit" ANYWHERE in the
  // string, misclassifying any unrelated last_error that happened to
  // mention that phrase mid-sentence as file_access_not_granted). The
  // trailing `\b` after "denied" matches `origin/main`'s independent fix
  // of the same S5850 finding byte-for-byte — this PR's branch is 31
  // commits behind main and still carried the pre-fix regex; kept
  // identical here (rather than a merely-equivalent variant) so a future
  // rebase of this branch onto main produces no conflict on this line.
  const DRIVE_FILE_ACCESS_DENIED_ERROR_PATTERN =
    /^(?:Drive file access denied\b|Drive file export exceeds Google's export size limit)/i;
  const driveFileAccessDeniedCount = driveFetchFailureRows.filter(
    (row) => typeof row.last_error === 'string' && DRIVE_FILE_ACCESS_DENIED_ERROR_PATTERN.test(row.last_error),
  ).length;
  // Round-2 fix (item 2): keyed by org_integrations.id — the SAME id every
  // driveSignals construction below already keys off of (integration.id /
  // row.id), so this is a plain map lookup per connection, no re-query.
  const driveGapByIntegrationId = latestDriveGapByIntegrationId(driveGapRows);

  const integrationByProvider = new Map<string, IntegrationRow>();
  for (const row of integrations) integrationByProvider.set(row.provider, row);

  const subscriptionByProvider = new Map<string, SubscriptionRow>();
  for (const row of subscriptions) subscriptionByProvider.set(row.provider, row);

  const lastEventByVendor = new Map<string, string>();
  for (const ev of recentEvents) {
    if (!ev.vendor) continue;
    if (!lastEventByVendor.has(ev.vendor)) lastEventByVendor.set(ev.vendor, ev.created_at);
  }

  // Failures are correlated to a vendor by joining failed executions to
  // the originating rule event (no FK between executions.trigger_event_id
  // text and rule_events.id uuid; we resolve in JS). Without this join we
  // could mis-attribute one connector's failures to every connector.
  const failureByVendor = await loadFailuresByVendor(orgId, recentExecutions);

  const driveConnections = integrations.filter((row) => row.provider === 'google_drive');
  const activeDriveConnections = driveConnections.filter((row) => !row.revoked_at);
  const consideredDriveConnections = activeDriveConnections.length ? activeDriveConnections : driveConnections;

  const connectors: ConnectorHealth[] = CONNECTOR_CATALOG.map((entry) => {
    let integration = integrationByProvider.get(entry.id);
    // PR #1944 review round 3: google_drive's real watch health lives on
    // org_integrations (integration), never on connector_subscriptions —
    // see deriveDriveWatchHealth()'s doc comment. microsoft_graph is
    // unaffected and keeps reading connector_subscriptions as before.
    let subscription = entry.id === 'google_drive'
      ? (integration ? deriveDriveWatchHealth(integration) : undefined)
      : subscriptionByProvider.get(entry.id as SubscriptionRow['provider']);
    const vendorFailure = entry.vendor_event_sources
      .map((v) => failureByVendor.get(v))
      .find((f): f is PerVendorFailure => f !== undefined);
    const lastFailed = integration ? vendorFailure : undefined;
    // P0-2: computed ONLY for google_drive — same google_drive-only scoping
    // as deriveDriveWatchHealth above. Every other connector passes
    // undefined and classify() skips both new branches entirely.
    const driveSignals: DriveHealthSignals | undefined = entry.id === 'google_drive' && integration
      ? {
        cursorStale: hasEnabledDriveRules && isDriveCursorStale(integration.last_token_advanced_at),
        neverSucceeded: hasEnabledDriveRules
          && hasDriveChangesNeverSucceeded(integration.last_token_advanced_at, integration.connected_at),
        fetchJobFailureCount: driveFetchJobFailureCount,
        fileAccessDeniedCount: driveFileAccessDeniedCount,
        grantExceedsRequested: excessScopesOrUndefined(integration.scope),
        legacyGrant: isDriveLegacyGrant(integration.scope),
        oauthClientMismatch: oauthClientMismatchOrUndefined(integration.last_renewal_error),
        gap: driveGapByIntegrationId.get(integration.id),
      }
      : undefined;
    let classification = classify(entry, integration, subscription, lastFailed, driveSignals);
    if (entry.id === 'google_drive' && consideredDriveConnections.length) {
      const now = new Date();
      const candidates = consideredDriveConnections.map((row) => {
        const watch = deriveDriveWatchHealth(row);
        return {
          integration: row, subscription: watch,
          ...classify(entry, row, watch, vendorFailure, {
            cursorStale: hasEnabledDriveRules && isDriveCursorStale(row.last_token_advanced_at, now),
            neverSucceeded: hasEnabledDriveRules
              && hasDriveChangesNeverSucceeded(row.last_token_advanced_at, row.connected_at, now),
            fetchJobFailureCount: driveFetchJobFailureCount,
            fileAccessDeniedCount: driveFileAccessDeniedCount,
            grantExceedsRequested: excessScopesOrUndefined(row.scope),
            legacyGrant: isDriveLegacyGrant(row.scope),
            oauthClientMismatch: oauthClientMismatchOrUndefined(row.last_renewal_error),
            gap: driveGapByIntegrationId.get(row.id),
          }),
        };
      }).sort(compareDriveHealth);
      const selected = candidates[0];
      integration = selected.integration;
      subscription = selected.subscription;
      classification = selected;
    }
    const { state, reason, lastError } = classification;
    const last_event_at = entry.vendor_event_sources
      .map((v) => lastEventByVendor.get(v))
      .filter((v): v is string => typeof v === 'string')
      .sort()
      .at(-1) ?? null;
    return {
      id: entry.id,
      label: entry.label,
      kind: resolveConnectorKind(entry),
      state,
      health_reason: reason,
      account_label: sanitizeAccountLabel(integration?.account_label ?? null),
      last_event_at,
      last_renewal_at: subscription?.last_renewed_at ?? null,
      next_expires_at: subscription?.expires_at ?? null,
      last_error: lastError,
    };
  });

  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    connectors,
    generated_at: new Date().toISOString(),
  });
}
