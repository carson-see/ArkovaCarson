/**
 * Adobe Sign webhook handler tests (SCRUM-1148).
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFromMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('../../../utils/db.js', () => ({
  db: {
    from: (...args: unknown[]) => dbFromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { adobeSignWebhookRouter, buildAdobeSignRuleEventPayload } from './adobe-sign.js';
import type { AdobeAgreementCompletedEvent } from '../../../integrations/oauth/adobe-sign.js';

const TEST_SECRET = 'adobe-fixture-secret-aaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222';
const WEBHOOK_ID = 'webhook-abc-123';
const AGREEMENT_ID = 'CBSCTBAAA-agreement-xyz';

function createApp() {
  const app = express();
  app.use(
    '/webhooks/adobe-sign',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
      next();
    },
    adobeSignWebhookRouter,
  );
  return app;
}

function sign(body: string | Buffer): string {
  return crypto.createHmac('sha256', TEST_SECRET).update(body).digest('base64');
}

function validBody(overrides: Partial<{
  event: string;
  agreementId: string;
  webhookId: string;
}> = {}): string {
  return JSON.stringify({
    event: overrides.event ?? 'AGREEMENT_WORKFLOW_COMPLETED',
    eventDate: '2026-04-25T00:00:00Z',
    webhookId: overrides.webhookId ?? WEBHOOK_ID,
    agreement: {
      id: overrides.agreementId ?? AGREEMENT_ID,
      name: 'Sample MSA.pdf',
      senderInfo: { email: 'sender@example.com' },
      documents: [{ id: 'doc-1', name: 'Sample MSA.pdf' }],
    },
  });
}

function integrationLookup(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
  };
}

function nonceInsertMock(error: { code: string; message?: string } | null = null) {
  return { insert: vi.fn().mockResolvedValue({ data: null, error }) };
}

function postSignedBody(body: string | Buffer) {
  return request(createApp())
    .post('/webhooks/adobe-sign')
    .set('Content-Type', 'application/json')
    .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
    .send(body);
}

function dlqInsertMock() {
  return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADOBE_SIGN_CLIENT_SECRET = TEST_SECRET;
});

describe('POST /webhooks/adobe-sign (SCRUM-1148)', () => {
  it('returns 503 when client secret is not configured', async () => {
    delete process.env.ADOBE_SIGN_CLIENT_SECRET;
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(503);
  });

  it('rejects tampered payloads with 401 before any DB write', async () => {
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', 'AAAA')
      .send(body);
    expect(res.status).toBe(401);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('200 + ignored=true for non-completed events (CREATED, RECALLED, REJECTED)', async () => {
    const body = validBody({ event: 'AGREEMENT_CREATED' });
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
  });

  it('200 + orphaned=true when webhook_id has no connected integration', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return integrationLookup(null);
      throw new Error(`unexpected: ${table}`);
    });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
  });

  it('202 + rule_event_id when payload is valid, integration is connected, and enqueue succeeds', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock(null);
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: 'rule-event-uuid', error: null });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ok: true, rule_event_id: 'rule-event-uuid' });
    expect(rpcMock).toHaveBeenCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({
        p_org_id: ORG_ID,
        p_trigger_type: 'ESIGN_COMPLETED',
        p_vendor: 'adobe_sign',
        p_external_file_id: AGREEMENT_ID,
      }),
    );
  });

  it('idempotent: duplicate delivery (unique-violation 23505) returns 200 + duplicate=true', async () => {
    const intLookup = integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return intLookup;
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock({ code: '23505' });
      throw new Error(`unexpected: ${table}`);
    });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('500 + DLQ insert when enqueue_rule_event RPC fails', async () => {
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock(null);
      if (table === 'webhook_dlq') return dlq;
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });
    const body = validBody();
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(500);
    expect(dlq.insert).toHaveBeenCalledTimes(1);
    const dlqRow = (dlq.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      provider: string;
      external_id: string;
    };
    expect(dlqRow.provider).toBe('adobe_sign');
    expect(dlqRow.external_id).toBe(AGREEMENT_ID);
  });

  it('400 + DLQ insert on malformed JSON', async () => {
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'webhook_dlq') return dlq;
      throw new Error(`unexpected: ${table}`);
    });
    const body = '{ malformed';
    const res = await request(createApp())
      .post('/webhooks/adobe-sign')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId-Authentication-Sha256', sign(body))
      .send(body);
    expect(res.status).toBe(400);
    expect(dlq.insert).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Rule-event payload 16KB CHECK guard (Adobe Sign — DocuSign bilateral 2026-08,
// Finding 7 parallel latent bug; precedent: DocuSign PR #2485)
//
// `organization_rule_events.payload` carries a DB CHECK from the baseline
// migration (`organization_rule_events_payload_size`):
//     pg_column_size(payload) <= 16384
//
// The Adobe Sign webhook builds that payload from EVERY agreement document. The
// event's `documents` array is `.max(100)` and each document `id` is
// `z.string().trim().min(1)` with NO `.max()` length cap — so the former
// `document_ids` array was even less bounded than the DocuSign case (which had a
// 100-char documentId gate). At max cardinality with long ids that array alone
// overflowed the 16KB budget. In production that would make `enqueue_rule_event`
// throw a check_violation, the handler DLQ + return 500, and Adobe retry the
// identical payload forever — the agreement's ESIGN_COMPLETED event and every
// downstream step (anchoring) would never succeed.
//
// These tests pin the built payload under budget at adversarial cardinality.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Conservative upper-bound model of Postgres `pg_column_size(value::jsonb)`
 * (the uncompressed jsonb binary size the CHECK evaluates on insert). Every
 * branch charges AT LEAST what Postgres charges, so
 * `jsonbColumnSize(v) <= 16384` implies the real DB CHECK passes:
 *   - every value carries a 4-byte JEntry
 *   - every container (object/array) adds a 4-byte header
 *   - object keys are stored as strings, each with its own 4-byte JEntry
 *   - strings cost their exact UTF-8 byte length
 *   - numbers are charged a generous flat 16 bytes (real jsonb numeric is smaller)
 * plus the 4-byte top-level varlena header.
 */
function jsonbColumnSize(value: unknown): number {
  const sizeOf = (v: unknown): number => {
    if (v === null || v === undefined) return 4;
    if (typeof v === 'boolean') return 4;
    if (typeof v === 'number') return 4 + 16;
    if (typeof v === 'string') return 4 + Buffer.byteLength(v, 'utf8');
    if (Array.isArray(v)) {
      return 4 + 4 + v.reduce((sum: number, el) => sum + sizeOf(el), 0);
    }
    return (
      4 +
      4 +
      Object.entries(v as Record<string, unknown>).reduce(
        (sum, [k, val]) => sum + 4 + Buffer.byteLength(k, 'utf8') + sizeOf(val),
        0,
      )
    );
  };
  return 4 + sizeOf(value);
}

/** Distinct 64-char lowercase SHA-256 hex per document index. */
function uniqueDocHash(index: number): string {
  return crypto.createHash('sha256').update(`doc-${index}`).digest('hex');
}

/**
 * A signed AGREEMENT_WORKFLOW_COMPLETED body carrying `count` documents, each
 * with an `id` of exactly `idLength` chars and a unique SHA-256. Adobe imposes
 * NO length cap on the document id, so `idLength` can be arbitrarily large — the
 * whole point of the finding.
 */
function bodyWithDocuments(count: number, idLength: number): string {
  const documents = Array.from({ length: count }, (_, i) => ({
    id: `${i}-`.padEnd(idLength, 'x').slice(0, idLength),
    name: 'contract.pdf',
    sha256: uniqueDocHash(i),
  }));
  return JSON.stringify({
    event: 'AGREEMENT_WORKFLOW_COMPLETED',
    eventDate: '2026-04-25T00:00:00Z',
    webhookId: WEBHOOK_ID,
    agreement: {
      id: 'CBSCTBAAA-maxcard',
      name: 'contract.pdf',
      senderInfo: { email: 'sender@example.com' },
      documents,
    },
  });
}

describe('rule-event payload 16KB guard (Adobe Sign Finding 7)', () => {
  const PAYLOAD_SIZE_LIMIT = 16384;

  function primeEnqueueMocks(): void {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock(null);
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: 'rule-event-uuid', error: null });
  }

  function enqueuedRulePayload(): Record<string, unknown> {
    const call = rpcMock.mock.calls.find((c) => c[0] === 'enqueue_rule_event');
    if (!call) throw new Error('enqueue_rule_event was not called');
    return (call[1] as { p_payload: Record<string, unknown> }).p_payload;
  }

  it('stays within the 16KB CHECK at 100 documents with long documentIds', async () => {
    primeEnqueueMocks();

    // 100 documents (the `documents` `.max(100)` cap), each with a 500-char id
    // and a unique SHA-256. Adobe caps neither the id length nor its content, so
    // this is a real adversarial worst case reachable straight through ingress.
    const res = await postSignedBody(bodyWithDocuments(100, 500));

    expect(res.status).toBe(202);
    expect(jsonbColumnSize(enqueuedRulePayload())).toBeLessThanOrEqual(PAYLOAD_SIZE_LIMIT);
  });

  it('replaces the unbounded document_ids array with a bounded document_count', async () => {
    primeEnqueueMocks();

    const res = await postSignedBody(bodyWithDocuments(3, 40));
    const payload = enqueuedRulePayload();

    expect(res.status).toBe(202);
    expect(payload.document_count).toBe(3);
    // The unbounded array must be gone from the size-capped payload entirely —
    // document-id length can no longer push it toward the 16KB CHECK.
    expect(payload).not.toHaveProperty('document_ids');
  });

  it('is invariant to document-id length: holds under budget even at 100 × 2000-char ids', () => {
    // Adobe caps neither the count beyond `.max(100)` nor the id length at all,
    // so the builder must be size-invariant to id length. Drive it directly at an
    // id length far past anything realistic (2000 chars each) to prove the fix —
    // the payload no longer contains the ids, so its size does not move.
    const event = {
      event: 'AGREEMENT_WORKFLOW_COMPLETED',
      agreementId: 'CBSCTBAAA-idlen-max',
      agreementName: 'contract.pdf',
      senderEmail: 'sender@example.com',
      documents: Array.from({ length: 100 }, (_, i) => ({
        id: `${i}-`.padEnd(2000, 'x').slice(0, 2000),
        name: 'contract.pdf',
        sha256: uniqueDocHash(i),
      })),
      webhookId: WEBHOOK_ID,
    } as AdobeAgreementCompletedEvent;

    const payload = buildAdobeSignRuleEventPayload({
      integrationId: INTEGRATION_ID,
      event,
      payloadHash: 'a'.repeat(64),
    });

    expect(payload.document_count).toBe(100);
    expect(payload).not.toHaveProperty('document_ids');
    expect(jsonbColumnSize(payload)).toBeLessThanOrEqual(PAYLOAD_SIZE_LIMIT);
  });
});
