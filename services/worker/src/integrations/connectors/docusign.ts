/**
 * DocuSign connector service helpers (SCRUM-1101).
 *
 * The webhook route only queues sanitized metadata. This module owns the
 * retryable document-fetch contract used by `job_queue` processors: resolve
 * the connected account's token/base URI, fetch the combined signed PDF from
 * DocuSign, then hand bytes to an injected sink. The sink is responsible for
 * the downstream anchoring/review queue and must not persist raw webhook
 * payloads.
 */
import { z } from 'zod';
import { dbUuid } from '../../utils/db-row-validation.js';
import {
  exchangeDocusignCode,
  fetchDocusignCombinedDocument,
  getDocusignUserInfo,
  type DocusignClientDeps,
  type DocusignTokenResponseT,
} from '../oauth/docusign.js';

export const DocusignEnvelopeCompletedJobPayload = z.object({
  org_id: dbUuid('org_id'),
  integration_id: z.string().min(1),
  account_id: z.string().min(1),
  envelope_id: z.string().min(1),
  rule_event_id: z.string().min(1),
  document_ids: z.array(z.string().min(1)).max(100).default([]),
  // DS-03: the DocuSign Connect completion time, threaded through so the durable
  // connector_artifact records source_timestamp (PII-safe metadata only).
  envelope_completed_at: z.string().datetime().optional(),
});

export type DocusignEnvelopeCompletedJobPayloadT = z.infer<typeof DocusignEnvelopeCompletedJobPayload>;

export interface DocusignResolvedConnection {
  accessToken: string;
  baseUri: string;
  /**
   * DS-04 (SCRUM-2364): queue routing scope for the resolved connection.
   * `'member'` ⇒ the completed envelope materializes into the owning user's
   * PERSONAL queue; `'org'` ⇒ org policy (org-owned or inherited) → org queue.
   */
  scope: 'org' | 'member';
  /**
   * DS-04: the owning user for a member (personal) connection. Set only when
   * `scope === 'member'`; NULL for org/inherited connections. The materializer
   * keys the personal queue on this id.
   */
  ownerUserId: string | null;
}

export interface DocusignDocumentSinkResult {
  queuedId: string;
}

export interface DocusignStoredConnection {
  integrationId: string;
  accountId: string;
  accountLabel: string | null;
}

export interface DocusignConnectionStoreInput {
  orgId: string;
  accountId: string;
  accountLabel: string | null;
  baseUri: string;
  tokens: {
    access_token: string;
    refresh_token?: string;
    token_type?: string;
    expires_at?: string;
    scope?: string;
  };
}

export interface CompleteDocusignOAuthDeps extends DocusignClientDeps {
  storeConnection: (input: DocusignConnectionStoreInput) => Promise<DocusignStoredConnection>;
}

export interface DocusignEnvelopeJobDeps extends DocusignClientDeps {
  resolveConnection: (
    payload: DocusignEnvelopeCompletedJobPayloadT,
  ) => Promise<DocusignResolvedConnection>;
  enqueueSignedDocument: (input: {
    orgId: string;
    integrationId: string;
    accountId: string;
    envelopeId: string;
    ruleEventId: string;
    documentBytes: Buffer;
    contentType: string | null;
    sourceTimestamp: string | null;
    // DS-04 (SCRUM-2364): personal-vs-org queue routing. `scope` is 'member' for
    // a per-member connection (materialize into that user's personal queue via
    // `ownerUserId`) and 'org' for org-policy connections. Optional for callers
    // that predate DS-04 — the materializer defaults to 'org' when unset.
    scope?: 'org' | 'member';
    ownerUserId?: string | null;
  }) => Promise<DocusignDocumentSinkResult>;
}

export function parseDocusignEnvelopeCompletedJobPayload(
  payload: unknown,
): DocusignEnvelopeCompletedJobPayloadT {
  return DocusignEnvelopeCompletedJobPayload.parse(payload);
}

function tokenExpiresAt(tokens: DocusignTokenResponseT): string | undefined {
  return tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : undefined;
}

export async function completeDocusignOAuthConnection(args: {
  orgId: string;
  code: string;
  redirectUri: string;
  deps: CompleteDocusignOAuthDeps;
}): Promise<DocusignStoredConnection> {
  const tokens = await exchangeDocusignCode({
    code: args.code,
    redirectUri: args.redirectUri,
    deps: args.deps,
  });
  const info = await getDocusignUserInfo({
    accessToken: tokens.access_token,
    deps: args.deps,
  });
  const account = info.accounts.find((candidate) => candidate.is_default) ?? info.accounts[0];
  if (!account) {
    throw new Error('DocuSign userinfo did not include an account');
  }

  return args.deps.storeConnection({
    orgId: args.orgId,
    accountId: account.account_id,
    accountLabel: account.account_name ?? null,
    baseUri: account.base_uri,
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: tokens.token_type,
      expires_at: tokenExpiresAt(tokens),
      scope: tokens.scope,
    },
  });
}

export async function processDocusignEnvelopeCompletedJob(
  payload: unknown,
  deps: DocusignEnvelopeJobDeps,
): Promise<DocusignDocumentSinkResult> {
  const parsed = parseDocusignEnvelopeCompletedJobPayload(payload);
  const connection = await deps.resolveConnection(parsed);
  const document = await fetchDocusignCombinedDocument({
    baseUri: connection.baseUri,
    accountId: parsed.account_id,
    envelopeId: parsed.envelope_id,
    accessToken: connection.accessToken,
    deps,
  });

  return deps.enqueueSignedDocument({
    orgId: parsed.org_id,
    integrationId: parsed.integration_id,
    accountId: parsed.account_id,
    envelopeId: parsed.envelope_id,
    ruleEventId: parsed.rule_event_id,
    documentBytes: document.bytes,
    contentType: document.contentType,
    sourceTimestamp: parsed.envelope_completed_at ?? null,
    // DS-04 (SCRUM-2364): forward the resolved queue routing so a member-owned
    // envelope materializes into the owning user's personal queue.
    scope: connection.scope,
    ownerUserId: connection.ownerUserId,
  });
}
