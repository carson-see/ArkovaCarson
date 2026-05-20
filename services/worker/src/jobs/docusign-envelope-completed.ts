import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { processNextJob } from '../utils/jobQueue.js';
import {
  processDocusignEnvelopeCompletedJob,
  type DocusignEnvelopeCompletedJobPayloadT,
  type DocusignEnvelopeJobDeps,
  type DocusignDocumentSinkResult,
} from '../integrations/connectors/docusign.js';
import { refreshDocusignAccessToken } from '../integrations/oauth/docusign.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import type { TypeSafeDatabase } from '../types/database-overrides.js';

export const DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE = 'docusign.envelope_completed';
const DEFAULT_DOCUSIGN_ENVELOPE_JOB_LIMIT = 10;
const MAX_DOCUSIGN_ENVELOPE_JOB_LIMIT = 100;

type OrgIntegrationRow = TypeSafeDatabase['public']['Tables']['org_integrations']['Row'];

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
  from(table: 'org_integrations'): DbSelectQuery<DocusignIntegrationRow>;
  from(table: 'integration_events'): DbInsertQuery<{ id?: string }>;
}

type DocusignIntegrationRow = Pick<
  OrgIntegrationRow,
  'id' | 'org_id' | 'account_id' | 'base_uri' | 'token_secret_name'
>;

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

function getRefreshTokenStore(deps: DocusignEnvelopeJobRuntimeDeps): DocusignRefreshTokenStore {
  return deps.refreshTokenStore ?? createGcpSecretManagerRefreshTokenStore({
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
}

async function fetchIntegration(
  db: DbClient,
  payload: DocusignEnvelopeCompletedJobPayloadT,
): Promise<DocusignIntegrationRow> {
  const { data, error } = await db
    .from('org_integrations')
    .select('id, org_id, account_id, base_uri, token_secret_name')
    .eq('id', payload.integration_id)
    .eq('org_id', payload.org_id)
    .eq('provider', 'docusign')
    .eq('account_id', payload.account_id)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) {
    logger.error({ error, integrationId: payload.integration_id }, 'DocuSign job integration lookup failed');
    throw new Error('docusign_integration_lookup_failed');
  }
  if (!data) {
    throw new Error('docusign_integration_not_found');
  }
  return data as DocusignIntegrationRow;
}

export function makeDocusignEnvelopeJobDeps(
  deps: DocusignEnvelopeJobRuntimeDeps = {},
): DocusignEnvelopeJobDeps {
  const db = deps.db ?? (defaultDb as unknown as DbClient);
  const refreshTokenStore = getRefreshTokenStore(deps);

  return {
    env: deps.env,
    fetchImpl: deps.fetchImpl,

    async resolveConnection(payload) {
      const integration = await fetchIntegration(db, payload);
      if (!integration.base_uri) {
        throw new Error('docusign_integration_missing_base_uri');
      }
      if (!integration.token_secret_name) {
        throw new Error('docusign_integration_missing_refresh_token_secret');
      }

      const refreshToken = await refreshTokenStore.get({ name: integration.token_secret_name });
      if (!refreshToken) {
        throw new Error('docusign_refresh_token_secret_missing');
      }

      const refreshed = await refreshDocusignAccessToken({
        refreshToken,
        deps: {
          env: deps.env,
          fetchImpl: deps.fetchImpl,
        },
      });
      if (refreshed.refresh_token && refreshed.refresh_token !== refreshToken) {
        await refreshTokenStore.put({
          name: integration.token_secret_name,
          value: refreshed.refresh_token,
        });
      }

      return {
        accessToken: refreshed.access_token,
        baseUri: integration.base_uri,
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

      return { queuedId: data?.id ?? input.ruleEventId };
    },
  };
}

export async function runDocusignEnvelopeCompletedJobs(
  options: DocusignEnvelopeJobRunOptions = {},
): Promise<DocusignEnvelopeJobRunResult> {
  const rawLimit = options.limit ?? DEFAULT_DOCUSIGN_ENVELOPE_JOB_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_DOCUSIGN_ENVELOPE_JOB_LIMIT, Math.max(1, Math.trunc(rawLimit)))
    : DEFAULT_DOCUSIGN_ENVELOPE_JOB_LIMIT;
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

    result.claimed += 1;
    if (processed.jobId) result.jobIds.push(processed.jobId);
    if (processed.status === 'completed') result.completed += 1;
    if (processed.status === 'failed') result.failed += 1;
    if (processed.status === 'dead') result.dead += 1;
    if (processed.status === 'update_failed') result.updateFailed += 1;
  }

  return result;
}
