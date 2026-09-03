/**
 * docusign-bilateral-2026-08 (CTO Decision Record, R9) — cross-validation
 * tests for the bilateral soak-payload generators added to docusign-synth.js.
 *
 * Same mandate as the existing docusign-synth.test.ts: the whole value of
 * this harness is that its payloads are *accepted by the real receiver* — a
 * volume run against a shape the receiver rejects measures 401s, not the
 * ingestion path. This file cross-validates against the real receiver code
 * where that code ALREADY EXISTS on `main` today (`parseDocusignConnectPayload`,
 * `verifyDocusignConnectHmacMultiKey` — unchanged surface, still exactly what
 * production runs), and separately, clearly, PINS a transcribed contract for
 * the pieces that do not exist yet.
 *
 * IMPORTANT — PR STATE AT TIME OF WRITING (verify with `gh pr view <n>`):
 *   PR #2472 (metadata write-authority guard)        OPEN, unmerged
 *   PR #2474 (outbound signer capture, R6/R7)          OPEN, unmerged
 *   PR #2476 (inbound Recipient-Connect classification) OPEN, unmerged
 * None of `extractSigners`, `DocusignCapturedSigner`, `classifyDirection`,
 * `senderAccountId` exist as importable symbols on `main` yet. Sections below
 * marked "PINNED CONTRACT" are byte-for-byte transcriptions of the relevant
 * `gh pr diff` output, not imports of real code — replace them with real
 * imports the moment the corresponding PR merges (each block says exactly
 * what to swap). Leaving a pinned block in place after its PR merges defeats
 * the whole point of this file: it would stop catching real drift.
 */
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_MIX,
  serializeConnectPayload,
  MAX_CAPTURED_SIGNERS,
  syntheticGuid,
  syntheticSha256,
  buildSignerList,
  buildOutboundSignersPayload,
  buildInboundConnectPayload,
  buildMalformedPayload,
  BILATERAL_MIX,
  pickBilateralFamily,
  buildBilateralRequest,
} from './docusign-synth.js';

// These two DO exist on `main` today and are the exact modules production
// runs — real cross-validation, not a pin.
import { parseDocusignConnectPayload } from '../../../src/integrations/oauth/docusign.js';
import { verifyDocusignConnectHmacMultiKey } from '../../../src/integrations/oauth/docusign-hmac.js';

function signBase64(body: string, key: string): string {
  return crypto.createHmac('sha256', key).update(Buffer.from(body)).digest('base64');
}

// ─────────────────────────────────────────────────────────────────────────
// PINNED CONTRACT (PR #2474 review, `services/worker/src/integrations/
// connectors/schemas.ts` — `GUID_PATTERN` / `DocusignCapturedSigner` /
// `MAX_CAPTURED_DOCUSIGN_SIGNERS`). Transcribed verbatim from `gh pr diff
// 2474`. REPLACE with:
//   import { DocusignCapturedSigner, MAX_CAPTURED_DOCUSIGN_SIGNERS } from
//     '../../../src/integrations/connectors/schemas.js';
// once that PR merges — a `grep -n "DocusignCapturedSigner" ../../../src/
// integrations/connectors/schemas.ts` returning a real export is the signal
// to do that swap and delete this block.
// ─────────────────────────────────────────────────────────────────────────
const PINNED_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PinnedNonEmptyString = z.string().trim().min(1).max(500);
const PinnedGuidString = PinnedNonEmptyString.regex(PINNED_GUID_PATTERN, 'must be a GUID');
const PinnedDocusignCapturedSigner = z.object({
  recipient_id_guid: PinnedGuidString,
  user_id: PinnedGuidString.optional(),
  status: PinnedNonEmptyString,
  signed_at: z.string().trim().min(1).max(100).optional(),
});
const PINNED_MAX_CAPTURED_DOCUSIGN_SIGNERS = 20;

/**
 * Test-only mirror of `extractSigners`' documented field-copy (recipientIdGuid
 * -> recipient_id_guid, userId -> user_id, status -> status, signedDateTime ->
 * signed_at — PR #2474's own doc comment on `extractSigners`). Used ONLY to
 * feed `PinnedDocusignCapturedSigner.safeParse` in the tests below; not a
 * claim that this IS the real extraction logic (it isn't importable yet).
 */
function mirrorExtractOneSigner(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof raw.recipientIdGuid === 'string') out.recipient_id_guid = raw.recipientIdGuid;
  if (typeof raw.userId === 'string') out.user_id = raw.userId;
  if (typeof raw.status === 'string') out.status = raw.status;
  if (typeof raw.signedDateTime === 'string') out.signed_at = raw.signedDateTime;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// PINNED CONTRACT (PR #2476, `services/worker/src/api/v1/webhooks/
// docusign.ts` `classifyDirection` — not exported, lives inside the Express
// route handler, so cannot be imported even post-merge without the PR also
// exporting it). Transcribed decision rule from `gh pr diff 2476`. This is
// used ONLY to assert this HARNESS's own internal consistency (that each
// family's generated payload resolves to the direction its name/mix-share
// documentation claims) — it is not a substitute for exercising the real
// handler, which is exactly what the k6 driver does against a live rig.
// ─────────────────────────────────────────────────────────────────────────
function pinnedClassifyDirection(
  payload: { accountId: string; sender?: { accountId?: string } },
  ownAccountIds: Set<string>,
): 'outbound' | 'inbound' {
  const sendingAccountId = payload.sender?.accountId ?? payload.accountId;
  if (sendingAccountId === payload.accountId) return 'outbound';
  return ownAccountIds.has(sendingAccountId) ? 'outbound' : 'inbound';
}

const OWN_ACCOUNT_ID = 'org-a-account';
const FOREIGN_ACCOUNT_ID = 'org-b-account';
const OWN_ACCOUNT_SET = new Set([OWN_ACCOUNT_ID]);
const FIXED_KEY = 'test-bilateral-hmac-key';

function baseCtx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    vu: 1,
    iter: 1,
    generatedDateTime: '2026-08-29T00:00:00.000Z',
    ownAccountId: OWN_ACCOUNT_ID,
    foreignAccountId: FOREIGN_ACCOUNT_ID,
    orphanAccountId: 'loadtest-orphan-1-1',
    ...overrides,
  };
}

describe('BILATERAL_MIX', () => {
  it('sums to 1', () => {
    const sum = Object.values(BILATERAL_MIX).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('every family named in the mix has a buildBilateralRequest case', () => {
    for (const family of Object.keys(BILATERAL_MIX)) {
      expect(() => buildBilateralRequest(family, baseCtx())).not.toThrow();
    }
  });
});

describe('pickBilateralFamily', () => {
  it('maps rand=0 to the first family and honors cumulative ranges', () => {
    const names = Object.keys(BILATERAL_MIX);
    expect(pickBilateralFamily(0)).toBe(names[0]);
    expect(pickBilateralFamily(0.999999)).toBe(names[names.length - 1]);
  });

  it('produces roughly the documented share for a large sample (outbound_no_signers ~30%)', () => {
    let hits = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      // Deterministic pseudo-random sweep across [0,1) — no RNG dependency.
      const rand = (i * 0.6180339887) % 1;
      if (pickBilateralFamily(rand) === 'outbound_no_signers') hits++;
    }
    expect(hits / n).toBeGreaterThan(0.27);
    expect(hits / n).toBeLessThan(0.33);
  });
});

describe('syntheticGuid / syntheticSha256', () => {
  it('syntheticGuid always matches the GUID_PATTERN both PRs pin', () => {
    for (let i = 0; i < 50; i++) {
      expect(syntheticGuid(i, 'a')).toMatch(PINNED_GUID_PATTERN);
      expect(syntheticGuid(i, 'b')).toMatch(PINNED_GUID_PATTERN);
    }
  });

  it('syntheticGuid is deterministic and distinct across seeds', () => {
    expect(syntheticGuid(7, 'a')).toBe(syntheticGuid(7, 'a'));
    expect(syntheticGuid(7, 'a')).not.toBe(syntheticGuid(8, 'a'));
  });

  it('syntheticSha256 always matches the sha256 hex regex the wire schema pins', () => {
    const sha256Hex = /^[a-f0-9]{64}$/;
    for (let i = 0; i < 20; i++) {
      expect(syntheticSha256(i, 'd')).toMatch(sha256Hex);
      expect(syntheticSha256(i, 'c')).toMatch(sha256Hex);
      expect(syntheticSha256(i, 'f')).toMatch(sha256Hex);
    }
  });

  it('syntheticSha256 tags never collide with each other for the same seed', () => {
    expect(syntheticSha256(1, 'd')).not.toBe(syntheticSha256(1, 'c'));
    expect(syntheticSha256(1, 'c')).not.toBe(syntheticSha256(1, 'f'));
    expect(syntheticSha256(1, 'd')).not.toBe(syntheticSha256(1, 'f'));
  });
});

describe('buildSignerList', () => {
  it('produces N signers, alternating a platform userId (even index) with pure email-link (odd index)', () => {
    const signers = buildSignerList(4);
    expect(signers).toHaveLength(4);
    expect(signers[0]).toHaveProperty('userId');
    expect(signers[1]).not.toHaveProperty('userId');
    expect(signers[2]).toHaveProperty('userId');
    expect(signers[3]).not.toHaveProperty('userId');
  });

  it('every signer, mirrored through the extraction contract, is accepted by the PINNED DocusignCapturedSigner shape', () => {
    const signers = buildSignerList(MAX_CAPTURED_SIGNERS + 5);
    expect(signers.length).toBeGreaterThan(PINNED_MAX_CAPTURED_DOCUSIGN_SIGNERS);
    for (const raw of signers) {
      const mirrored = mirrorExtractOneSigner(raw as Record<string, unknown>);
      const parsed = PinnedDocusignCapturedSigner.safeParse(mirrored);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data).not.toHaveProperty('name');
        expect(parsed.data).not.toHaveProperty('email');
      }
    }
  });

  it('MAX_CAPTURED_SIGNERS matches the PINNED cap (20) — drift beacon for PR #2474', () => {
    expect(MAX_CAPTURED_SIGNERS).toBe(PINNED_MAX_CAPTURED_DOCUSIGN_SIGNERS);
  });
});

describe('buildOutboundSignersPayload', () => {
  it('is accepted by the REAL parseDocusignConnectPayload', () => {
    const payload = buildOutboundSignersPayload({
      accountId: OWN_ACCOUNT_ID,
      envelopeId: 'env-out-1',
      eventId: 'evt-out-1',
      generatedDateTime: '2026-08-29T00:00:00.000Z',
      documentCount: 3,
      signerCount: 2,
    });
    const parsed = parseDocusignConnectPayload(serializeConnectPayload(payload));
    expect(parsed.event).toBe('envelope-completed');
    expect(parsed.accountId).toBe(OWN_ACCOUNT_ID);
    expect(parsed.envelopeId).toBe('env-out-1');
    expect(parsed.envelopeDocuments).toHaveLength(3);
  });

  it('omits envelopeSummary entirely when signerCount is 0 (never an empty signers array)', () => {
    const payload = buildOutboundSignersPayload({
      accountId: OWN_ACCOUNT_ID,
      envelopeId: 'env-out-2',
      signerCount: 0,
    });
    expect(payload).not.toHaveProperty('envelopeSummary');
  });

  it('max-cardinality (100 docs + 20 signers) still parses via the REAL parser', () => {
    const payload = buildOutboundSignersPayload({
      accountId: OWN_ACCOUNT_ID,
      envelopeId: 'env-out-max',
      documentCount: 100,
      signerCount: 20,
    });
    const parsed = parseDocusignConnectPayload(serializeConnectPayload(payload));
    expect(parsed.envelopeDocuments).toHaveLength(100);
    const summary = (payload as { envelopeSummary?: { recipients?: { signers?: unknown[] } } }).envelopeSummary;
    expect(summary?.recipients?.signers).toHaveLength(20);
  });

  it('25 requested signers are all present on the WIRE payload (server-side truncation to 20 is PR #2474 behavior, not this generator’s job)', () => {
    const payload = buildOutboundSignersPayload({
      accountId: OWN_ACCOUNT_ID,
      envelopeId: 'env-out-25',
      signerCount: 25,
    });
    const summary = (payload as { envelopeSummary: { recipients: { signers: unknown[] } } }).envelopeSummary;
    expect(summary.recipients.signers).toHaveLength(25);
  });

  it('emits a payload whose base64 HMAC-SHA256 the REAL multi-key verifier accepts (and rejects a wrong key)', () => {
    const body = serializeConnectPayload(
      buildOutboundSignersPayload({ accountId: OWN_ACCOUNT_ID, envelopeId: 'env-hmac-1' }),
    );
    const signature = signBase64(body, FIXED_KEY);
    expect(
      verifyDocusignConnectHmacMultiKey({ rawBody: body, signatures: [signature], keys: [FIXED_KEY] }),
    ).toBe(true);
    expect(
      verifyDocusignConnectHmacMultiKey({ rawBody: body, signatures: [signature], keys: ['wrong-key'] }),
    ).toBe(false);
  });

  it('the PINNED classifier resolves this shape as outbound', () => {
    const payload = buildOutboundSignersPayload({ accountId: OWN_ACCOUNT_ID, envelopeId: 'e' }) as {
      accountId: string;
      sender?: { accountId?: string };
    };
    expect(pinnedClassifyDirection(payload, OWN_ACCOUNT_SET)).toBe('outbound');
  });
});

describe('buildInboundConnectPayload', () => {
  it('is accepted by the REAL parseDocusignConnectPayload today WITHOUT throwing (does not yet expose senderAccountId — that is PR #2476)', () => {
    const payload = buildInboundConnectPayload({
      accountId: OWN_ACCOUNT_ID,
      senderAccountId: FOREIGN_ACCOUNT_ID,
      envelopeId: 'env-in-1',
      eventId: 'evt-in-1',
      generatedDateTime: '2026-08-29T00:00:00.000Z',
    });
    const parsed = parseDocusignConnectPayload(serializeConnectPayload(payload));
    expect(parsed.event).toBe('envelope-completed');
    expect(parsed.accountId).toBe(OWN_ACCOUNT_ID);
    // CONFIRMED BY RUNNING THIS TEST (not assumed): today's `sender.accountId`
    // does NOT survive to the parser's returned object, even though the
    // intermediate `RawConnectPayload.sender` sub-schema is `.passthrough()`.
    // The FINAL `DocusignEnvelopeCompleted.parse(...)` re-validates `sender`
    // against schemas.ts's own (non-passthrough) sender shape, which today is
    // `z.object({ email: MaybeEmail }).partial().optional()` — `accountId` is
    // an unknown key there and Zod's default object mode strips it silently.
    // This is exactly the gap PR #2476 closes by adding a typed, top-level
    // `senderAccountId` field (schemas.ts) instead of relying on `sender`
    // passthrough. Once that PR merges, this assertion should flip to
    // `.toBe(FOREIGN_ACCOUNT_ID)` and the comment above should be deleted —
    // that flip is itself a useful drift signal that the PR landed.
    expect((parsed.sender as { accountId?: string } | undefined)?.accountId).toBeUndefined();
  });

  it('hashCount=1 (default) produces exactly one document with a declared sha256', () => {
    const payload = buildInboundConnectPayload({
      accountId: OWN_ACCOUNT_ID,
      senderAccountId: FOREIGN_ACCOUNT_ID,
      envelopeId: 'env-in-2',
    }) as { envelopeDocuments: Array<{ sha256?: string }> };
    expect(payload.envelopeDocuments).toHaveLength(1);
    expect(payload.envelopeDocuments[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashCount=0 produces a document with NO sha256 (no usable declared hash)', () => {
    const payload = buildInboundConnectPayload({
      accountId: OWN_ACCOUNT_ID,
      senderAccountId: FOREIGN_ACCOUNT_ID,
      envelopeId: 'env-in-0',
      hashCount: 0,
    }) as { envelopeDocuments: Array<{ sha256?: string }> };
    expect(payload.envelopeDocuments).toHaveLength(1);
    expect(payload.envelopeDocuments[0].sha256).toBeUndefined();
  });

  it('hashCount=2 produces two DISTINCT declared hashes (also no usable single hash)', () => {
    const payload = buildInboundConnectPayload({
      accountId: OWN_ACCOUNT_ID,
      senderAccountId: FOREIGN_ACCOUNT_ID,
      envelopeId: 'env-in-2docs',
      hashCount: 2,
    }) as { envelopeDocuments: Array<{ sha256?: string }> };
    expect(payload.envelopeDocuments).toHaveLength(2);
    expect(payload.envelopeDocuments[0].sha256).not.toBe(payload.envelopeDocuments[1].sha256);
  });

  it('the PINNED classifier resolves a distinct senderAccountId as inbound', () => {
    const payload = buildInboundConnectPayload({
      accountId: OWN_ACCOUNT_ID,
      senderAccountId: FOREIGN_ACCOUNT_ID,
      envelopeId: 'e',
    }) as { accountId: string; sender?: { accountId?: string } };
    expect(pinnedClassifyDirection(payload, OWN_ACCOUNT_SET)).toBe('inbound');
  });

  it('self-forgery shape (own account, attacker-chosen fake foreign senderAccountId) ALSO resolves to inbound under the PINNED classifier — this IS the F1 threat model', () => {
    const payload = buildInboundConnectPayload({
      accountId: OWN_ACCOUNT_ID,
      senderAccountId: 'loadtest-forged-foreign-9-9',
      envelopeId: 'e',
      declaredSha256: syntheticSha256(1, 'f'),
    }) as { accountId: string; sender?: { accountId?: string } };
    expect(pinnedClassifyDirection(payload, OWN_ACCOUNT_SET)).toBe('inbound');
  });
});

describe('buildMalformedPayload', () => {
  it('not_json: the REAL parseDocusignConnectPayload throws (router converts this to 401, same as bad HMAC — anti-oracle design)', () => {
    const body = buildMalformedPayload('not_json');
    expect(() => parseDocusignConnectPayload(body)).toThrow();
  });

  it('missing_envelope_id: the REAL parseDocusignConnectPayload throws (envelopeId is a required NonEmptyString)', () => {
    const body = buildMalformedPayload('missing_envelope_id', { accountId: OWN_ACCOUNT_ID });
    expect(() => parseDocusignConnectPayload(body)).toThrow();
  });

  it('non_array_signers: the REAL parseDocusignConnectPayload does NOT throw — that parser never touches recipients/signers today', () => {
    const body = buildMalformedPayload('non_array_signers', {
      accountId: OWN_ACCOUNT_ID,
      envelopeId: 'env-malformed-signers',
    });
    expect(() => parseDocusignConnectPayload(body)).not.toThrow();
  });

  it('oversized: body length reaches the requested target and still round-trips as valid JSON', () => {
    const body = buildMalformedPayload('oversized', {
      accountId: OWN_ACCOUNT_ID,
      envelopeId: 'env-oversized',
      targetBytes: 50_000,
    });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThanOrEqual(50_000 - 24);
    expect(() => JSON.parse(body)).not.toThrow();
  });

  it('oversized defaults to comfortably past the worker’s 1mb ingress limit', () => {
    const body = buildMalformedPayload('oversized', {
      accountId: OWN_ACCOUNT_ID,
      envelopeId: 'env-oversized-default',
    });
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(1_000_000);
  });

  it('rejects an unknown kind', () => {
    expect(() => buildMalformedPayload('not_a_real_kind' as never)).toThrow();
  });
});

describe('buildBilateralRequest', () => {
  it('replay returns two steps with byte-identical bodies (the point of the family)', () => {
    const steps = buildBilateralRequest('replay', baseCtx());
    expect(steps).toHaveLength(2);
    const [first, second] = steps;
    expect(typeof first.payload === 'string' ? first.payload : serializeConnectPayload(first.payload)).toBe(
      typeof second.payload === 'string' ? second.payload : serializeConnectPayload(second.payload),
    );
    expect(second.expectStatus).toEqual([200]);
  });

  it('self_forgery_provenance_conflict returns two steps sharing one envelopeId: real outbound then forged inbound', () => {
    const steps = buildBilateralRequest('self_forgery_provenance_conflict', baseCtx()) as Array<{
      payload: { envelopeId: string; sender?: { accountId?: string } };
      signAs: string;
      customrecipient?: boolean;
      delayMs?: number;
    }>;
    expect(steps).toHaveLength(2);
    expect(steps[0].payload.envelopeId).toBe(steps[1].payload.envelopeId);
    expect(steps[0].payload.sender?.accountId).toBeUndefined(); // real outbound: no distinct sender
    expect(steps[1].payload.sender?.accountId).toContain('loadtest-forged-foreign');
    expect(steps[1].delayMs).toBeGreaterThan(0);
  });

  it('self_send_collision sets customrecipient=true on an otherwise-outbound-shaped payload', () => {
    const [step] = buildBilateralRequest('self_send_collision', baseCtx()) as Array<{
      payload: { accountId: string; sender?: { accountId?: string } };
      customrecipient?: boolean;
    }>;
    expect(step.customrecipient).toBe(true);
    expect(pinnedClassifyDirection(step.payload, OWN_ACCOUNT_SET)).toBe('outbound');
  });

  it('unknown_account_orphan signs with the shared key, never the org key', () => {
    const [step] = buildBilateralRequest('unknown_account_orphan', baseCtx());
    expect(step.signAs).toBe('shared');
  });

  it('wrong_hmac is marked to sign with a deliberately wrong key', () => {
    const [step] = buildBilateralRequest('wrong_hmac', baseCtx());
    expect(step.signAs).toBe('wrong');
  });

  it('throws on an unknown family', () => {
    expect(() => buildBilateralRequest('not_a_real_family', baseCtx())).toThrow();
  });

  it('every family’s step payloads (when object-shaped) are accepted by the REAL parseDocusignConnectPayload, and every step’s signature is verified correctly by the REAL HMAC verifier under its own signAs contract', () => {
    for (const family of Object.keys(BILATERAL_MIX)) {
      const ctx = baseCtx({ vu: 3, iter: 11 });
      const steps = buildBilateralRequest(family, ctx);
      for (const step of steps) {
        const body = typeof step.payload === 'string' ? step.payload : serializeConnectPayload(step.payload);

        // Shape: 'not_json' is the ONE deliberate exception (that's its
        // entire purpose) — every other family must still be valid JSON the
        // real parser accepts or deliberately rejects per its OWN documented
        // contract (missing_envelope_id rejects; everything else accepts).
        if (family !== 'malformed_not_json') {
          if (family === 'malformed_missing_envelope_id') {
            expect(() => parseDocusignConnectPayload(body)).toThrow();
          } else {
            expect(() => parseDocusignConnectPayload(body)).not.toThrow();
          }
        }

        // Signature: sign under this step's OWN signAs contract using a
        // fixed key pair, and confirm the real verifier agrees.
        const orgKey = FIXED_KEY;
        const sharedKey = 'test-shared-fallback-key';
        const signingKey =
          step.signAs === 'shared' ? sharedKey : step.signAs === 'wrong' ? `${orgKey}-wrong` : orgKey;
        const signature = signBase64(body, signingKey);
        const verifyKeys = step.signAs === 'shared' ? [sharedKey] : [orgKey];
        const accepted = verifyDocusignConnectHmacMultiKey({
          rawBody: body,
          signatures: [signature],
          keys: verifyKeys,
        });
        expect(accepted).toBe(step.signAs !== 'wrong');
      }
    }
  });
});

// Sanity: the outer health/verify/docusign split this bilateral mix nests
// under is untouched by any of the above.
describe('DEFAULT_MIX is untouched by the bilateral additions', () => {
  it('still sums to 1', () => {
    const sum = DEFAULT_MIX.health + DEFAULT_MIX.verify + DEFAULT_MIX.docusign;
    expect(sum).toBeCloseTo(1, 10);
  });
});
