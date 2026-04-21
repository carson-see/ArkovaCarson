/**
 * Tests for ARK-110 NL rule draft guardrails.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) },
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildDraftRule, type RuleDraftProvider } from './rules-draft.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function fixedProvider(out: Parameters<RuleDraftProvider['propose']>[0] extends unknown ? unknown : never,
): RuleDraftProvider {
  void out;
  throw new Error('unused');
}

function mockProvider(
  proposal: {
    candidate: Record<string, unknown>;
    confidence?: number;
    warnings?: string[];
  },
): RuleDraftProvider {
  return {
    async propose() {
      return {
        candidate: proposal.candidate as Parameters<
          typeof buildDraftRule
        >[0]['provider'] extends unknown
          ? never
          : never,
        confidence: proposal.confidence ?? 0.9,
        warnings: proposal.warnings ?? [],
      } as unknown as Awaited<ReturnType<RuleDraftProvider['propose']>>;
    },
  };
}

describe('buildDraftRule — accepts valid drafts', () => {
  it('returns validated draft with enabled forced to false', async () => {
    const provider = mockProvider({
      candidate: {
        name: 'Anchor Acme DocuSigns',
        trigger_type: 'ESIGN_COMPLETED',
        trigger_config: { vendors: ['docusign'], sender_email_equals: 'deals@acme.com' },
        action_type: 'AUTO_ANCHOR',
        action_config: { tag: 'acme' },
        enabled: true, // provider tried to enable — forced to false below
      },
      confidence: 0.91,
    });
    const r = await buildDraftRule({
      sanitizedInput: 'Anchor every DocuSign from Acme',
      orgId: ORG_ID,
      provider,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft_rule.enabled).toBe(false);
      expect(r.draft_rule.org_id).toBe(ORG_ID);
      expect(r.warnings).not.toContain('Low confidence — please review each field carefully before saving.');
    }
  });

  it('adds low-confidence warning when provider confidence < 0.7', async () => {
    const provider = mockProvider({
      candidate: {
        name: 'Guess',
        trigger_type: 'MANUAL_UPLOAD',
        trigger_config: {},
        action_type: 'QUEUE_FOR_REVIEW',
        action_config: {},
        enabled: false,
      },
      confidence: 0.5,
    });
    const r = await buildDraftRule({ sanitizedInput: 'x', orgId: ORG_ID, provider });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => /confidence/i.test(w))).toBe(true);
    }
  });
});

describe('buildDraftRule — blocks unreviewable action types', () => {
  it('rejects FORWARD_TO_URL with 422', async () => {
    const provider = mockProvider({
      candidate: {
        name: 'Send to ops',
        trigger_type: 'MANUAL_UPLOAD',
        trigger_config: {},
        action_type: 'FORWARD_TO_URL',
        action_config: { target_url: 'https://evil.example.com', hmac_secret_handle: 'sm:x' },
        enabled: false,
      },
      confidence: 0.9,
    });
    const r = await buildDraftRule({ sanitizedInput: 'x', orgId: ORG_ID, provider });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.code).toBe('blocked_action');
    }
  });
});

describe('buildDraftRule — rejects schema mismatches', () => {
  it('422s when provider returns nonsense', async () => {
    const provider = mockProvider({
      candidate: { foo: 'bar' }, // no required fields
      confidence: 0.8,
    });
    const r = await buildDraftRule({ sanitizedInput: 'x', orgId: ORG_ID, provider });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it('422s when provider inlines a secret', async () => {
    const provider = mockProvider({
      candidate: {
        name: 'Leaky',
        trigger_type: 'MANUAL_UPLOAD',
        trigger_config: {},
        action_type: 'NOTIFY',
        action_config: {
          channels: ['email'],
          recipient_emails: ['ops@acme.com'],
          recipient_user_ids: [],
          // inline secret — should trip assertNoInlineSecrets
          api_key: 'abcd1234',
        },
        enabled: false,
      },
      confidence: 0.9,
    });
    const r = await buildDraftRule({ sanitizedInput: 'x', orgId: ORG_ID, provider });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.code).toBe('invalid_config');
    }
  });
});

describe('buildDraftRule — provider failures', () => {
  it('returns 503 when the provider throws', async () => {
    const provider: RuleDraftProvider = {
      async propose() {
        throw new Error('gemini down');
      },
    };
    const r = await buildDraftRule({ sanitizedInput: 'x', orgId: ORG_ID, provider });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.code).toBe('provider_unavailable');
    }
  });
});

describe('buildDraftRule — org_id forced from caller', () => {
  it('overrides any org_id the provider returned', async () => {
    const provider = mockProvider({
      candidate: {
        name: 'test',
        org_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', // NOT the caller's org
        trigger_type: 'MANUAL_UPLOAD',
        trigger_config: {},
        action_type: 'QUEUE_FOR_REVIEW',
        action_config: {},
        enabled: false,
      },
      confidence: 0.9,
    });
    const r = await buildDraftRule({ sanitizedInput: 'x', orgId: ORG_ID, provider });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft_rule.org_id).toBe(ORG_ID);
  });
});

// keep the unused-import linter happy
void fixedProvider;
