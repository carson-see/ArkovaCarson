/**
 * SCRUM-2094 [DS-VOL-01] — unit tests for the synthetic DocuSign Connect
 * load-payload generator.
 *
 * The whole value of this module is that the payloads the k6 harness fires are
 * *accepted by the real receiver* — otherwise a volume run measures 401s, not
 * the ingestion path. So every test here cross-validates the generator against
 * the SAME production code the webhook handler uses:
 *   - parseDocusignConnectPayload  (oauth/docusign.ts)        — payload shape
 *   - verifyDocusignConnectHmacMultiKey (oauth/docusign-hmac.ts) — signature
 *   - extractNotaryData (webhooks/docusign.ts)                 — notary leg
 *
 * Signing parity: the k6 script signs with k6/crypto.hmac('sha256', …, 'base64')
 * and the worker verifies a base64 HMAC-SHA256 over the raw bytes. Here we
 * reproduce that signature with node:crypto over the EXACT bytes
 * serializeConnectPayload() produces, then assert the real verifier accepts it.
 */
import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

// extractNotaryData lives in webhooks/docusign.ts, which transitively imports
// utils/db.ts → config.ts (env-validated at module load). We only exercise the
// PURE parse/verify/notary surface here, so stub those side-effecting modules —
// the same db/jobQueue/logger mock trio the receiver's own test suite uses.
vi.mock('../../../src/utils/db.js', () => ({
  db: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('../../../src/utils/jobQueue.js', () => ({
  submitJob: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DEFAULT_MIX,
  pickScenario,
  buildSyntheticConnectPayload,
  serializeConnectPayload,
} from './docusign-synth.js';

import { parseDocusignConnectPayload } from '../../../src/integrations/oauth/docusign.js';
import { verifyDocusignConnectHmacMultiKey } from '../../../src/integrations/oauth/docusign-hmac.js';
import { extractNotaryData } from '../../../src/api/v1/webhooks/docusign.js';

/** Deterministic PRNG so the mix-ratio assertion is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function signBase64(body: string, key: string): string {
  return crypto.createHmac('sha256', key).update(Buffer.from(body)).digest('base64');
}

describe('DEFAULT_MIX', () => {
  it('puts DocuSign at the 15% production mix and sums to 1', () => {
    expect(DEFAULT_MIX.docusign).toBeCloseTo(0.15, 10);
    const sum = DEFAULT_MIX.health + DEFAULT_MIX.verify + DEFAULT_MIX.docusign;
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('pickScenario', () => {
  it('maps cumulative ranges to scenarios deterministically', () => {
    // DEFAULT_MIX: health [0,0.5), verify [0.5,0.85), docusign [0.85,1)
    expect(pickScenario(0)).toBe('health');
    expect(pickScenario(0.49)).toBe('health');
    expect(pickScenario(0.5)).toBe('verify');
    expect(pickScenario(0.84)).toBe('verify');
    expect(pickScenario(0.85)).toBe('docusign');
    expect(pickScenario(0.999)).toBe('docusign');
  });

  it('honors a custom mix', () => {
    const mix = { health: 0.2, verify: 0.3, docusign: 0.5 };
    expect(pickScenario(0.19, mix)).toBe('health');
    expect(pickScenario(0.49, mix)).toBe('verify');
    expect(pickScenario(0.5, mix)).toBe('docusign');
  });

  it('produces ~15% docusign over a large sample', () => {
    const rng = mulberry32(0xc0ffee);
    const n = 40_000;
    let docusign = 0;
    for (let i = 0; i < n; i++) {
      if (pickScenario(rng()) === 'docusign') docusign++;
    }
    expect(docusign / n).toBeGreaterThan(0.14);
    expect(docusign / n).toBeLessThan(0.16);
  });
});

describe('buildSyntheticConnectPayload', () => {
  it('is accepted by the real parseDocusignConnectPayload', () => {
    const payload = buildSyntheticConnectPayload({
      accountId: 'acct-123',
      envelopeId: 'env-abc',
      eventId: 'evt-1',
      generatedDateTime: '2026-05-29T00:00:00.000Z',
      documentCount: 3,
    });
    const parsed = parseDocusignConnectPayload(serializeConnectPayload(payload));
    expect(parsed.event).toBe('envelope-completed');
    expect(parsed.status).toBe('completed');
    expect(parsed.accountId).toBe('acct-123');
    expect(parsed.envelopeId).toBe('env-abc');
    expect(parsed.eventId).toBe('evt-1');
    expect(parsed.envelopeDocuments).toHaveLength(3);
  });

  it('defaults to a single document and a non-PII synthetic sender', () => {
    const payload = buildSyntheticConnectPayload({
      accountId: 'a',
      envelopeId: 'e',
    });
    const parsed = parseDocusignConnectPayload(serializeConnectPayload(payload));
    expect(parsed.envelopeDocuments).toHaveLength(1);
    // synthetic sender must be an obvious non-real, non-PII address
    expect(parsed.sender?.email).toMatch(/@example\.com$/);
  });

  it('is byte-for-byte deterministic for identical inputs (stable signature)', () => {
    const args = { accountId: 'a', envelopeId: 'e', eventId: 'x', generatedDateTime: 't' };
    expect(serializeConnectPayload(buildSyntheticConnectPayload(args))).toBe(
      serializeConnectPayload(buildSyntheticConnectPayload(args)),
    );
  });

  it('emits a payload whose base64 HMAC-SHA256 the real verifier accepts', () => {
    const key = 'test-connect-hmac-key';
    const body = serializeConnectPayload(
      buildSyntheticConnectPayload({ accountId: 'a', envelopeId: 'e' }),
    );
    const signature = signBase64(body, key);

    expect(
      verifyDocusignConnectHmacMultiKey({ rawBody: body, signatures: [signature], keys: [key] }),
    ).toBe(true);
    // wrong key must NOT verify
    expect(
      verifyDocusignConnectHmacMultiKey({ rawBody: body, signatures: [signature], keys: ['nope'] }),
    ).toBe(false);
  });

  it('withNotary produces a payload the real extractNotaryData recognizes', () => {
    const payload = buildSyntheticConnectPayload({
      accountId: 'a',
      envelopeId: 'e',
      generatedDateTime: '2026-05-29T00:00:00.000Z',
      withNotary: true,
    });
    const notary = extractNotaryData(serializeConnectPayload(payload));
    expect(notary).not.toBeNull();
    expect(notary?.notary_name).toBeTruthy();
    expect(notary?.notary_commission_state).toBeTruthy();
  });

  it('without notary, extractNotaryData returns null', () => {
    const payload = buildSyntheticConnectPayload({ accountId: 'a', envelopeId: 'e' });
    expect(extractNotaryData(serializeConnectPayload(payload))).toBeNull();
  });
});
