/**
 * Credential-source provider token-store unit tests — SCRUM-1611 CSI-04A.
 *
 * Scope: thin wrapper around `services/worker/src/integrations/oauth/crypto.ts`
 * (SCRUM-1168 KMS module) that handles `member_integrations` rows for
 * credential-source providers (credly, accredible, udemy). Tests use a fake
 * KMS client so no real GCP traffic occurs.
 *
 * TDD red→green pin per CLAUDE.md §0 rule 1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  storeCredentialProviderTokens,
  readCredentialProviderTokens,
  type CredentialProvider,
  type MemberIntegrationRowDeps,
} from './token-store.js';
import type { OAuthTokens } from '../oauth/crypto.js';

const ARKOVA_ORG_ID = '00000000-0000-0000-0000-000000000001';
const ARKOVA_USER_ID = '00000000-0000-0000-0000-000000000010';
const TEST_KEY_NAME =
  'projects/test-arkova/locations/global/keyRings/test/cryptoKeys/integration-tokens';

const sampleTokens: OAuthTokens = {
  access_token: 'AAAA-access-token-1234',
  refresh_token: 'RRRR-refresh-token-5678',
  token_type: 'Bearer',
  expires_at: '2026-07-01T00:00:00Z',
  scope: 'read:badges',
};

function makeFakeKms(): {
  encrypt: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
} {
  // Simulate KMS: ciphertext = plaintext reversed (deterministic, non-trivial).
  return {
    encrypt: vi.fn(async ({ plaintext }: { plaintext: Buffer }) => {
      return Buffer.from(plaintext).reverse();
    }),
    decrypt: vi.fn(async ({ ciphertext }: { ciphertext: Buffer }) => {
      return Buffer.from(ciphertext).reverse();
    }),
  };
}

/**
 * In-memory member_integrations rows for tests. The deps interface lets
 * the production code stay decoupled from supabase-js.
 */
type Row = {
  id: string;
  user_id: string;
  org_id: string;
  provider: CredentialProvider | 'docusign';
  account_id: string;
  encrypted_tokens: Buffer | null;
  token_kms_key_id: string | null;
  kek_version: number;
};

function makeFakeStore(): {
  rows: Row[];
  deps: MemberIntegrationRowDeps;
} {
  const rows: Row[] = [];
  const deps: MemberIntegrationRowDeps = {
    async upsertEncryptedRow(input) {
      const existing = rows.find(
        (r) =>
          r.user_id === input.userId &&
          r.org_id === input.orgId &&
          r.provider === input.provider &&
          r.account_id === input.accountId,
      );
      if (existing) {
        existing.encrypted_tokens = input.ciphertext;
        existing.token_kms_key_id = input.kmsKeyName;
        existing.kek_version = input.kekVersion;
        return { id: existing.id };
      }
      const id = `row-${rows.length + 1}`;
      rows.push({
        id,
        user_id: input.userId,
        org_id: input.orgId,
        provider: input.provider,
        account_id: input.accountId,
        encrypted_tokens: input.ciphertext,
        token_kms_key_id: input.kmsKeyName,
        kek_version: input.kekVersion,
      });
      return { id };
    },
    async fetchEncryptedRow(input) {
      const row = rows.find(
        (r) =>
          r.user_id === input.userId &&
          r.org_id === input.orgId &&
          r.provider === input.provider &&
          r.account_id === input.accountId,
      );
      if (!row || !row.encrypted_tokens || !row.token_kms_key_id) return null;
      return {
        ciphertext: row.encrypted_tokens,
        kmsKeyName: row.token_kms_key_id,
        kekVersion: row.kek_version,
      };
    },
  };
  return { rows, deps };
}

describe('SCRUM-1611 — credential-source token-store', () => {
  let fakeKms: ReturnType<typeof makeFakeKms>;
  let store: ReturnType<typeof makeFakeStore>;

  beforeEach(() => {
    fakeKms = makeFakeKms();
    store = makeFakeStore();
  });

  describe('storeCredentialProviderTokens', () => {
    it('encrypts the tokens and writes a member_integrations row', async () => {
      await storeCredentialProviderTokens(
        {
          userId: ARKOVA_USER_ID,
          orgId: ARKOVA_ORG_ID,
          provider: 'credly',
          accountId: 'credly-acct-1',
          tokens: sampleTokens,
        },
        {
          kms: fakeKms,
          keyName: TEST_KEY_NAME,
          rowStore: store.deps,
        },
      );

      expect(fakeKms.encrypt).toHaveBeenCalledTimes(1);
      expect(store.rows).toHaveLength(1);
      const row = store.rows[0];
      expect(row.provider).toBe('credly');
      expect(row.token_kms_key_id).toBe(TEST_KEY_NAME);
      expect(row.kek_version).toBe(1);
      expect(row.encrypted_tokens).not.toBeNull();
      // Plaintext must not be in the ciphertext (basic leak check)
      expect(row.encrypted_tokens?.toString('utf8')).not.toContain('AAAA-access-token');
    });

    it('accepts each supported credential provider', async () => {
      const providers: CredentialProvider[] = ['credly', 'accredible', 'udemy'];
      for (const provider of providers) {
        await storeCredentialProviderTokens(
          {
            userId: ARKOVA_USER_ID,
            orgId: ARKOVA_ORG_ID,
            provider,
            accountId: `${provider}-acct-1`,
            tokens: sampleTokens,
          },
          { kms: fakeKms, keyName: TEST_KEY_NAME, rowStore: store.deps },
        );
      }
      expect(store.rows.map((r) => r.provider).sort((a, b) => a.localeCompare(b))).toEqual([
        'accredible',
        'credly',
        'udemy',
      ]);
    });

    it('rejects unsupported providers at the type-runtime boundary', async () => {
      await expect(
        storeCredentialProviderTokens(
          {
            userId: ARKOVA_USER_ID,
            orgId: ARKOVA_ORG_ID,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            provider: 'linkedin' as any,
            accountId: 'linkedin-acct-1',
            tokens: sampleTokens,
          },
          { kms: fakeKms, keyName: TEST_KEY_NAME, rowStore: store.deps },
        ),
      ).rejects.toThrow(/unsupported credential provider/i);
      expect(fakeKms.encrypt).not.toHaveBeenCalled();
      expect(store.rows).toHaveLength(0);
    });

    it('records kek_version from the option (default 1)', async () => {
      await storeCredentialProviderTokens(
        {
          userId: ARKOVA_USER_ID,
          orgId: ARKOVA_ORG_ID,
          provider: 'credly',
          accountId: 'credly-acct-1',
          tokens: sampleTokens,
          kekVersion: 2,
        },
        { kms: fakeKms, keyName: TEST_KEY_NAME, rowStore: store.deps },
      );
      expect(store.rows[0].kek_version).toBe(2);
    });
  });

  describe('readCredentialProviderTokens', () => {
    it('round-trips: encrypt → store → fetch → decrypt yields original tokens', async () => {
      await storeCredentialProviderTokens(
        {
          userId: ARKOVA_USER_ID,
          orgId: ARKOVA_ORG_ID,
          provider: 'credly',
          accountId: 'credly-acct-1',
          tokens: sampleTokens,
        },
        { kms: fakeKms, keyName: TEST_KEY_NAME, rowStore: store.deps },
      );

      const result = await readCredentialProviderTokens(
        {
          userId: ARKOVA_USER_ID,
          orgId: ARKOVA_ORG_ID,
          provider: 'credly',
          accountId: 'credly-acct-1',
        },
        { kms: fakeKms, rowStore: store.deps },
      );

      expect(result).not.toBeNull();
      expect(result?.access_token).toBe(sampleTokens.access_token);
      expect(result?.refresh_token).toBe(sampleTokens.refresh_token);
      expect(result?.scope).toBe(sampleTokens.scope);
    });

    it('returns null when no row exists for the (user, org, provider, account)', async () => {
      const result = await readCredentialProviderTokens(
        {
          userId: ARKOVA_USER_ID,
          orgId: ARKOVA_ORG_ID,
          provider: 'credly',
          accountId: 'never-existed',
        },
        { kms: fakeKms, rowStore: store.deps },
      );
      expect(result).toBeNull();
      expect(fakeKms.decrypt).not.toHaveBeenCalled();
    });

    it('uses the row-recorded kmsKeyName for decrypt (supports rotation)', async () => {
      // Simulate row stored under an old key
      const oldKey = `${TEST_KEY_NAME}-v1`;
      await store.deps.upsertEncryptedRow({
        userId: ARKOVA_USER_ID,
        orgId: ARKOVA_ORG_ID,
        provider: 'credly',
        accountId: 'credly-acct-1',
        ciphertext: Buffer.from(JSON.stringify(sampleTokens), 'utf8').reverse(),
        kmsKeyName: oldKey,
        kekVersion: 1,
      });

      await readCredentialProviderTokens(
        {
          userId: ARKOVA_USER_ID,
          orgId: ARKOVA_ORG_ID,
          provider: 'credly',
          accountId: 'credly-acct-1',
        },
        { kms: fakeKms, rowStore: store.deps },
      );

      expect(fakeKms.decrypt).toHaveBeenCalledWith(
        expect.objectContaining({ keyName: oldKey }),
      );
    });
  });
});
