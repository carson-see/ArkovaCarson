import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('../../../config.js', () => ({
  config: {},
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  extractDocusignSignatures,
  verifyDocusignConnectHmacMultiKey,
} from '../../../integrations/oauth/docusign-hmac.js';
import {
  resolveHmacKeys,
  type HmacKeyEntry,
} from './docusign-hmac-helpers.js';

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

const BODY = '{"event":"envelope-completed"}';
const ENV_KEY = 'env-level-hmac-secret-000';
const ORG_KEY_A = 'org-key-alpha-111';
const ORG_KEY_B = 'org-key-bravo-222';

describe('extractDocusignSignatures', () => {
  it('extracts numbered signature headers', () => {
    const headers: Record<string, string> = {
      'x-docusign-signature-1': sign(BODY, 'key1'),
      'x-docusign-signature-2': sign(BODY, 'key2'),
    };
    const sigs = extractDocusignSignatures(headers);
    expect(sigs).toHaveLength(2);
  });

  it('returns empty array when no signature headers', () => {
    expect(extractDocusignSignatures({})).toEqual([]);
  });

  it('stops at first missing index', () => {
    const headers: Record<string, string> = {
      'x-docusign-signature-1': 'sig1',
      'x-docusign-signature-3': 'sig3',
    };
    expect(extractDocusignSignatures(headers)).toHaveLength(1);
  });
});

describe('resolveHmacKeys', () => {
  it('returns org keys when hmac_keys is populated', () => {
    const hmacKeys: HmacKeyEntry[] = [
      { key: ORG_KEY_A, created_at: '2026-01-01T00:00:00Z' },
      { key: ORG_KEY_B, created_at: '2026-05-01T00:00:00Z' },
    ];
    const keys = resolveHmacKeys(hmacKeys, ENV_KEY);
    expect(keys).toEqual([ORG_KEY_A, ORG_KEY_B]);
  });

  it('falls back to env key when hmac_keys is null', () => {
    const keys = resolveHmacKeys(null, ENV_KEY);
    expect(keys).toEqual([ENV_KEY]);
  });

  it('falls back to env key when hmac_keys is empty array', () => {
    const keys = resolveHmacKeys([], ENV_KEY);
    expect(keys).toEqual([ENV_KEY]);
  });

  it('returns empty when hmac_keys is null and no env key', () => {
    const keys = resolveHmacKeys(null, undefined);
    expect(keys).toEqual([]);
  });

  it('filters entries with missing key field', () => {
    const hmacKeys = [
      { key: ORG_KEY_A, created_at: '2026-01-01T00:00:00Z' },
      { key: '', created_at: '2026-05-01T00:00:00Z' },
    ] as HmacKeyEntry[];
    const keys = resolveHmacKeys(hmacKeys, ENV_KEY);
    expect(keys).toEqual([ORG_KEY_A]);
  });
});

describe('lookup-first HMAC verification flow', () => {
  it('verifies with org-level key after integration lookup', () => {
    const sig = sign(BODY, ORG_KEY_A);
    const keys = resolveHmacKeys(
      [{ key: ORG_KEY_A, created_at: '2026-01-01T00:00:00Z' }],
      ENV_KEY,
    );
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: BODY,
        signatures: [sig],
        keys,
      }),
    ).toBe(true);
  });

  it('verifies with env fallback when integration has no hmac_keys', () => {
    const sig = sign(BODY, ENV_KEY);
    const keys = resolveHmacKeys(null, ENV_KEY);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: BODY,
        signatures: [sig],
        keys,
      }),
    ).toBe(true);
  });

  it('rejects when org key does not match env-signed payload', () => {
    const sig = sign(BODY, ENV_KEY);
    const keys = resolveHmacKeys(
      [{ key: ORG_KEY_A, created_at: '2026-01-01T00:00:00Z' }],
      ENV_KEY,
    );
    // org keys take precedence — env key is NOT included when org keys exist
    expect(keys).toEqual([ORG_KEY_A]);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: BODY,
        signatures: [sig],
        keys,
      }),
    ).toBe(false);
  });

  it('dual-key rotation: both old and new keys verify', () => {
    const sigOld = sign(BODY, ORG_KEY_A);
    const sigNew = sign(BODY, ORG_KEY_B);
    const keys = resolveHmacKeys(
      [
        { key: ORG_KEY_A, created_at: '2026-01-01T00:00:00Z' },
        { key: ORG_KEY_B, created_at: '2026-05-27T00:00:00Z' },
      ],
      ENV_KEY,
    );
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: BODY,
        signatures: [sigOld, sigNew],
        keys,
      }),
    ).toBe(true);
  });
});
