/**
 * Adobe Sign refresh-token storage (SCRUM-1148 follow-up).
 *
 * Same split as DocuSign (`docusign-token-store.ts`): the short-lived ACCESS
 * token is KMS-encrypted into `org_integrations.encrypted_tokens`, while the
 * long-lived REFRESH token lives in GCP Secret Manager and Postgres stores only
 * the secret's resource name in `token_secret_name`.
 *
 * The Secret Manager CLIENT itself is provider-agnostic — it takes a resource
 * name and does GET/addVersion/DELETE — so it is REUSED from the DocuSign
 * module rather than copy-pasted here. Only the NAME derivation is
 * provider-specific, and that is what this file adds. Duplicating ~150 lines of
 * Secret Manager plumbing to avoid a slightly DocuSign-flavoured filename would
 * fail the Sonar new-code duplication gate and give two implementations to keep
 * in sync; a comment is cheaper than a fork.
 */
import { createHash } from 'node:crypto';

import {
  createGcpSecretManagerRefreshTokenStore,
  resolveDocusignSecretManagerProjectId,
  type DocusignRefreshTokenStore,
  type GcpSecretManagerRefreshTokenStoreDeps,
} from './docusign-token-store.js';

/** Provider-neutral alias — the store contract has nothing DocuSign-specific in it. */
export type AdobeSignRefreshTokenStore = DocusignRefreshTokenStore;

const SAFE_PROJECT_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const SAFE_ORG_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeSegment(value: string, label: string, pattern: RegExp): string {
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) {
    throw new Error(`${label} contains characters that are not safe for a Secret Manager resource name`);
  }
  return trimmed;
}

/**
 * Resolve the GCP project that holds Adobe Sign refresh-token secrets.
 *
 * Identical resolution order to DocuSign (explicit override → the standard
 * GOOGLE_CLOUD_PROJECT family → the project embedded in the KMS key name), so
 * both connectors land in the same project without a second env var to keep
 * aligned.
 */
export function resolveAdobeSignSecretManagerProjectId(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDocusignSecretManagerProjectId(env);
}

/**
 * Build the Secret Manager resource name for one org's Adobe refresh token.
 *
 * The account id is HASHED rather than embedded: Adobe account/user ids are not
 * secret, but they are third-party identifiers and a Secret Manager resource
 * name is visible to anyone with list permission on the project. Hashing keeps
 * the name stable and collision-free without publishing the mapping. Mirrors
 * `buildDocusignRefreshTokenSecretName`.
 */
export function buildAdobeSignRefreshTokenSecretName(args: {
  projectId: string;
  orgId: string;
  accountId: string;
}): string {
  const projectId = assertSafeSegment(args.projectId, 'projectId', SAFE_PROJECT_RE);
  const orgId = assertSafeSegment(args.orgId, 'orgId', SAFE_ORG_RE);
  const accountHash = createHash('sha256').update(args.accountId, 'utf8').digest('hex').slice(0, 32);
  return `projects/${projectId}/secrets/arkova-adobe-sign-${orgId}-${accountHash}-refresh-token`;
}

/** Re-export of the shared, provider-agnostic Secret Manager store. */
export function createAdobeSignRefreshTokenStore(
  deps: GcpSecretManagerRefreshTokenStoreDeps = {},
): AdobeSignRefreshTokenStore {
  return createGcpSecretManagerRefreshTokenStore(deps);
}
