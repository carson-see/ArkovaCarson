import { createHash } from 'node:crypto';
import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { processNextJob } from '../utils/jobQueue.js';
import { truncateUtf16Safe } from '../utils/utf16-truncate.js';
import {
  processDocusignEnvelopeCompletedJob,
  type DocusignEnvelopeJobDeps,
  type DocusignDocumentSinkResult,
} from '../integrations/connectors/docusign.js';
import { refreshDocusignAccessToken } from '../integrations/oauth/docusign.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import { createDocusignRateLimitedFetch } from '../integrations/oauth/docusign-rate-limit.js';
import {
  resolveEffectiveDocusignConnection,
  type DocusignConnectionRow,
} from '../integrations/connectors/docusign-connection-resolver.js';
import type { TypeSafeDatabase } from '../types/database-overrides.js';

export const DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE = 'docusign.envelope_completed';
const DEFAULT_DOCUSIGN_ENVELOPE_JOB_LIMIT = 10;
const MAX_DOCUSIGN_ENVELOPE_JOB_LIMIT = 100;
// DS-03 (SCRUM-2363): sentinel returned when the connector-artifact enqueue is
// gated off. Deliberately not a real artifact id — no consumer reads `queuedId`,
// and a "*_disabled" value makes the dormant path obvious in any trace.
const CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_QUEUED_ID = 'connector_artifact_enqueue_disabled';
const QUEUE_STATUS_COUNTERS = {
  completed: 'completed',
  failed: 'failed',
  dead: 'dead',
  update_failed: 'updateFailed',
} as const;

type OrgIntegrationRow = TypeSafeDatabase['public']['Tables']['org_integrations']['Row'];
type QueueStatus = keyof typeof QUEUE_STATUS_COUNTERS;

interface DbQueryResult<T> {
  data: T | null;
  error: unknown;
}

interface DbSelectQuery<T> {
  select(columns?: string): DbSelectQuery<T>;
  eq(field: string, value: unknown): DbSelectQuery<T>;
  is(field: string, value: unknown): DbSelectQuery<T>;
  maybeSingle(): Promise<DbQueryResult<T>>;
}

interface DbInsertQuery<T> {
  insert(value: Record<string, unknown>): {
    select(columns?: string): {
      single(): Promise<DbQueryResult<T>>;
    };
  };
}

// DS-03 (SCRUM-2363): typed args for the 0343 `enqueue_connector_artifact` RPC
// (Lane-2 / SCRUM-2348, mig 0343). The RPC is idempotent (ON CONFLICT DO NOTHING
// on the dedupe key org_id/source/external_ref/COALESCE(external_revision,'')) and
// returns the artifact id. Only the server-computed fingerprint + PII-scrubbed
// metadata cross this boundary — never raw document bytes (§1.6A).
interface EnqueueConnectorArtifactArgs {
  p_org_id: string;
  p_source: 'docusign';
  p_external_ref: string;
  p_external_revision: string | null;
  p_fingerprint_sha256: string;
  p_byte_length: number | null;
  p_source_timestamp: string | null;
  p_metadata: Record<string, unknown>;
}

// F1 (security review, docusign-bilateral-2026-08): the row shape read back
// after enqueue_connector_artifact to detect a provenance conflict (a forged
// INBOUND declared-hash write racing ahead of this real, measured write and
// winning the ON CONFLICT DO NOTHING). Narrow on purpose — only the two
// fields the comparison needs, never document bytes.
interface ConnectorArtifactProvenanceRow {
  fingerprint_sha256: string;
  metadata: Record<string, unknown> | null;
}

interface DbClient {
  from(table: 'org_integrations' | 'member_integrations'): DbSelectQuery<DocusignIntegrationRow>;
  from(table: 'organizations'): DbSelectQuery<{ parent_org_id: string | null }>;
  // audit_events (SOC-2 append-only compliance trail, see utils/auditEvent.ts's
  // header) shares the exact insert/select/single shape integration_events
  // already used here — the F1-heal provenance audit row below is the second
  // consumer of this widened overload.
  from(table: 'integration_events' | 'audit_events'): DbInsertQuery<{ id?: string }>;
  from(table: 'connector_artifact'): DbSelectQuery<ConnectorArtifactProvenanceRow>;
}

// The 0343 enqueue RPC lives on the same supabase client but is reached through a
// narrow typed view, so the existing `DbClient.from` test mocks stay valid and
// only the artifact path takes a dependency on `.rpc`.
interface ConnectorArtifactRpcClient {
  rpc(
    fn: 'enqueue_connector_artifact',
    args: EnqueueConnectorArtifactArgs,
  ): Promise<DbQueryResult<string>>;
}

// F1-heal (auto-heal follow-up to PR #2476's detection-only floor, SCRUM-3818
// go-live gate): the narrow typed view used to atomically UPDATE a
// pre-existing connector_artifact row when THIS call's verified,
// server-measured fingerprint must supersede a merely-declared one. Reached
// through a separate cast — same convention as ConnectorArtifactRpcClient
// above — so the existing DbClient.from('connector_artifact') select-only
// mocks stay valid; only this one call site takes a dependency on `.update()`.
interface DbUpdateQuery<T> {
  update(value: Record<string, unknown>): DbUpdateQuery<T>;
  eq(field: string, value: unknown): DbUpdateQuery<T>;
  is(field: string, value: unknown): DbUpdateQuery<T>;
  select(columns?: string): DbUpdateQuery<T>;
  maybeSingle(): Promise<DbQueryResult<T>>;
}

interface ConnectorArtifactUpdateClient {
  from(table: 'connector_artifact'): DbUpdateQuery<{ id: string }>;
}

type DocusignIntegrationRow = Pick<
  OrgIntegrationRow,
  'id' | 'org_id' | 'account_id' | 'base_uri' | 'token_secret_name'
>;

type DocusignOrgIntegrationRow = DocusignIntegrationRow &
  Pick<OrgIntegrationRow, 'inherited_from_org_id'>;

// DS-04 (SCRUM-2364): member_integrations rows additionally carry the owning
// user id, which the resolver maps to owner_user_id ⇒ member (personal) scope.
type DocusignMemberIntegrationRow = DocusignIntegrationRow & { user_id?: string | null };

// Base columns exist on BOTH org_integrations and member_integrations.
const DOCUSIGN_BASE_COLUMNS = 'id, org_id, account_id, base_uri, token_secret_name';
// DS-04: member_integrations additionally exposes user_id — the owning member.
// Never select it from org_integrations (org rows have no per-user owner).
const DOCUSIGN_MEMBER_COLUMNS = `${DOCUSIGN_BASE_COLUMNS}, user_id`;
// inherited_from_org_id is an org_integrations-only column (SCRUM-2045) — never
// select it from member_integrations.
const DOCUSIGN_ORG_COLUMNS = `${DOCUSIGN_BASE_COLUMNS}, inherited_from_org_id`;

function toConnectionRow(
  row: DocusignIntegrationRow,
  inheritedFromOrgId: string | null,
  ownerUserId: string | null = null,
): DocusignConnectionRow {
  return {
    id: row.id,
    org_id: row.org_id,
    account_id: row.account_id ?? null,
    base_uri: row.base_uri ?? null,
    token_secret_name: row.token_secret_name ?? null,
    inherited_from_org_id: inheritedFromOrgId,
    // DS-04: a set owner_user_id marks this as a member (personal) connection.
    owner_user_id: ownerUserId,
  };
}

function normalizeLimit(rawLimit: number | undefined): number {
  if (rawLimit === undefined || !Number.isFinite(rawLimit)) {
    return DEFAULT_DOCUSIGN_ENVELOPE_JOB_LIMIT;
  }

  return Math.min(MAX_DOCUSIGN_ENVELOPE_JOB_LIMIT, Math.max(1, Math.trunc(rawLimit)));
}

function getRefreshTokenStore(deps: DocusignEnvelopeJobRuntimeDeps): DocusignRefreshTokenStore {
  return deps.refreshTokenStore ?? createGcpSecretManagerRefreshTokenStore({
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
}

// A "direct" connection is one this org owns itself — either an org-level
// (org_integrations) or a per-member (member_integrations) DocuSign connection
// matching the payload's integration id + account. This is the SCRUM-2045
// resolver's "own" lookup and preserves the member_integrations fallback
// behavior unchanged. Inheritance is only consulted when this returns null.
async function fetchDirectDocusignRow(
  db: DbClient,
  args: { orgId: string; accountId: string; integrationId: string },
): Promise<DocusignConnectionRow | null> {
  const queryIntegration = (
    table: 'org_integrations' | 'member_integrations',
    columns: string,
  ) => db
    .from(table)
    .select(columns)
    .eq('id', args.integrationId)
    .eq('org_id', args.orgId)
    .eq('provider', 'docusign')
    .eq('account_id', args.accountId)
    .is('revoked_at', null)
    .maybeSingle();

  // org_integrations wins over member_integrations (mirrors the webhook
  // `findIntegration` precedence): an envelope connected under org policy is an
  // org-queue artifact even if the same user also holds a personal connection.
  const orgResult = await queryIntegration('org_integrations', DOCUSIGN_BASE_COLUMNS);
  if (orgResult.error) {
    logger.error(
      { error: orgResult.error, integrationId: args.integrationId },
      'DocuSign job org integration lookup failed',
    );
    throw new Error('docusign_integration_lookup_failed');
  }
  if (orgResult.data) {
    // Org connection ⇒ org queue (no owner user).
    return toConnectionRow(orgResult.data as DocusignIntegrationRow, null, null);
  }

  // DS-04 (SCRUM-2364): fall back to the member (personal) connection and select
  // its owning user id so the artifact routes to that user's personal queue.
  const memberResult = await queryIntegration('member_integrations', DOCUSIGN_MEMBER_COLUMNS);
  if (memberResult.error) {
    logger.error(
      { error: memberResult.error, integrationId: args.integrationId },
      'DocuSign job member integration lookup failed',
    );
    throw new Error('docusign_integration_lookup_failed');
  }
  if (memberResult.data) {
    const memberRow = memberResult.data as DocusignMemberIntegrationRow;
    return toConnectionRow(memberRow, null, memberRow.user_id ?? null);
  }
  return null;
}

// Inheritance marker: the org's single active account_id-NULL docusign row
// (uniqueness guaranteed by idx_org_integrations_org_provider_active_null_account).
async function fetchInheritanceMarker(
  db: DbClient,
  orgId: string,
): Promise<{ id: string; org_id: string; inherited_from_org_id: string | null } | null> {
  const { data, error } = await db
    .from('org_integrations')
    .select(DOCUSIGN_ORG_COLUMNS)
    .eq('org_id', orgId)
    .eq('provider', 'docusign')
    .is('account_id', null)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    logger.error({ error, orgId }, 'DocuSign inheritance marker lookup failed');
    throw new Error('docusign_integration_lookup_failed');
  }
  const row = data as DocusignOrgIntegrationRow | null;
  if (!row || !row.inherited_from_org_id) {
    return null;
  }
  return { id: row.id, org_id: row.org_id, inherited_from_org_id: row.inherited_from_org_id };
}

async function fetchParentOrgId(db: DbClient, orgId: string): Promise<string | null> {
  const { data, error } = await db
    .from('organizations')
    .select('parent_org_id')
    .eq('id', orgId)
    .maybeSingle();

  if (error) {
    logger.error({ error, orgId }, 'DocuSign parent-org lookup failed');
    throw new Error('docusign_integration_lookup_failed');
  }
  return data?.parent_org_id ?? null;
}

async function fetchParentOwnDocusignRow(
  db: DbClient,
  args: { parentOrgId: string; accountId: string },
): Promise<DocusignConnectionRow | null> {
  const { parentOrgId, accountId } = args;
  const { data, error } = await db
    .from('org_integrations')
    .select(DOCUSIGN_ORG_COLUMNS)
    .eq('org_id', parentOrgId)
    .eq('provider', 'docusign')
    .eq('account_id', accountId)
    .is('revoked_at', null)
    .is('inherited_from_org_id', null)
    .maybeSingle();

  if (error) {
    logger.error({ error, parentOrgId, accountId }, 'DocuSign parent connection lookup failed');
    throw new Error('docusign_integration_lookup_failed');
  }
  const row = data as DocusignOrgIntegrationRow | null;
  return row ? toConnectionRow(row, row.inherited_from_org_id ?? null) : null;
}

export interface DocusignEnvelopeJobRuntimeDeps {
  db?: DbClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  refreshTokenStore?: DocusignRefreshTokenStore;
  now?: () => Date;
  // DS-03 (SCRUM-2363): overrides the ENABLE_CONNECTOR_ARTIFACT_ENQUEUE env flag
  // for tests. When unset, the env flag (default off in prod) decides whether
  // a connector_artifact row is enqueued.
  enableConnectorArtifactEnqueue?: boolean;
}

export interface DocusignEnvelopeJobRunOptions extends DocusignEnvelopeJobRuntimeDeps {
  limit?: number;
  jobDeps?: DocusignEnvelopeJobDeps;
}

export interface DocusignEnvelopeJobRunResult {
  claimed: number;
  completed: number;
  failed: number;
  dead: number;
  updateFailed: number;
  jobIds: string[];
}

export function makeDocusignEnvelopeJobDeps(
  deps: DocusignEnvelopeJobRuntimeDeps = {},
): DocusignEnvelopeJobDeps {
  const db = deps.db ?? (defaultDb as unknown as DbClient);
  const refreshTokenStore = getRefreshTokenStore(deps);
  // DS-03 (SCRUM-2363): the connector_artifact drain (QUEUE-06/SCRUM-2352,
  // QUEUE-08/SCRUM-2354) is unbuilt, so enqueuing is gated off in prod by
  // default. The flag mirrors the ENABLE_DOCUSIGN_* env flags; tests inject it
  // directly via deps.
  const connectorArtifactEnqueueEnabled =
    deps.enableConnectorArtifactEnqueue ??
    (deps.env ?? process.env).ENABLE_CONNECTOR_ARTIFACT_ENQUEUE === 'true';
  let tokenRefreshAccountId: string | undefined;
  const docusignFetch = createDocusignRateLimitedFetch({
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    get accountId() {
      return tokenRefreshAccountId;
    },
  });

  return {
    env: deps.env,
    fetchImpl: docusignFetch,

    async resolveConnection(payload) {
      const effective = await resolveEffectiveDocusignConnection({
        orgId: payload.org_id,
        accountId: payload.account_id,
        integrationId: payload.integration_id,
        deps: {
          fetchOwnConnection: (a) => fetchDirectDocusignRow(db, a),
          fetchInheritanceMarker: (orgId) => fetchInheritanceMarker(db, orgId),
          fetchParentOrgId: (orgId) => fetchParentOrgId(db, orgId),
          fetchParentOwnConnection: (a) => fetchParentOwnDocusignRow(db, a),
        },
      });
      if (!effective.baseUri) {
        throw new Error('docusign_integration_missing_base_uri');
      }
      if (!effective.tokenSecretName) {
        throw new Error('docusign_integration_missing_refresh_token_secret');
      }

      const refreshToken = await refreshTokenStore.get({ name: effective.tokenSecretName });
      if (!refreshToken) {
        throw new Error('docusign_refresh_token_secret_missing');
      }

      const refreshed = await (async () => {
        tokenRefreshAccountId = payload.account_id;
        try {
          return await refreshDocusignAccessToken({
            refreshToken,
            deps: {
              env: deps.env,
              fetchImpl: docusignFetch,
            },
          });
        } finally {
          tokenRefreshAccountId = undefined;
        }
      })();
      if (refreshed.refresh_token && refreshed.refresh_token !== refreshToken) {
        await refreshTokenStore.put({
          name: effective.tokenSecretName,
          value: refreshed.refresh_token,
        });
      }

      return {
        accessToken: refreshed.access_token,
        baseUri: effective.baseUri,
        // DS-04 (SCRUM-2364): surface the resolved queue routing so the sink can
        // materialize a member envelope into the owning user's personal queue.
        scope: effective.scope,
        ownerUserId: effective.ownerUserId,
      };
    },

    async enqueueSignedDocument(input): Promise<DocusignDocumentSinkResult> {
      // DS-03 (SCRUM-2363) feature-flag guard. When ENABLE_CONNECTOR_ARTIFACT_ENQUEUE
      // is off (the prod default until the QUEUE-06/SCRUM-2352 + QUEUE-08/SCRUM-2354
      // drain ships), do NOT enqueue a connector_artifact row — nothing would
      // anchor it, so a `pending` pile-up would accrue silently. This is a
      // graceful no-op: skip before hashing, write no row, throw nothing. The
      // breadcrumb carries only operational ids — never the fingerprint or bytes
      // (§1.6A).
      if (!connectorArtifactEnqueueEnabled) {
        logger.info(
          { integrationId: input.integrationId },
          'DocuSign connector-artifact enqueue skipped — ENABLE_CONNECTOR_ARTIFACT_ENQUEUE disabled (drain not yet wired: QUEUE-06/QUEUE-08)',
        );
        return { queuedId: CONNECTOR_ARTIFACT_ENQUEUE_DISABLED_QUEUED_ID };
      }

      // DS-04 (SCRUM-2364): personal-queue routing. `scope` defaults to 'org'
      // (org policy) for callers/rows without a member owner. A 'member' scope
      // REQUIRES an ownerUserId — routing a personal-queue artifact with no owner
      // would materialize an unowned document, so fail closed BEFORE hashing or
      // enqueuing (no RPC, no partial state).
      const queueScope: 'org' | 'member' = input.scope ?? 'org';
      const ownerUserId = input.ownerUserId ?? null;
      if (queueScope === 'member' && !ownerUserId) {
        logger.error(
          { integrationId: input.integrationId },
          'DocuSign member-scoped envelope missing owner_user_id — refusing to materialize',
        );
        throw new Error('docusign_member_scope_missing_owner');
      }

      // DS-03 (SCRUM-2363): server-side SHA-256 over the fetched bytes, computed
      // in memory. The bytes are never logged, persisted, attached to an Error,
      // or written to job_queue.last_error (§1.6A / SCRUM-2492). Only the digest
      // + byteLength leave this scope.
      const fingerprint = createHash('sha256').update(input.documentBytes).digest('hex');
      const byteLength = input.documentBytes.byteLength;

      // Durable, idempotent connector artifact via the Lane-2 0343 RPC. Exactly
      // one row per (org, 'docusign', envelopeId): a redelivered envelope dedupes
      // (ON CONFLICT DO NOTHING) and the RPC returns the existing id. No credit
      // debit here — the debit happens later, at SECURING.
      const { data: artifactId, error: artifactError } = await (
        db as unknown as ConnectorArtifactRpcClient
      ).rpc('enqueue_connector_artifact', {
        p_org_id: input.orgId,
        p_source: 'docusign',
        p_external_ref: input.envelopeId,
        p_external_revision: null,
        p_fingerprint_sha256: fingerprint,
        p_byte_length: byteLength,
        p_source_timestamp: input.sourceTimestamp,
        p_metadata: {
          account_id: input.accountId,
          envelope_id: input.envelopeId,
          rule_event_id: input.ruleEventId,
          integration_id: input.integrationId,
          content_type: input.contentType,
          // DS-04: queue routing metadata. `queue_scope` selects the personal vs
          // org queue; `owner_user_id` is present only for member envelopes so the
          // downstream drain (QUEUE-06/08) can scope materialization to the user.
          // No PII beyond the user's uuid — never the fingerprint or bytes (§1.6A).
          queue_scope: queueScope,
          ...(queueScope === 'member' && ownerUserId ? { owner_user_id: ownerUserId } : {}),
        },
      });

      // Fail-closed: no durable artifact => no silent drop, no partial state. The
      // job throws and is retried; the RPC's idempotency makes the retry safe.
      if (artifactError || !artifactId) {
        logger.error(
          { error: artifactError, integrationId: input.integrationId },
          'DocuSign connector-artifact enqueue failed',
        );
        throw new Error('docusign_connector_artifact_enqueue_failed');
      }

      // F1 (security review, docusign-bilateral-2026-08): the RPC above is
      // ON CONFLICT DO NOTHING keyed on (org_id, source, external_ref,
      // COALESCE(external_revision,'')) — the SAME key the INBOUND
      // declared-hash webhook path (api/v1/webhooks/docusign.ts) writes to
      // for the SAME envelope, with an UNVERIFIED, attacker-declared
      // fingerprint (HMAC only proves "signed by this org's key", never "this
      // envelope is really foreign-owned"). A forged inbound event racing
      // ahead of THIS real, server-fetched-and-measured write can win the
      // INSERT; this RPC call then silently returns THAT row's id, and
      // trusting "non-null id = my write succeeded" would anchor the
      // attacker's fingerprint under this real outbound envelope's
      // rule-event/audit trail. Read back the row that ACTUALLY persisted
      // and compare against what THIS call just measured before treating
      // anything as success.
      //
      // Detection only — ON CONFLICT DO NOTHING means this RPC cannot
      // UPDATE-supersede a pre-existing row from here. Automatic
      // outbound-supersedes-inbound reconciliation is separate, go-live-gated
      // follow-up work; the floor this ships is: never silently anchor a
      // fingerprint this call did not itself just measure.
      const { data: persistedArtifact, error: readBackError } = await db
        .from('connector_artifact')
        .select('fingerprint_sha256, metadata')
        .eq('id', artifactId)
        .maybeSingle();

      if (readBackError || !persistedArtifact) {
        // Fail-closed, same posture as the enqueue check above: an artifact
        // id this job cannot read back and verify is not a durable success.
        logger.error(
          { error: readBackError, integrationId: input.integrationId, artifactId },
          'DocuSign connector-artifact read-back failed after enqueue — cannot verify provenance',
        );
        throw new Error('docusign_connector_artifact_readback_failed');
      }

      const persistedMetadata =
        persistedArtifact.metadata && typeof persistedArtifact.metadata === 'object'
          ? (persistedArtifact.metadata as Record<string, unknown>)
          : null;
      // Two independent tells, either one is disqualifying:
      //  - the persisted hash isn't the one THIS call just measured (the
      //    direct race signature), or
      //  - the persisted row is marked `_direction: 'inbound'` at all — this
      //    IS this org's own outbound envelope (we are the outbound job
      //    fetching it), so an existing INBOUND-marked row for the same
      //    (org, envelope) is inherently anomalous even in the vanishingly
      //    unlikely case the hashes happened to coincide.
      const fingerprintMismatch = persistedArtifact.fingerprint_sha256 !== fingerprint;
      const wonByInboundRow = persistedMetadata?._direction === 'inbound';

      if (fingerprintMismatch || wonByInboundRow) {
        // DISTINCT, LOUD signal — unchanged from PR #2476, and fires on EVERY
        // conflict regardless of whether the auto-heal below succeeds. A
        // different write already owns this (org, envelope) artifact slot;
        // this call's real, server-measured fingerprint from the actual
        // fetched bytes was discarded by ON CONFLICT DO NOTHING. That fact
        // alone — a forged-or-otherwise-foreign write raced this real
        // fetch — is worth a standing, gate-able signal independent of the
        // outcome below.
        logger.error(
          {
            docusign_connector_artifact_provenance_conflict: true,
            integrationId: input.integrationId,
            envelopeId: input.envelopeId,
            artifactId,
            persistedDirection: persistedMetadata?._direction ?? null,
            fingerprintMismatch,
          },
          "DocuSign connector-artifact provenance conflict — a different fingerprint already owns this (org, envelope) slot; this call's real, server-measured fingerprint was discarded by ON CONFLICT DO NOTHING",
        );

        // F1-heal (SCRUM-3818 go-live gate; CTO precedence ruling — a
        // fingerprint Arkova MEASURED from fetched document bytes ALWAYS
        // supersedes one merely DECLARED by a notification, never the
        // reverse). PR #2476 shipped DETECTION only ("ON CONFLICT DO NOTHING
        // means this RPC cannot UPDATE-supersede a pre-existing row from
        // here... automatic outbound-supersedes-inbound reconciliation is
        // separate, go-live-gated follow-up work" — its own header comment on
        // this function, and machines/docusignInboundDedup.machine.ts's
        // header names the exact follow-up: a `reconcileForgery` transition).
        // This block IS that follow-up.
        //
        // GATED, not automatic on every conflict (code-review finding,
        // 2026-09-01): the CTO precedence rule is "a MEASURED fingerprint
        // supersedes a DECLARED one, never the reverse" — it says nothing
        // about two independently-MEASURED fingerprints disagreeing. Only a
        // persisted row this call can PROVE is declared/untrusted
        // (`wonByInboundRow` — `_direction: 'inbound'`) is eligible for
        // auto-heal. A bare `fingerprintMismatch` against a row NOT marked
        // inbound is not evidence of forgery: it can be two legitimate
        // outbound executions for the SAME envelope hashing differently (a
        // redelivered webhook, a job retry, or DocuSign's combined-PDF
        // embedding a fetch-time timestamp). Auto-healing that case would let
        // the SECOND run silently overwrite the FIRST run's equally-measured
        // value and mislabel the audit row as forgery resolution, and would
        // defeat `ON CONFLICT DO NOTHING`'s idempotency by letting the
        // fingerprint flap between retries. That shape stays in
        // DETECT-AND-THROW territory — the pre-#2520 behaviour — with its own
        // honest, distinct audit reason instead of being run through the heal
        // path below.
        const autoHealLicensed = wonByInboundRow;

        // `fingerprint` (computed via createHash above, from the bytes THIS
        // job just fetched from DocuSign's document-download API) is real,
        // verified evidence. When `autoHealLicensed`, the persisted row is,
        // by construction of this branch, something else this call did not
        // produce: a declared (possibly attacker-forged) inbound hash.
        //
        // ONE atomic UPDATE is the entire supersession. No new migration or
        // RPC: `connector_artifact_service_all` (migration 0343) already
        // grants service_role unrestricted read/write on this table, and
        // this file is one of only three legitimate service_role writers
        // named in migration 0423's own header (0423 itself guards
        // `anchors.metadata`, a DIFFERENT table — its relevance here is
        // solely that its header independently confirms this file
        // authenticates as service_role, not that its trigger fires on this
        // write). The race guard IS the WHERE clause: `anchor_id IS NULL` is
        // the authoritative "has the drain already materialized a live
        // anchor from this row" signal — connector-artifact-drain.ts's
        // `markStatus` sets `status='materialized'` and `anchor_id` together,
        // atomically, in the SAME UPDATE, never independently, so there is no
        // intermediate state where one is set and not the other. Under
        // Postgres READ COMMITTED, if this UPDATE must wait behind a
        // concurrent drain-job UPDATE on the SAME row, Postgres re-evaluates
        // this UPDATE's WHERE clause against the row's post-commit version
        // before applying (EvalPlanQual) — so there is no separate
        // read-then-write TOCTOU window for a materialize to sneak into
        // between this function's read-back above and the UPDATE below.
        // Whichever happens first is the correct outcome: heal-first means
        // the drain later reads the corrected fingerprint and never sees a
        // conflict; materialize-first means this UPDATE matches zero rows and
        // the refusal branch below fires instead of rewriting a live anchor.
        let healed = false;
        let supersedeError: { message?: string } | null = null;
        if (autoHealLicensed) {
          const supersededMetadata: Record<string, unknown> = { ...(persistedMetadata ?? {}) };
          // Strip the declared-inbound markers so a later drain read of this
          // (now-healed) row takes the SAME path as any other outbound-owned
          // artifact — `defaultMaterializeAnchor`'s `isInboundDeclaredHash`
          // check reads `_direction` fresh at drain time, so leaving 'inbound'
          // here would still wrongly stamp the eventual anchor
          // `fingerprint_source: 'issuer_record_attestation'` even though the
          // fingerprint is now the measured one. `_sending_account_id` is the
          // paired classification field for the same declared-inbound claim.
          delete supersededMetadata._direction;
          delete supersededMetadata._sending_account_id;
          // Provenance breadcrumb, not consumed by any reader today — kept on
          // the row (and, once drained, on the resulting anchor's metadata —
          // 0423's service_role bypass lets it pass through unstripped, and
          // these keys are not in 0423's guarded family) purely for forensic
          // traceability of what this row's fingerprint used to be.
          supersededMetadata._superseded_declared_fingerprint = persistedArtifact.fingerprint_sha256;
          supersededMetadata._superseded_at = new Date().toISOString();
          // `wonByInboundRow` is always true on this branch (that is what
          // `autoHealLicensed` gates on), so the reason is no longer a
          // ternary over `wonByInboundRow` — the fingerprint-mismatch-only,
          // non-declared-row case never reaches here at all (see the
          // `!autoHealLicensed` branch below).
          supersededMetadata._superseded_reason =
            'declared_inbound_row_superseded_by_verified_outbound_fetch';

          const { data: supersedeRow, error } = await (
            db as unknown as ConnectorArtifactUpdateClient
          )
            .from('connector_artifact')
            .update({
              fingerprint_sha256: fingerprint,
              metadata: supersededMetadata,
              updated_at: new Date().toISOString(),
            })
            .eq('id', artifactId)
            .is('anchor_id', null)
            .select('id')
            .maybeSingle();

          supersedeError = error as { message?: string } | null;
          healed = !error && supersedeRow != null;
        }

        // AUDIT (org, envelope, both fingerprints, which won, why) — always
        // written, for ALL THREE outcomes (healed / lost-the-race /
        // not-licensed-to-heal). Awaited-but-non-fatal on failure, mirroring
        // the established audit_events convention elsewhere in this codebase
        // (jobs/revocation.ts, jobs/chain-maintenance.ts): a lost audit row
        // must never turn a successful heal (or a correctly refused rewrite)
        // into a job failure/retry loop over an unrelated audit-table hiccup
        // — but it IS always logged at error so the gap is visible rather
        // than silently swallowed.
        const auditReason = !autoHealLicensed
          ? 'fingerprint_mismatch_non_declared_row_autoheal_not_licensed'
          : healed
            ? 'outbound_verified_fetch_superseded_declared_row'
            : 'declared_row_already_materialized_or_lost_supersede_race';
        const auditWinner = !autoHealLicensed
          ? 'unresolved_non_declared_mismatch'
          : healed
            ? 'verified_document_bytes'
            : 'unresolved_declared_row';

        const { error: provenanceAuditError } = await db
          .from('audit_events')
          .insert({
            event_type: healed
              ? 'docusign_connector_artifact_provenance_superseded'
              : 'docusign_connector_artifact_provenance_conflict_unresolved',
            event_category: 'ANCHOR',
            target_type: 'connector_artifact',
            target_id: artifactId,
            org_id: input.orgId,
            // surrogate-safe-truncate (feedback rule, 2026-08-17 poison-record
            // incident): a bare `.slice(0, N)` cuts at UTF-16 code-unit
            // boundaries and can split a surrogate pair, leaving a lone high
            // surrogate that fails `toWellFormed()`/PostgREST JSON parsing
            // and poisons the WHOLE insert (PGRST102). Every field here is a
            // server-controlled id/hash/enum literal today, but
            // `truncateUtf16Safe` costs nothing and this row's shape (ids +
            // hashes + a literal reason string) is exactly the kind that
            // silently grows a free-text field later — use the safe helper
            // unconditionally rather than relying on today's field set never
            // changing.
            details: truncateUtf16Safe(
              JSON.stringify({
                envelope_id: input.envelopeId,
                integration_id: input.integrationId,
                verified_fingerprint_sha256: fingerprint,
                declared_fingerprint_sha256: persistedArtifact.fingerprint_sha256,
                winner: auditWinner,
                persisted_direction: persistedMetadata?._direction ?? null,
                reason: auditReason,
              }),
              10000,
            ),
          })
          .select('id')
          .single();

        if (provenanceAuditError) {
          logger.error(
            { error: provenanceAuditError, integrationId: input.integrationId, artifactId, healed },
            'DocuSign connector-artifact provenance audit_events insert failed — audit trail incomplete',
          );
        }

        if (!autoHealLicensed) {
          // Bare mismatch against a row this call cannot prove is declared —
          // never auto-heal (see `autoHealLicensed` comment above). Stay in
          // DETECT-AND-THROW territory, same posture PR #2476 shipped for
          // every conflict before #2520 introduced the heal.
          logger.error(
            {
              docusign_connector_artifact_provenance_conflict_unresolved: true,
              integrationId: input.integrationId,
              envelopeId: input.envelopeId,
              artifactId,
            },
            'DocuSign connector-artifact fingerprint mismatch against a row NOT marked declared/inbound — auto-heal is not licensed for this case (only a provably-declared row may be superseded by a measured one); left as the loud, unresolved integrity event for operator follow-up',
          );
          throw new Error('docusign_connector_artifact_provenance_conflict_unresolved');
        }

        if (!healed) {
          // Never silently rewrite a live anchor's fingerprint. A conflict
          // against an ALREADY-MATERIALIZED declared row (anchor_id no
          // longer NULL — set by the drain between this call's read-back and
          // the UPDATE above, or set before either ever ran) is a SEPARATE
          // integrity event: the wrong fingerprint may already be on an
          // anchor, possibly already SUBMITTED/SECURED on-chain, and
          // rewriting connector_artifact after the fact would desync it from
          // the anchor that was actually materialized. That needs
          // human/operator reconciliation, not a background auto-heal. The
          // loud signal above + the audit row just written are the floor —
          // unchanged from PR #2476's original detection-only behavior for
          // this ANCHORED sub-case.
          logger.error(
            {
              docusign_connector_artifact_provenance_conflict_unresolved: true,
              integrationId: input.integrationId,
              envelopeId: input.envelopeId,
              artifactId,
              supersedeError,
            },
            'DocuSign connector-artifact provenance conflict could NOT be healed — the declared row already materialized an anchor (or lost the supersede race); left as the loud, unresolved integrity event for operator follow-up',
          );
          throw new Error('docusign_connector_artifact_provenance_conflict_unresolved');
        }

        logger.warn(
          {
            docusign_connector_artifact_provenance_superseded: true,
            integrationId: input.integrationId,
            envelopeId: input.envelopeId,
            artifactId,
          },
          "DocuSign connector-artifact provenance conflict AUTO-HEALED — this call's verified, server-measured fingerprint superseded the declared row",
        );
        // Fall through: this call's write now durably stands. Proceed to the
        // normal audit breadcrumb + success return below, exactly as if the
        // RPC's own INSERT had won outright.
      }

      // Audit breadcrumb. Carries the artifact id + byte_length but NEVER the
      // fingerprint or bytes (§1.6A). Also fail-closed so a broken audit path is
      // visible rather than silently swallowed.
      //
      // FK safety: integration_events.integration_id has a FK to org_integrations(id)
      // ONLY. A member envelope's integrationId is a member_integrations id, which
      // would violate that FK at runtime — so for member scope we NULL the FK column
      // and carry the member integration id inside the ids-only details JSON instead.
      const isMemberScope = queueScope === 'member';
      const { error: auditError } = await db
        .from('integration_events')
        .insert({
          org_id: input.orgId,
          integration_id: isMemberScope ? null : input.integrationId,
          provider: 'docusign',
          event_type: 'envelope_document_fetched',
          status: 'success',
          details: {
            account_id: input.accountId,
            envelope_id: input.envelopeId,
            rule_event_id: input.ruleEventId,
            content_type: input.contentType,
            byte_length: byteLength,
            connector_artifact_id: artifactId,
            queue_scope: queueScope,
            // Member integration id lives in details (not the FK column) so the
            // audit row still ties back to the personal connection.
            ...(isMemberScope ? { member_integration_id: input.integrationId } : {}),
          },
        })
        .select('id')
        .single();

      if (auditError) {
        logger.error({ error: auditError, integrationId: input.integrationId }, 'DocuSign signed-document audit sink failed');
        throw new Error('docusign_signed_document_sink_failed');
      }

      return { queuedId: artifactId };
    },
  };
}

function recordProcessedJob(
  result: DocusignEnvelopeJobRunResult,
  processed: { status: string; jobId?: string },
): void {
  result.claimed += 1;
  if (processed.jobId) {
    result.jobIds.push(processed.jobId);
  }
  const counterKey = QUEUE_STATUS_COUNTERS[processed.status as QueueStatus];
  if (counterKey) {
    result[counterKey] += 1;
  }
}

export async function runDocusignEnvelopeCompletedJobs(
  options: DocusignEnvelopeJobRunOptions = {},
): Promise<DocusignEnvelopeJobRunResult> {
  const limit = normalizeLimit(options.limit);
  const jobDeps = options.jobDeps ?? makeDocusignEnvelopeJobDeps(options);
  const result: DocusignEnvelopeJobRunResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    updateFailed: 0,
    jobIds: [],
  };

  for (let i = 0; i < limit; i++) {
    const processed = await processNextJob(DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE, async (job) => {
      await processDocusignEnvelopeCompletedJob(job.payload, jobDeps);
    });
    if (!processed.claimed) break;

    recordProcessedJob(result, processed);
  }

  return result;
}
