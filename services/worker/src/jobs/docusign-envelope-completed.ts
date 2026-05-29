import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { processNextJob } from '../utils/jobQueue.js';
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

interface DbClient {
  from(table: 'org_integrations' | 'member_integrations'): DbSelectQuery<DocusignIntegrationRow>;
  from(table: 'organizations'): DbSelectQuery<{ parent_org_id: string | null }>;
  from(table: 'integration_events'): DbInsertQuery<{ id?: string }>;
}

type DocusignIntegrationRow = Pick<
  OrgIntegrationRow,
  'id' | 'org_id' | 'account_id' | 'base_uri' | 'token_secret_name'
>;

type DocusignOrgIntegrationRow = DocusignIntegrationRow &
  Pick<OrgIntegrationRow, 'inherited_from_org_id'>;

// Base columns exist on BOTH org_integrations and member_integrations.
const DOCUSIGN_BASE_COLUMNS = 'id, org_id, account_id, base_uri, token_secret_name';
// inherited_from_org_id is an org_integrations-only column (SCRUM-2045) — never
// select it from member_integrations.
const DOCUSIGN_ORG_COLUMNS = `${DOCUSIGN_BASE_COLUMNS}, inherited_from_org_id`;

function toConnectionRow(
  row: DocusignIntegrationRow,
  inheritedFromOrgId: string | null,
): DocusignConnectionRow {
  return {
    id: row.id,
    org_id: row.org_id,
    account_id: row.account_id ?? null,
    base_uri: row.base_uri ?? null,
    token_secret_name: row.token_secret_name ?? null,
    inherited_from_org_id: inheritedFromOrgId,
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
  const queryIntegration = (table: 'org_integrations' | 'member_integrations') => db
    .from(table)
    .select(DOCUSIGN_BASE_COLUMNS)
    .eq('id', args.integrationId)
    .eq('org_id', args.orgId)
    .eq('provider', 'docusign')
    .eq('account_id', args.accountId)
    .is('revoked_at', null)
    .maybeSingle();

  const orgResult = await queryIntegration('org_integrations');
  if (orgResult.error) {
    logger.error(
      { error: orgResult.error, integrationId: args.integrationId },
      'DocuSign job org integration lookup failed',
    );
    throw new Error('docusign_integration_lookup_failed');
  }
  if (orgResult.data) {
    return toConnectionRow(orgResult.data as DocusignIntegrationRow, null);
  }

  const memberResult = await queryIntegration('member_integrations');
  if (memberResult.error) {
    logger.error(
      { error: memberResult.error, integrationId: args.integrationId },
      'DocuSign job member integration lookup failed',
    );
    throw new Error('docusign_integration_lookup_failed');
  }
  if (memberResult.data) {
    return toConnectionRow(memberResult.data as DocusignIntegrationRow, null);
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
  parentOrgId: string,
): Promise<DocusignConnectionRow | null> {
  const { data, error } = await db
    .from('org_integrations')
    .select(DOCUSIGN_ORG_COLUMNS)
    .eq('org_id', parentOrgId)
    .eq('provider', 'docusign')
    .is('revoked_at', null)
    .is('inherited_from_org_id', null)
    .maybeSingle();

  if (error) {
    logger.error({ error, parentOrgId }, 'DocuSign parent connection lookup failed');
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
          fetchParentOwnConnection: (parentOrgId) => fetchParentOwnDocusignRow(db, parentOrgId),
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
      };
    },

    async enqueueSignedDocument(input): Promise<DocusignDocumentSinkResult> {
      const { data, error } = await db
        .from('integration_events')
        .insert({
          org_id: input.orgId,
          integration_id: input.integrationId,
          provider: 'docusign',
          event_type: 'envelope_document_fetched',
          status: 'success',
          details: {
            account_id: input.accountId,
            envelope_id: input.envelopeId,
            rule_event_id: input.ruleEventId,
            content_type: input.contentType,
            byte_length: input.documentBytes.byteLength,
          },
        })
        .select('id')
        .single();

      if (error) {
        logger.error({ error, integrationId: input.integrationId }, 'DocuSign signed-document sink failed');
        throw new Error('docusign_signed_document_sink_failed');
      }

      return { queuedId: data && data.id ? data.id : input.ruleEventId };
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
