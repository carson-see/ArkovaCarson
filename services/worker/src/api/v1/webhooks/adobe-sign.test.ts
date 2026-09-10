/**
 * Adobe Sign webhook handler tests (SCRUM-1148).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock } = vi.hoisted(() => ({ configMock: { adobeSignClientId: undefined as string | undefined } }));
vi.mock('../../../config.js', () => ({ config: configMock }));

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
const TEST_CLIENT_ID = 'adobe-fixture-client-id-bbbb';
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

interface AdobeDocumentFixture {
  id: string;
  name?: string;
  sha256?: string;
}

function validBody(overrides: Partial<{
  event: string;
  agreementId: string;
  webhookId: string;
  senderEmail: string;
  documents: AdobeDocumentFixture[];
}> = {}): string {
  return JSON.stringify({
    event: overrides.event ?? 'AGREEMENT_WORKFLOW_COMPLETED',
    eventDate: '2026-04-25T00:00:00Z',
    webhookId: overrides.webhookId ?? WEBHOOK_ID,
    agreement: {
      id: overrides.agreementId ?? AGREEMENT_ID,
      name: 'Sample MSA.pdf',
      senderInfo: { email: overrides.senderEmail ?? 'sender@example.com' },
      documents: overrides.documents ?? [{ id: 'doc-1', name: 'Sample MSA.pdf' }],
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

/**
 * `adobe_sign_webhook_nonces` is deduped on the composite UNIQUE key
 * `(agreement_id, payload_hash)` (baseline migration
 * `adobe_sign_webhook_nonces_agreement_id_payload_hash_key`), so a compensating
 * release must filter on BOTH columns — deleting by `agreement_id` alone would
 * drop the nonce for a DIFFERENT payload revision of the same agreement and
 * silently disarm replay protection for a delivery this request never touched.
 * This mock records the ordered filter chain so tests can assert both.
 */
function nonceTableMock(insertError: { code: string; message?: string } | null = null) {
  const filters: Array<[string, unknown]> = [];
  const makeEq = (): ReturnType<typeof vi.fn> =>
    vi.fn((col: string, val: unknown) => {
      filters.push([col, val]);
      const thenable = Promise.resolve({ error: null }) as Promise<{ error: unknown }> & {
        eq: unknown;
      };
      thenable.eq = makeEq();
      return thenable;
    });
  const deleteFn = vi.fn(() => ({ eq: makeEq() }));
  return {
    filters,
    deleteFn,
    table: {
      insert: vi.fn().mockResolvedValue({ data: null, error: insertError }),
      delete: deleteFn,
    },
  };
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
  process.env.ADOBE_SIGN_CLIENT_ID = TEST_CLIENT_ID;
  configMock.adobeSignClientId = TEST_CLIENT_ID;
});

// Adobe will not create a webhook at all until the endpoint answers its
// registration challenge: an HTTPS GET carrying X-AdobeSign-ClientId, which
// must come back 2XX with the SAME client id echoed in a response header.
// Without this, `POST /api/rest/v6/webhooks` fails Adobe-side and no
// webhook_id is ever minted — which is why org_integrations.webhook_id has
// never been populated in any environment.
// https://helpx.adobe.com/sign/developer/webhook/create.html
describe('GET /webhooks/adobe-sign — Adobe registration challenge', () => {
  it('echoes the client id and returns 200 when the client id is recognized', async () => {
    const res = await request(createApp())
      .get('/webhooks/adobe-sign')
      .set('X-AdobeSign-ClientId', TEST_CLIENT_ID);
    expect(res.status).toBe(200);
    expect(res.headers['x-adobesign-clientid']).toBe(TEST_CLIENT_ID);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('recognizes the validated client ID when the raw environment changes after startup', async () => {
    process.env.ADOBE_SIGN_CLIENT_ID = 'unvalidated-runtime-value';
    const res = await request(createApp())
      .get('/webhooks/adobe-sign')
      .set('X-AdobeSign-ClientId', TEST_CLIENT_ID);
    expect(res.status).toBe(200);
    expect(res.headers['x-adobesign-clientid']).toBe(TEST_CLIENT_ID);
    expect(dbFromMock).not.toHaveBeenCalled();
  });

  it('refuses to echo an UNRECOGNIZED client id (Adobe: must not respond success)', async () => {
    const res = await request(createApp())
      .get('/webhooks/adobe-sign')
      .set('X-AdobeSign-ClientId', 'somebody-elses-client-id');
    expect(res.status).toBe(403);
    expect(res.headers['x-adobesign-clientid']).toBeUndefined();
  });

  it('refuses when the client id header is absent entirely', async () => {
    const res = await request(createApp()).get('/webhooks/adobe-sign');
    expect(res.status).toBe(403);
    expect(res.headers['x-adobesign-clientid']).toBeUndefined();
  });

  it('503s (never echoes) when ADOBE_SIGN_CLIENT_ID is not configured', async () => {
    configMock.adobeSignClientId = undefined;
    const res = await request(createApp())
      .get('/webhooks/adobe-sign')
      .set('X-AdobeSign-ClientId', TEST_CLIENT_ID);
    expect(res.status).toBe(503);
    expect(res.headers['x-adobesign-clientid']).toBeUndefined();
  });
});

describe('POST /webhooks/adobe-sign (SCRUM-1148)', () => {
  it('returns 503 when client secret is not configured', async () => {
    delete process.env.ADOBE_SIGN_CLIENT_SECRET;
    const body = validBody();
    const res = await postSignedBody(body);
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
    const res = await postSignedBody(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
  });

  it('200 + orphaned=true when webhook_id has no connected integration', async () => {
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return integrationLookup(null);
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });
    const body = validBody();
    const res = await postSignedBody(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orphaned: true });
  });

  it.each(['returned', 'thrown'])('retries an orphan when its DLQ persistence fails (%s)', async (failure) => {
    const insert = failure === 'returned'
      ? vi.fn().mockResolvedValue({ error: { code: '08006' } })
      : vi.fn().mockRejectedValue(new Error('synthetic database unavailable'));
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return integrationLookup(null);
      if (table === 'webhook_dlq') return { insert };
      throw new Error(`unexpected: ${table}`);
    });
    const res = await postSignedBody(validBody());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'webhook_processing_failed' } });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('orphaned webhook_id is recorded to the DLQ, not silently dropped', async () => {
    // No org_integrations write path exists for adobe_sign yet (no connect
    // flow analogous to docusign-oauth.ts), so every real delivery hits this
    // branch today. Losing the DLQ record here means the failure leaves no
    // trace anywhere — this pins that the record survives.
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') return integrationLookup(null);
      if (table === 'webhook_dlq') return dlq;
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
    expect(dlq.insert).toHaveBeenCalledTimes(1);
    const dlqRow = (dlq.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      provider: string;
      external_id: string;
      webhook_id: string;
      reason: string;
    };
    expect(dlqRow.provider).toBe('adobe_sign');
    expect(dlqRow.external_id).toBe(AGREEMENT_ID);
    expect(dlqRow.webhook_id).toBe(WEBHOOK_ID);
    expect(dlqRow.reason).toBe('unregistered_webhook_id');
  });

  it('resolves the registered Adobe webhook through the migration 0426 webhook_id column', async () => {
    const lookup = integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID });
    dbFromMock.mockReturnValueOnce(lookup);
    dbFromMock.mockReturnValueOnce(nonceInsertMock());
    rpcMock.mockResolvedValueOnce({ data: '33333333-3333-4333-8333-333333333333', error: null });
    expect((await postSignedBody(validBody())).status).toBe(202);
    expect(lookup.select).toHaveBeenCalledWith('id, org_id');
    expect(lookup.eq).toHaveBeenCalledWith('webhook_id', WEBHOOK_ID);
    expect(lookup.eq).toHaveBeenCalledWith('provider', 'adobe_sign');
    expect(lookup.is).toHaveBeenCalledWith('revoked_at', null);
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
    const res = await postSignedBody(body);
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
    const res = await postSignedBody(body);
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
    const res = await postSignedBody(body);
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
    const res = await postSignedBody(body);
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
 * A body carrying `count` documents, each with an `id` of exactly `idLength`
 * chars and a unique SHA-256. Adobe imposes NO length cap on the document id,
 * so `idLength` can be arbitrarily large — the whole point of the finding.
 */
function bodyWithDocuments(count: number, idLength: number): string {
  return validBody({
    agreementId: 'CBSCTBAAA-maxcard',
    documents: Array.from({ length: count }, (_, i) => ({
      id: `${i}-`.padEnd(idLength, 'x').slice(0, idLength),
      name: 'contract.pdf',
      sha256: uniqueDocHash(i),
    })),
  });
}

/**
 * Effective numeric bound of a named CHECK constraint, read from the migration
 * set in applied (filename) order — the baseline sorts first, so a later
 * widening/narrowing migration correctly wins.
 *
 * Hardcoding `16384` here would let the guard and the constraint drift apart in
 * exactly the direction that hurts: narrow the CHECK in a future migration and
 * a hardcoded test keeps passing while production starts raising 23514. Same
 * reasoning (and same shape) as the `verification_status` code/constraint
 * parity test in `middesk.test.ts`.
 *
 * All three bounds come from ONE pass over the migration set — the directory is
 * hundreds of files and several MB, so a read-per-constraint would be three
 * full sweeps of the same bytes on every run of this file.
 */
const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../supabase/migrations',
);

function effectiveCheckMaxima(constraintNames: string[]): Record<string, number> {
  // NaN, not a default: an unparsed constraint must fail the anchor test below
  // and every bound assertion, never silently pass with a plausible number.
  const bounds = Object.fromEntries(constraintNames.map((n) => [n, Number.NaN]));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const name of constraintNames) {
      // The CHECK body runs to the end of its constraint line (`,\n`) or to the
      // close of the CREATE TABLE (`\n)`); the LAST `<= N` inside it is the
      // upper bound (`external_file_id` also carries a `>= 1` lower bound).
      const re = new RegExp(`${name}[\\s\\S]{0,400}?CHECK([\\s\\S]{0,400}?)(?:,\\n|\\n\\))`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const uppers = [...m[1].matchAll(/<=\s*\(?\s*(\d+)/g)].map((x) => Number(x[1]));
        if (uppers.length > 0) bounds[name] = uppers[uppers.length - 1];
      }
    }
  }
  return bounds;
}

const CHECK_BOUNDS = effectiveCheckMaxima([
  'organization_rule_events_payload_size',
  'organization_rule_events_external_file_id_length',
  'organization_rule_events_sender_email_length',
]);

/** `pg_column_size(payload) <= N` on `organization_rule_events`. */
const PAYLOAD_SIZE_LIMIT = CHECK_BOUNDS.organization_rule_events_payload_size;
/** `char_length(external_file_id) <= N` — fed by `agreement.id`. */
const EXTERNAL_FILE_ID_LIMIT = CHECK_BOUNDS.organization_rule_events_external_file_id_length;
/** `char_length(sender_email) <= N` — fed by `agreement.senderInfo.email`. */
const SENDER_EMAIL_LIMIT = CHECK_BOUNDS.organization_rule_events_sender_email_length;

describe('rule-event column bounds are read from the migration set', () => {
  // Guards the regex itself: a silent no-match would leave every bound NaN and
  // make the assertions that use them vacuous.
  it.each(Object.entries(CHECK_BOUNDS))('resolves %s from the migrations', (name, bound) => {
    expect(bound, `could not parse ${name} from the migration set`).toBeGreaterThan(0);
  });
});

describe('rule-event payload 16KB guard (Adobe Sign Finding 7)', () => {
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
    // Annotated, not cast: `as` would hide a shape drift in the very interface
    // this guard depends on.
    const event: AdobeAgreementCompletedEvent = {
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
    };

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

// ───────────────────────────────────────────────────────────────────────────
// Code/constraint parity for the OTHER unbounded legs of the same enqueue.
//
// Dropping `document_ids` bounds the `documents` leg only. The SAME
// `enqueue_rule_event` INSERT also writes, from the SAME vendor-controlled
// body:
//   agreement.id               -> payload.agreement_id (16KB pg_column_size CHECK)
//                              -> external_file_id     (char_length <= 500 CHECK)
//   agreement.senderInfo.email -> sender_email         (char_length <= 320 CHECK)
// `RawAdobeWebhookPayload` capped neither, and they failed differently:
//   - the id WAS rejected, but late — `NonEmptyString.max(500)` throws inside
//     `adaptAdobeSign`, which runs AFTER the replay nonce is committed, so the
//     handler DLQ'd and returned 500 and the retry was swallowed as a duplicate.
//     (That is why the over-bound case below asserts 400, not "no 23514": the
//     pre-fix status was 500, and 500 on this handler means a lost event.)
//   - the email was not bounded at all (`MaybeEmail` has no length cap), so it
//     reached Postgres and raised SQLSTATE 23514 inside the RPC — same 500,
//     same swallowed retry. Pre-fix this case returned 202 from the mocked DB,
//     which is exactly why a mock cannot be the whole story here and the bounds
//     are asserted against the migration set instead.
//
// Parity means: the parse layer must reject what the constraint cannot store,
// so an oversize field is a bounded 400 + DLQ audit row instead of a 5xx.
// Bounds are read from the migration set, never hardcoded here.
// ───────────────────────────────────────────────────────────────────────────

describe('code/constraint parity: vendor input is bounded to what the row can store', () => {
  function primeAllTables(): { dlq: ReturnType<typeof dlqInsertMock> } {
    const dlq = dlqInsertMock();
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonceInsertMock(null);
      if (table === 'webhook_dlq') return dlq;
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValue({ data: 'rule-event-uuid', error: null });
    return { dlq };
  }

  /** An address of exactly `length` chars that still parses as an email. */
  function emailOfLength(length: number): string {
    const domain = '@example.com';
    return `${'a'.repeat(length - domain.length)}${domain}`;
  }

  it('accepts an agreement id at exactly the external_file_id bound', async () => {
    primeAllTables();
    const agreementId = 'A'.repeat(EXTERNAL_FILE_ID_LIMIT);

    const res = await postSignedBody(validBody({ agreementId }));

    expect(res.status).toBe(202);
    expect(rpcMock).toHaveBeenCalledWith(
      'enqueue_rule_event',
      expect.objectContaining({ p_external_file_id: agreementId }),
    );
  });

  it('rejects an agreement id one char over the bound at ingress, not with a 5xx', async () => {
    const { dlq } = primeAllTables();

    const res = await postSignedBody(
      validBody({ agreementId: 'A'.repeat(EXTERNAL_FILE_ID_LIMIT + 1) }),
    );

    // Pre-fix: 500. `adaptAdobeSign`'s `NonEmptyString.max(500)` threw AFTER the
    // nonce was committed, so the retry came back as a duplicate and the event
    // was lost. Rejecting at parse time keeps it in front of the nonce.
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(dlq.insert).toHaveBeenCalledTimes(1);
  });

  it('accepts a sender email at exactly the sender_email bound', async () => {
    primeAllTables();

    const res = await postSignedBody(validBody({ senderEmail: emailOfLength(SENDER_EMAIL_LIMIT) }));

    expect(res.status).toBe(202);
  });

  it('rejects a sender email one char over the bound instead of 5xx-ing on 23514', async () => {
    const { dlq } = primeAllTables();

    const res = await postSignedBody(
      validBody({ senderEmail: emailOfLength(SENDER_EMAIL_LIMIT + 1) }),
    );

    // Pre-fix this was bounded NOWHERE — `MaybeEmail` has no length cap, so it
    // sailed past both parse layers into the RPC (202 against a mocked DB) and
    // raised `organization_rule_events_sender_email_length` (23514) in prod.
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(dlq.insert).toHaveBeenCalledTimes(1);
  });

  it('never leaks the oversize value into the DLQ reason', async () => {
    const { dlq } = primeAllTables();
    const agreementId = 'A'.repeat(EXTERNAL_FILE_ID_LIMIT + 1);

    await postSignedBody(validBody({ agreementId }));

    expect(dlq.insert).toHaveBeenCalledTimes(1);
    const row = (dlq.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as { reason: string };
    expect(row.reason).not.toContain(agreementId);
    expect(row.reason.length).toBeLessThanOrEqual(500);
  });

  it('the built payload stays under the CHECK at the maximum ACCEPTED input', () => {
    // Worst case reachable through ingress after the bounds above: the longest
    // admissible agreement id AND the full 100-document array.
    const payload = buildAdobeSignRuleEventPayload({
      integrationId: INTEGRATION_ID,
      event: {
        event: 'AGREEMENT_WORKFLOW_COMPLETED',
        agreementId: 'A'.repeat(EXTERNAL_FILE_ID_LIMIT),
        agreementName: 'x'.repeat(500),
        senderEmail: emailOfLength(SENDER_EMAIL_LIMIT),
        documents: Array.from({ length: 100 }, (_, i) => ({
          id: `${i}`.padEnd(2000, 'x'),
          name: 'contract.pdf',
          sha256: uniqueDocHash(i),
        })),
        webhookId: WEBHOOK_ID,
      },
      payloadHash: 'a'.repeat(64),
    });

    expect(jsonbColumnSize(payload)).toBeLessThanOrEqual(PAYLOAD_SIZE_LIMIT);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AUDIT-0424-10 / SCRUM-3479 — release the replay nonce on post-nonce 5xx.
//
// This is the loss path the Finding 7 fix is meant to close, and it is NOT
// "Adobe retries the identical payload forever": the nonce row is committed
// BEFORE `enqueue_rule_event` runs and the 500 path never released it. Adobe's
// first retry carries the identical body, so it produces the identical
// `payload_hash`, hits the `(agreement_id, payload_hash)` UNIQUE violation, and
// is answered `200 {duplicate:true}` — the ESIGN_COMPLETED event is dropped
// after ONE retry AND the vendor is told it succeeded. The `webhook_dlq` row is
// a record of the loss, not a recovery path (nothing under `jobs/` drains it).
//
// SCRUM-3479 fixed `checkr.ts` and `ats.ts`; this handler was left behind while
// the folder's own agents.md DO-rule required it. Same compensating-delete
// shape as `middesk.ts::releaseNonce`.
// ───────────────────────────────────────────────────────────────────────────

describe('AUDIT-0424-10: releases the replay nonce on post-nonce failure', () => {
  const PAYLOAD_HASH = crypto.createHash('sha256').update(validBody()).digest('hex');

  it('releases the nonce when enqueue_rule_event returns an error', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });

    const res = await postSignedBody(validBody());

    expect(res.status).toBe(500);
    // Both columns of the UNIQUE key — deleting by agreement_id alone would
    // disarm replay protection for a different payload revision.
    expect(nonce.filters).toEqual([
      ['agreement_id', AGREEMENT_ID],
      ['payload_hash', PAYLOAD_HASH],
    ]);
  });

  it('releases the nonce when post-nonce processing throws', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockImplementationOnce(() => {
      throw new Error('connection terminated unexpectedly');
    });

    const res = await postSignedBody(validBody());

    expect(res.status).toBe(500);
    expect(nonce.filters).toEqual([
      ['agreement_id', AGREEMENT_ID],
      ['payload_hash', PAYLOAD_HASH],
    ]);
  });

  it('does NOT release the nonce on success (replay protection intact)', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonce.table;
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: 'rule-event-uuid', error: null });

    const res = await postSignedBody(validBody());

    expect(res.status).toBe(202);
    expect(nonce.deleteFn).not.toHaveBeenCalled();
  });

  it('does NOT delete a nonce this delivery never committed (pre-nonce failure)', async () => {
    const nonce = nonceTableMock(null);
    dbFromMock.mockImplementation((table: string) => {
      // The integration lookup fails BEFORE the nonce insert, so any row
      // matching (agreement_id, payload_hash) belongs to an EARLIER delivery.
      if (table === 'org_integrations') return integrationLookup(null, { message: 'lookup boom' });
      if (table === 'adobe_sign_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });

    const res = await postSignedBody(validBody());

    expect(res.status).toBe(500);
    expect(nonce.deleteFn).not.toHaveBeenCalled();
  });

  it('does NOT delete when the nonce insert failed open (non-23505)', async () => {
    // The handler deliberately continues when the nonce write fails for a
    // non-duplicate reason. No row was committed, so there is nothing to
    // compensate — a matching row could only be an earlier delivery's.
    const nonce = nonceTableMock({ code: '42501', message: 'permission denied' });
    dbFromMock.mockImplementation((table: string) => {
      if (table === 'org_integrations') {
        return integrationLookup({ id: INTEGRATION_ID, org_id: ORG_ID, webhook_id: WEBHOOK_ID });
      }
      if (table === 'adobe_sign_webhook_nonces') return nonce.table;
      if (table === 'webhook_dlq') return dlqInsertMock();
      throw new Error(`unexpected: ${table}`);
    });
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'rpc boom' } });

    const res = await postSignedBody(validBody());

    expect(res.status).toBe(500);
    expect(nonce.deleteFn).not.toHaveBeenCalled();
  });
});
