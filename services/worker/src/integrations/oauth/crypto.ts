/**
 * OAuth token crypto (SCRUM-1168)
 *
 * Wraps GCP KMS to encrypt/decrypt OAuth refresh tokens stored in
 * `org_integrations.encrypted_tokens`. Cleartext never lands in Postgres.
 *
 * Design choices:
 *   - Use the same GCP KMS project + keyring as the Bitcoin signing provider
 *     (see chain/gcp-kms-signing-provider) so there's one trust boundary.
 *   - Store ciphertext as bytea. Plaintext is JSON-serialised before encrypt.
 *   - Key version is identified by the full KMS resource name (written into
 *     `org_integrations.token_kms_key_id`) so we can rotate without losing
 *     historical rows.
 *
 * Constitution refs:
 *   - 1.4: never log tokens or token bodies.
 *   - 1.4: KMS-backed encryption (not env-var symmetric keys).
 */
import { z } from 'zod';

export const OAuthTokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_at: z.string().optional(), // ISO 8601
  scope: z.string().optional(),
});

export type OAuthTokens = z.infer<typeof OAuthTokensSchema>;

export interface KmsClient {
  /** Returns ciphertext bytes; the caller stores them in bytea. */
  encrypt(args: { keyName: string; plaintext: Buffer }): Promise<Buffer>;
  decrypt(args: { keyName: string; ciphertext: Buffer }): Promise<Buffer>;
}

/**
 * Default KMS client factory. Lazy-loads @google-cloud/kms so tests that
 * inject a fake client never touch the real SDK.
 */
export async function createDefaultKmsClient(): Promise<KmsClient> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@google-cloud/kms');
  const client = new mod.KeyManagementServiceClient();
  return {
    async encrypt({ keyName, plaintext }) {
      const [resp] = await client.encrypt({ name: keyName, plaintext });
      const ct = resp?.ciphertext;
      if (!ct) throw new Error('KMS encrypt returned empty ciphertext');
      return Buffer.isBuffer(ct) ? ct : Buffer.from(ct);
    },
    async decrypt({ keyName, ciphertext }) {
      const [resp] = await client.decrypt({ name: keyName, ciphertext });
      const pt = resp?.plaintext;
      if (!pt) throw new Error('KMS decrypt returned empty plaintext');
      return Buffer.isBuffer(pt) ? pt : Buffer.from(pt);
    },
  };
}

/** Read the KMS key name from env. Throws if not provisioned. */
export function getIntegrationTokenKeyName(env: NodeJS.ProcessEnv = process.env): string {
  // Reuse an existing project if present; fall back to the Bitcoin keyring
  // project so we only need one Secret Manager / KMS config path.
  const name =
    env.GCP_KMS_INTEGRATION_TOKEN_KEY ??
    env.GCP_KMS_KEY_RESOURCE_NAME;
  if (!name || name.trim() === '') {
    throw new Error(
      'GCP_KMS_INTEGRATION_TOKEN_KEY (or GCP_KMS_KEY_RESOURCE_NAME fallback) not set — provision a KMS key before connecting integrations.',
    );
  }
  return name;
}

/** Encrypt a tokens payload to a bytea-ready buffer + record the key id. */
export async function encryptTokens(
  tokens: OAuthTokens,
  deps: { kms: KmsClient; keyName?: string; env?: NodeJS.ProcessEnv } = {} as {
    kms: KmsClient;
  },
): Promise<{ ciphertext: Buffer; keyId: string }> {
  const env = deps.env ?? process.env;
  const keyName = deps.keyName ?? getIntegrationTokenKeyName(env);
  const payload = Buffer.from(JSON.stringify(tokens), 'utf8');
  const ciphertext = await deps.kms.encrypt({ keyName, plaintext: payload });
  return { ciphertext, keyId: keyName };
}

/** Decrypt a bytea ciphertext back into an OAuthTokens object. */
export async function decryptTokens(
  ciphertext: Buffer,
  deps: { kms: KmsClient; keyName: string },
): Promise<OAuthTokens> {
  const plaintext = await deps.kms.decrypt({ keyName: deps.keyName, ciphertext });
  let json: unknown;
  try {
    json = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Decrypted token payload is not valid JSON');
  }
  return OAuthTokensSchema.parse(json);
}
