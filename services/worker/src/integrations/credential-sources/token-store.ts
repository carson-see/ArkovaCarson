/**
 * Credential-source provider token-store — SCRUM-1611 CSI-04A foundation.
 *
 * Sprint 1 of the SCRUM-1596 Credential Source Import epic. Provides a thin
 * wrapper around `services/worker/src/integrations/oauth/crypto.ts` (the
 * SCRUM-1168 KMS crypto module) so that Credly, Accredible, and Udemy
 * tokens can be stored in `member_integrations` alongside the existing
 * DocuSign rows.
 *
 * Why this is a wrapper and not a new crypto path:
 *   - The existing direct-KMS pattern (one Google KMS round-trip per
 *     encrypt/decrypt) already satisfies the PRD §7.3 "AES-256-GCM" +
 *     "per-row IV" requirements (Google KMS handles both internally).
 *   - Reusing the org_integrations precedent keeps the SOC 2 audit story
 *     short: one encryption pattern across every OAuth integration.
 *   - Envelope encryption with per-row DEKs is a known optimisation we
 *     can adopt later (`kek_version` column on the table makes that
 *     non-breaking) once KMS quota or latency justifies it.
 *
 * Constitution refs:
 *   - 1.4: KMS-backed encryption (not env-var symmetric keys); never log tokens.
 *   - 1.7: tests must not call real KMS — inject a fake `KmsClient`.
 */
import { z } from 'zod';

import {
  type KmsClient,
  type OAuthTokens,
  OAuthTokensSchema,
  encryptTokens,
  decryptTokens,
  getIntegrationTokenKeyName,
} from '../oauth/crypto.js';

/**
 * Issuer credentials for OAuth 2.0 `client_credentials` grant flows
 * (Credly, Accredible API-key, Udemy Business xAPI). Distinct from
 * `OAuthTokens` because these flows have no end-user authorisation code or
 * refresh token — the credentials are the durable issuer-app secret, and
 * the access token is a cache that the worker re-mints on expiry.
 *
 * Stored in the same `encrypted_tokens` bytea column as the existing
 * DocuSign refresh tokens. The `provider` column on `member_integrations`
 * discriminates which shape lives inside.
 */
export const IssuerCredentialsSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  /** Cached access token from the most recent client_credentials exchange. */
  access_token: z.string().optional(),
  /** ISO 8601 expiry of the cached access token. Re-mint past this. */
  expires_at: z.string().optional(),
  /** Optional space-delimited scope claim. Credly: 'issued_badges'. */
  scope: z.string().optional(),
});

export type IssuerCredentials = z.infer<typeof IssuerCredentialsSchema>;

/**
 * Supported credential-source providers. Mirrors the widened CHECK constraint
 * established by migration 0329. Adding a new provider requires:
 *   1. A new migration that widens the CHECK constraint
 *   2. Updating this union (and the runtime guard below)
 */
export type CredentialProvider = 'credly' | 'accredible' | 'udemy';

const SUPPORTED_CREDENTIAL_PROVIDERS: ReadonlyArray<CredentialProvider> = [
  'credly',
  'accredible',
  'udemy',
];

function assertSupportedProvider(p: string): asserts p is CredentialProvider {
  if (!SUPPORTED_CREDENTIAL_PROVIDERS.includes(p as CredentialProvider)) {
    throw new Error(
      `Unsupported credential provider: "${p}". ` +
        `Supported providers: ${SUPPORTED_CREDENTIAL_PROVIDERS.join(', ')}.`,
    );
  }
}

/**
 * Row-store abstraction over `member_integrations`. Defined here (rather than
 * coupling to supabase-js directly) so unit tests can inject an in-memory fake
 * without touching a Postgres instance. Production wiring lives in the
 * adapter layer that consumes this module.
 */
export interface MemberIntegrationRowDeps {
  upsertEncryptedRow(input: {
    userId: string;
    orgId: string;
    provider: CredentialProvider | 'docusign';
    accountId: string;
    ciphertext: Buffer;
    kmsKeyName: string;
    kekVersion: number;
  }): Promise<{ id: string }>;

  fetchEncryptedRow(input: {
    userId: string;
    orgId: string;
    provider: CredentialProvider | 'docusign';
    accountId: string;
  }): Promise<{
    ciphertext: Buffer;
    kmsKeyName: string;
    kekVersion: number;
  } | null>;
}

/** Default KEK version for new rows. Migration 0329 sets the same default. */
const DEFAULT_KEK_VERSION = 1;

const StoreCredentialProviderTokenIdsSchema = z.object({
  userId: z.string().uuid(),
  orgId: z.string().uuid(),
});

export interface StoreTokensInput {
  userId: string;
  orgId: string;
  provider: CredentialProvider;
  accountId: string;
  tokens: OAuthTokens;
  /** Optional override. Defaults to 1 — matches migration 0329. */
  kekVersion?: number;
}

export interface StoreTokensDeps {
  kms: KmsClient;
  /** Optional override — defaults to the env-resolved key name. */
  keyName?: string;
  rowStore: MemberIntegrationRowDeps;
  env?: NodeJS.ProcessEnv;
}

/**
 * Encrypt and persist a credential-source provider's OAuth tokens.
 *
 * Validates `provider` against the supported enum (defence-in-depth alongside
 * the migration 0329 CHECK constraint).
 *
 * Stores `kek_version` so a future KMS key rotation can identify which key
 * wrapped each row without forcing an immediate re-encrypt sweep
 * (RFC 9700 best practice).
 */
export async function storeCredentialProviderTokens(
  input: StoreTokensInput,
  deps: StoreTokensDeps,
): Promise<{ id: string }> {
  // Runtime guard — TS prevents the wrong type at compile time but the type
  // assertion above (`as any` in callers) can slip through.
  assertSupportedProvider(input.provider);

  const ids = StoreCredentialProviderTokenIdsSchema.parse({
    userId: input.userId,
    orgId: input.orgId,
  });

  // Validate the token shape before we encrypt — saves a KMS round-trip
  // on malformed input.
  const parsed = OAuthTokensSchema.parse(input.tokens);

  const keyName = deps.keyName ?? getIntegrationTokenKeyName(deps.env);
  const { ciphertext } = await encryptTokens(parsed, {
    kms: deps.kms,
    keyName,
    env: deps.env,
  });

  return deps.rowStore.upsertEncryptedRow({
    userId: ids.userId,
    orgId: ids.orgId,
    provider: input.provider,
    accountId: input.accountId,
    ciphertext,
    kmsKeyName: keyName,
    kekVersion: input.kekVersion ?? DEFAULT_KEK_VERSION,
  });
}

export interface ReadTokensInput {
  userId: string;
  orgId: string;
  provider: CredentialProvider;
  accountId: string;
}

export interface ReadTokensDeps {
  kms: KmsClient;
  rowStore: MemberIntegrationRowDeps;
}

/**
 * Read and decrypt tokens for a credential-source provider integration.
 * Returns null if no row exists for (user, org, provider, account).
 *
 * Uses the row-recorded `kmsKeyName` (not the env default) so rows wrapped
 * by an older KEK can still be decrypted during rotation windows.
 */
export async function readCredentialProviderTokens(
  input: ReadTokensInput,
  deps: ReadTokensDeps,
): Promise<OAuthTokens | null> {
  assertSupportedProvider(input.provider);

  const row = await deps.rowStore.fetchEncryptedRow({
    userId: input.userId,
    orgId: input.orgId,
    provider: input.provider,
    accountId: input.accountId,
  });
  if (!row) return null;

  // Decrypt against the key the row was wrapped with — supports rotation.
  return decryptTokens(row.ciphertext, {
    kms: deps.kms,
    keyName: row.kmsKeyName,
  });
}

// ---------------------------------------------------------------------------
// Issuer credentials variant (client_credentials providers — Credly etc.)
// ---------------------------------------------------------------------------

export interface StoreIssuerCredentialsInput {
  userId: string;
  orgId: string;
  provider: CredentialProvider;
  accountId: string;
  credentials: IssuerCredentials;
  kekVersion?: number;
}

/**
 * Encrypt and persist client_credentials issuer secrets (client_id +
 * client_secret + optional cached access_token) into `member_integrations`.
 *
 * Same KMS-backed encryption path as `storeCredentialProviderTokens` but
 * accepts the issuer-credentials shape. Choose this for Credly /
 * Accredible-API-key / Udemy-Business-xAPI flows; choose
 * `storeCredentialProviderTokens` for end-user OAuth refresh-token flows.
 */
export async function storeIssuerCredentials(
  input: StoreIssuerCredentialsInput,
  deps: StoreTokensDeps,
): Promise<{ id: string }> {
  assertSupportedProvider(input.provider);

  const parsed = IssuerCredentialsSchema.parse(input.credentials);
  const keyName = deps.keyName ?? getIntegrationTokenKeyName(deps.env);

  // Reuse the OAuth crypto module's primitives: encrypt the JSON blob bytes
  // directly. We are NOT calling encryptTokens (which assumes OAuthTokens
  // shape) because the issuer-credentials shape includes client_secret.
  const plaintext = Buffer.from(JSON.stringify(parsed), 'utf8');
  const ciphertext = await deps.kms.encrypt({ keyName, plaintext });

  return deps.rowStore.upsertEncryptedRow({
    userId: input.userId,
    orgId: input.orgId,
    provider: input.provider,
    accountId: input.accountId,
    ciphertext,
    kmsKeyName: keyName,
    kekVersion: input.kekVersion ?? DEFAULT_KEK_VERSION,
  });
}

/**
 * Read and decrypt client_credentials issuer secrets. Returns null if no row
 * exists for (user, org, provider, account). Uses the row-recorded
 * `kmsKeyName` to support KEK rotation windows.
 */
export async function readIssuerCredentials(
  input: ReadTokensInput,
  deps: ReadTokensDeps,
): Promise<IssuerCredentials | null> {
  assertSupportedProvider(input.provider);

  const row = await deps.rowStore.fetchEncryptedRow({
    userId: input.userId,
    orgId: input.orgId,
    provider: input.provider,
    accountId: input.accountId,
  });
  if (!row) return null;

  const plaintext = await deps.kms.decrypt({
    keyName: row.kmsKeyName,
    ciphertext: row.ciphertext,
  });
  let json: unknown;
  try {
    json = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Decrypted issuer-credentials payload is not valid JSON');
  }
  return IssuerCredentialsSchema.parse(json);
}
