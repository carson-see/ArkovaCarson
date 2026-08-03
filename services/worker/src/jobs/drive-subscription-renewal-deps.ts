/**
 * GH #1835 — production wiring for Drive `org_integrations` subscription
 * renewal.
 *
 * Adapts real Supabase queries + the Drive OAuth/watch client
 * (`integrations/oauth/drive.ts`) + Sentry into the
 * `DriveSubscriptionRenewalDb` / `DriveSubscriptionRenewalClient` interfaces
 * consumed by the pure `renewDriveSubscriptions()`.
 */
import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import {
  createChangesWatch,
  stopDriveChannel,
  type DriveClientDeps,
} from '../integrations/oauth/drive.js';
import { createDefaultKmsClient, type KmsClient } from '../integrations/oauth/crypto.js';
import { WEBHOOK_PATHS } from '../constants/webhook-paths.js';
import {
  loadDriveAccessToken,
  DriveRunnerError,
  type DriveIntegrationRow,
} from '../integrations/connectors/drive-changes-runner.js';
import {
  renewDriveSubscriptions,
  type DriveSubscriptionRenewalDb,
  type DriveSubscriptionRenewalClient,
  type DriveSubscriptionRenewalAlert,
  type DriveSubscriptionRenewalSummary,
  type DriveSubscriptionRow,
} from '../integrations/connectors/drive-subscription-renewal.js';
import { DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, withRunLease } from './run-lease.js';

const GOOGLE_DRIVE_PROVIDER = 'google_drive';
/** Renewal batch bound — matches DocuSign reconciliation's conservative pass size. */
const RENEWAL_BATCH_SIZE = 100;
/** Renew channels expiring within the next 24h (well inside Drive's ~7-day cap). */
const DEFAULT_HORIZON_MS = 24 * 60 * 60 * 1000;

interface DbQueryResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

interface RawConnectionRow {
  id: string;
  org_id: string;
  subscription_id: string | null;
  subscription_expires_at: string | null;
  account_label: string | null;
  watch_renewal_failure_count: number | null;
  encrypted_tokens: Buffer | string | null;
  token_kms_key_id: string | null;
  last_page_token: string | null;
}

/**
 * The DB adapter fetches the KMS/token columns alongside the pure module's
 * public `DriveSubscriptionRow` fields so the client adapter can decrypt +
 * refresh the OAuth token for the SAME row `renewDriveSubscriptions` hands
 * back to `client.getAccessToken(conn)` — without widening the connector
 * module's own exported type (it has no business knowing about KMS token
 * storage). The object round-trips through the pure function unchanged, so
 * these extra fields are still present on `conn` at the client boundary;
 * this helper narrows them back out.
 */
function asRawRow(conn: DriveSubscriptionRow): RawConnectionRow {
  return conn as unknown as RawConnectionRow;
}

function toDriveIntegrationRow(row: RawConnectionRow): DriveIntegrationRow {
  return {
    id: row.id,
    org_id: row.org_id,
    encrypted_tokens: row.encrypted_tokens,
    token_kms_key_id: row.token_kms_key_id,
    last_page_token: row.last_page_token,
  };
}

export interface DriveSubscriptionRenewalDepOptions {
  db?: AnyDb;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  kms?: KmsClient;
  /**
   * Test-only override for the worker's own public base URL. Production
   * always resolves this through the Zod-validated `config.workerPublicUrl`
   * (config.ts) — this file never reads the underlying env var directly.
   */
  workerPublicUrl?: string;
}

export function makeDriveSubscriptionRenewalDb(
  options: DriveSubscriptionRenewalDepOptions = {},
): DriveSubscriptionRenewalDb {
  const db = options.db ?? (defaultDb as AnyDb);

  return {
    async listRenewableConnections({ now, horizonMs }): Promise<DriveSubscriptionRow[]> {
      const horizon = new Date(new Date(now).getTime() + (horizonMs ?? DEFAULT_HORIZON_MS)).toISOString();
      // Cross-tenant by design: a service-role cron sweep enumerating every
      // org's Drive connection to renew, same shape as
      // docusign-reconciliation-deps.ts's listActiveIntegrations. Each row
      // carries its own org_id which scopes the per-row work that follows.
      // eslint-disable-next-line arkova/missing-org-filter
      const { data, error } = (await db
        .from('org_integrations')
        .select(
          'id, org_id, subscription_id, subscription_expires_at, account_label, watch_renewal_failure_count, encrypted_tokens, token_kms_key_id, last_page_token',
        )
        .eq('provider', GOOGLE_DRIVE_PROVIDER)
        .is('revoked_at', null)
        .or(`subscription_expires_at.lte.${horizon},subscription_id.is.null`)
        .limit(RENEWAL_BATCH_SIZE)) as DbQueryResult<RawConnectionRow[]>;

      if (error) {
        logger.error({ error }, 'drive subscription renewal: candidate fetch failed');
        throw new Error(`drive_renewal_candidate_fetch_failed: ${error.message ?? 'unknown'}`);
      }

      return ((data ?? []) as RawConnectionRow[]).map((row) => ({
        id: row.id,
        org_id: row.org_id,
        subscription_id: row.subscription_id,
        subscription_expires_at: row.subscription_expires_at,
        account_label: row.account_label,
        watch_renewal_failure_count: row.watch_renewal_failure_count ?? 0,
        // Carried through for the client adapter only — see asRawRow().
        encrypted_tokens: row.encrypted_tokens,
        token_kms_key_id: row.token_kms_key_id,
        last_page_token: row.last_page_token,
      })) as unknown as DriveSubscriptionRow[];
    },

    async updateConnection(update) {
      const { id, ...patch } = update;
      // eslint-disable-next-line arkova/missing-org-filter -- scoped by row id; org-agnostic cron sweep (see listRenewableConnections)
      const { error } = await db.from('org_integrations').update(patch).eq('id', id);
      if (error) {
        logger.error({ error, integrationId: id }, 'drive subscription renewal: watch-state update failed');
        return { error: true };
      }
      return { error: false };
    },
  };
}

export function makeDriveSubscriptionRenewalClient(
  options: DriveSubscriptionRenewalDepOptions = {},
): DriveSubscriptionRenewalClient {
  // `env` here is a pure passthrough vehicle to `oauth/drive.ts`'s existing
  // `deps.env ?? process.env` convention (every Drive/DocuSign OAuth call
  // site in this codebase already threads a test-overridable env object the
  // same way) — it is never read for a NAMED variable in this file itself.
  // The one named variable this module actually needs — WORKER_PUBLIC_URL —
  // is resolved from the Zod-validated `config` export below, not from here.
  const env = options.env ?? process.env;
  const driveDeps: DriveClientDeps = { fetchImpl: options.fetchImpl, env };
  let kmsPromise: Promise<KmsClient> | null = null;
  const getKms = () => {
    kmsPromise ??= options.kms ? Promise.resolve(options.kms) : createDefaultKmsClient();
    return kmsPromise;
  };

  return {
    async getAccessToken(conn) {
      const raw = asRawRow(conn);
      if (!raw.encrypted_tokens || !raw.token_kms_key_id) {
        // Never bootstrapped / already cleared — treat as a revoked grant so
        // the sweep degrades it rather than crash-looping every pass.
        return { accessToken: null, revoked: true };
      }
      try {
        const kms = await getKms();
        const { accessToken } = await loadDriveAccessToken(toDriveIntegrationRow(raw), {
          db: options.db ?? (defaultDb as AnyDb),
          kms,
          drive: driveDeps,
          env,
        });
        return { accessToken, revoked: false };
      } catch (err) {
        // no_refresh_token / an OAuth-shaped 400 (invalid_grant) from Google
        // means the grant was revoked at the source — recoverable only by
        // the org reconnecting. Any other DriveRunnerError (persist/read
        // races, KMS transient failures) should retry on the next sweep, not
        // be mis-classified as a permanent revoke.
        if (err instanceof DriveRunnerError && err.code === 'no_refresh_token') {
          return { accessToken: null, revoked: true };
        }
        throw err;
      }
    },

    async stopChannel({ accessToken, channelId, resourceId }) {
      if (!resourceId) return;
      await stopDriveChannel({ accessToken, channelId, resourceId, deps: driveDeps });
    },

    async createChannel({ accessToken, channelId, channelToken }) {
      // Zod-validated config.workerPublicUrl (config.ts), not an ad-hoc
      // process.env read — same `WORKER_PUBLIC_URL` var docusign.ts's
      // Connect-listener provisioning requires out-of-request-context. Fail
      // closed rather than register a channel pointed at a broken address
      // (mirrors requireConnectConfig's guard).
      const workerPublicUrl = options.workerPublicUrl ?? config.workerPublicUrl;
      if (!workerPublicUrl) {
        throw new Error('WORKER_PUBLIC_URL not set — cannot renew Drive changes.watch channel.');
      }
      // GH #1835 CRITICAL: the returned startPageToken is deliberately
      // discarded — renewal must never reset the live changes cursor. See
      // the module doc comment on drive-subscription-renewal.ts.
      const created = await createChangesWatch({
        accessToken,
        channelId,
        // Reuses the SAME webhook path every connection already points at —
        // Drive re-registers a channel id, not a URL change.
        address: `${workerPublicUrl.replace(/\/$/, '')}${WEBHOOK_PATHS.GOOGLE_DRIVE}`,
        token: channelToken,
        deps: driveDeps,
      });
      return { resourceId: created.resourceId, expiration: created.expiration };
    },
  };
}

export const alertDriveSubscriptionRenewal: DriveSubscriptionRenewalAlert = (event) => {
  try {
    Sentry.captureMessage(
      `Drive subscription renewal ${event.kind}: integration ${event.integrationId}`,
      {
        level: event.kind === 'token_revoked' ? 'warning' : 'error',
        tags: { integration_id: event.integrationId, org_id: event.orgId, kind: event.kind },
        extra: { reason: event.reason },
      },
    );
  } catch (sentryErr) {
    logger.error({ error: sentryErr, event }, 'drive subscription renewal: Sentry alert failed');
  }
};

export interface DriveSubscriptionRenewalRunResult extends DriveSubscriptionRenewalSummary {
  /**
   * True when this invocation could NOT acquire the run lease — another
   * trigger (Cloud Scheduler or the in-process backup) is already mid-sweep
   * on this or another instance. NOT an error: this is the double-fire
   * guard working as intended. `scanned`/`renewed`/`degraded`/`failed` are
   * all 0 in this case (nothing ran).
   */
  skipped?: boolean;
}

const EMPTY_RENEWAL_SUMMARY: DriveSubscriptionRenewalSummary = {
  scanned: 0, renewed: 0, degraded: 0, failed: 0,
};

/**
 * PR #1944 review correction: the ONE entry point BOTH trigger paths call —
 * `routes/cron.ts`'s HTTP route (Cloud Scheduler) and `routes/scheduled.ts`'s
 * in-process backup. Wrapping the run lease HERE, not in either caller, is
 * what makes "whichever fires first wins, the other no-ops" actually true —
 * both paths share the exact same lease acquisition. Matches
 * `batch-anchor.ts`'s `processBatchAnchors()` pattern (see run-lease.ts's
 * module doc comment for the 2026-08-01 incident that pattern exists to
 * prevent) — deleting the in-process backup entirely (an earlier, WRONG
 * version of this fix) would have made the Cloud Scheduler job — undeployed
 * as of this PR — the ONLY trigger, so a forgotten operator step would have
 * silently disabled renewal (and therefore the GH #1836 legacy-token
 * rotation) rather than merely degrading its cadence.
 */
export async function runDriveSubscriptionRenewal(
  options: DriveSubscriptionRenewalDepOptions = {},
): Promise<DriveSubscriptionRenewalRunResult> {
  const leaseClient = options.db ?? (defaultDb as AnyDb);
  const outcome = await withRunLease(
    { ...DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, client: leaseClient },
    () => renewDriveSubscriptions({
      db: makeDriveSubscriptionRenewalDb(options),
      client: makeDriveSubscriptionRenewalClient(options),
      alert: alertDriveSubscriptionRenewal,
    }),
  );
  return outcome.acquired ? outcome.result : { ...EMPTY_RENEWAL_SUMMARY, skipped: true };
}
