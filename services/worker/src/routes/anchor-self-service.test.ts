import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profileOrg: null as string | null,
  membership: true,
  membershipRole: 'owner',
  authorityUnavailable: false,
  linkRecipient: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  capturePepperAlert: vi.fn(),
  captured: null as null | { orgId: string | null; body: Record<string, unknown>; method: string; url: string },
  bulkBodies: [] as Array<Record<string, unknown>>,
}));
vi.mock('../api/v1/anchor-submit.js', () => ({
  BULK_FINGERPRINT_SOURCE: Symbol('testBulkFingerprintSource'),
  anchorSubmitRouter: (req: { apiKey?: { orgId: string | null }; body: Record<string, unknown>; method: string; url: string }, res: { json: (value: unknown) => void }) => {
    state.captured = { orgId: req.apiKey?.orgId ?? null, body: req.body, method: req.method, url: req.url };
    res.json({ ok: true });
  },
  handleAnchorSubmit: async (req: { body: Record<string, unknown> }, res: {
    status: (code: number) => typeof res;
    type: (value: string) => typeof res;
    json: (value: unknown) => void;
  }) => {
    state.bulkBodies.push(req.body);
    const fingerprint = req.body.fingerprint as string;
    if (fingerprint.startsWith('f')) {
      res.status(503);
      res.json({ error: 'instant_intent_unavailable' });
      return;
    }
    if (fingerprint.startsWith('e')) {
      res.status(402).type('application/problem+json').json({
        error: 'quota_exhausted',
        message: 'Anchor quota exhausted',
      });
      return;
    }
    res.status(fingerprint.startsWith('b') ? 200 : 201);
    res.json({
      public_id: `ARK-${fingerprint.slice(0, 4)}`,
      fingerprint,
      idempotent: fingerprint.startsWith('b'),
      instant_status: req.body.action === 'instant' ? 'QUEUED' : null,
    });
  },
}));
vi.mock('../api/bulk-recipient.js', () => ({ linkBulkRecipient: state.linkRecipient }));
vi.mock('../utils/logger.js', () => ({ logger: { warn: state.loggerWarn, error: state.loggerError } }));
vi.mock('../utils/sentry.js', () => ({
  captureRecipientPepperUnavailableAlert: state.capturePepperAlert,
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn((table: string) => ({
  select: vi.fn(() => ({
    eq: vi.fn(() => ({
      eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => (state.authorityUnavailable
        ? { data: null, error: { message: 'membership lookup unavailable' } }
        : { data: state.membership ? { id: 'membership', role: state.membershipRole } : null, error: null })) })),
      maybeSingle: vi.fn(async () => ({ data: table === 'profiles' ? { org_id: state.profileOrg, is_platform_admin: false } : null, error: null })),
    })),
  })),
})) } }));

import { anchorSelfServiceRouter } from './anchor-self-service.js';
import { handleAnchorImport } from './anchor-self-service-bulk.js';
import { RecipientPepperUnavailableError } from '../lib/recipient-identity.js';

// The /bulk route carries a 10-request-per-minute per-user limiter. Every app()
// gets its own caller so that adding a test never silently turns an assertion
// into a 429 for the test that happens to run eleventh.
let callerSeq = 0;
function nextCallerId(): string {
  callerSeq += 1;
  return `11111111-1111-4111-8111-${callerSeq.toString(16).padStart(12, '0')}`;
}

function app(userId: string = nextCallerId()) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => { req.userId = userId; next(); });
  instance.use(anchorSelfServiceRouter);
  return instance;
}

describe('anchor self-service context bridge', () => {
  beforeEach(() => {
    state.profileOrg = null; state.membership = true; state.membershipRole = 'owner'; state.authorityUnavailable = false;
    state.captured = null; state.bulkBodies = []; state.linkRecipient.mockReset();
    state.loggerWarn.mockReset(); state.loggerError.mockReset(); state.capturePepperAlert.mockReset();
  });

  it('passes personal scope as null and preserves validated UI metadata/tags', async () => {
    const body = { fingerprint: 'a'.repeat(64), action: 'instant', org_id: null, metadata: { ai_summary: 'safe', fraud_score: 0.1 }, private_tags: { user: ['tax'], organization: [] } };
    const response = await request(app()).post('/').send(body);
    expect(response.status).toBe(200);
    expect(state.captured).toMatchObject({
      orgId: null,
      body: { fingerprint: body.fingerprint, action: body.action, metadata: body.metadata, private_tags: body.private_tags },
      method: 'POST',
    });
    expect(state.captured?.body).not.toHaveProperty('org_id');
  });

  it('authorizes a selected member org and uses that exact scope instead of profile org', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    const selected = '33333333-3333-4333-8333-333333333333';
    const response = await request(app()).post('/').send({ fingerprint: 'b'.repeat(64), org_id: selected, metadata: { jurisdiction: 'MI' } });
    expect(response.status).toBe(200);
    expect(state.captured?.orgId).toBe(selected);
    expect(state.captured?.body.metadata).toEqual({ jurisdiction: 'MI' });
  });

  it('requires an explicit caller-owned scope for GET status and forwards the public path', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    const missing = await request(app()).get('/ARK-1/submission-status');
    expect(missing.status).toBe(400);

    const personal = await request(app()).get('/ARK-1/submission-status?scope=user');
    expect(personal.status).toBe(200);
    expect(state.captured).toMatchObject({ orgId: null, method: 'GET', url: '/ARK-1/submission-status?scope=user' });

    const selected = '33333333-3333-4333-8333-333333333333';
    const organization = await request(app()).get(`/ARK-1/submission-status?org_id=${selected}`);
    expect(organization.status).toBe(200);
    expect(state.captured).toMatchObject({ orgId: selected, method: 'GET' });
  });

  it('does not reveal a status across organization membership boundaries', async () => {
    state.membership = false;
    const selected = '33333333-3333-4333-8333-333333333333';
    const response = await request(app()).get(`/ARK-1/submission-status?org_id=${selected}`);
    expect(response.status).toBe(403);
    expect(state.captured).toBeNull();
  });

  it('runs each bulk row through the canonical submit contract and returns bounded partial results', async () => {
    const response = await request(app()).post('/bulk').send({
      org_id: null,
      action: 'instant',
      description: 'One import',
      private_tags: { user: ['tax'], organization: [] },
      rows: [
        { fingerprint: 'a'.repeat(64), filename: 'new.pdf', fingerprint_provided: false },
        { fingerprint: 'b'.repeat(64), filename: 'same.pdf', fingerprint_provided: true },
        { fingerprint: 'f'.repeat(64), filename: 'failed.pdf', fingerprint_provided: false },
      ],
    });
    expect(response.status).toBe(207);
    expect(response.body).toEqual({
      total: 3, created: 1, skipped: 1, failed: 1, recipient_link_failed: 0,
      results: [
        { fingerprint: 'a'.repeat(64), status: 'created', public_id: 'ARK-aaaa', instant_status: 'QUEUED' },
        { fingerprint: 'b'.repeat(64), status: 'skipped', public_id: 'ARK-bbbb', instant_status: 'QUEUED' },
        { fingerprint: 'f'.repeat(64), status: 'failed', reason: 'instant_intent_unavailable' },
      ],
    });
    expect(state.bulkBodies).toHaveLength(3);
    expect(state.bulkBodies[0]).toMatchObject({
      action: 'instant', description: 'One import',
      private_tags: { user: ['tax'], organization: [] },
    });
    expect(state.bulkBodies[0]).not.toHaveProperty('recipient_email');
    expect(state.bulkBodies[0]).not.toHaveProperty('fingerprint_provided');
  });

  it('preserves the canonical quota-exhausted response instead of degrading to submission_failed', async () => {
    const response = await request(app()).post('/bulk').send({
      org_id: null,
      action: 'queue',
      rows: [{
        fingerprint: 'e'.repeat(64),
        filename: 'quota.pdf',
        fingerprint_provided: true,
      }],
    });

    expect(response.status).toBe(207);
    expect(response.body).toMatchObject({
      total: 1,
      created: 0,
      skipped: 0,
      failed: 1,
      results: [{
        fingerprint: 'e'.repeat(64),
        status: 'failed',
        reason: 'quota_exhausted',
      }],
    });
  });

  // SHOULD-FIX from the #3020 review: a row whose anchor was created but whose
  // recipient link then threw was reported `status: 'failed'` and left out of
  // `created`. A caller reading that re-submits a row whose PERMANENT anchor
  // already exists — a duplicate submission attempt and, for a capped or
  // billable org, a double charge. The anchor is the durable fact, so it is
  // always counted; the link failure gets its own truthful status.
  it('counts a created anchor whose recipient link fails as created, not failed', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'owner';
    state.linkRecipient.mockRejectedValueOnce(new Error('recipient_activation_email_failed'));

    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });

    expect(response.status).toBe(207);
    expect(response.body.results[0]).toEqual({
      fingerprint: 'a'.repeat(64),
      status: 'created_recipient_failed',
      public_id: 'ARK-aaaa',
      reason: 'recipient_activation_email_failed',
    });
    // The anchor exists, so it is counted in `created` and NOT in `failed`.
    expect(response.body.created).toBe(1);
    expect(response.body.failed).toBe(0);
    expect(response.body.recipient_link_failed).toBe(1);
    // Summary stays arithmetically honest.
    expect(response.body.created + response.body.skipped + response.body.failed).toBe(response.body.total);
  });

  // The replay half of the same defect: re-submitting the row above dedupes to
  // the existing anchor (canonical submit answers `idempotent: true`, so no new
  // anchor and no new charge) and re-attempts ONLY the recipient link. If that
  // link fails again the row is still not `failed` — the anchor is there.
  it('replays a recipient-failed row without creating or charging again', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'owner';
    state.linkRecipient.mockRejectedValueOnce(new Error('recipient_activation_email_failed'));

    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      // `b`-prefixed fingerprints resolve to the idempotent receipt in the
      // canonical-submit mock, i.e. the anchor already exists.
      rows: [{
        fingerprint: 'b'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });

    expect(response.status).toBe(207);
    expect(response.body.results[0]).toEqual({
      fingerprint: 'b'.repeat(64),
      status: 'skipped_recipient_failed',
      public_id: 'ARK-bbbb',
      reason: 'recipient_activation_email_failed',
    });
    expect(response.body.created).toBe(0);
    expect(response.body.skipped).toBe(1);
    expect(response.body.failed).toBe(0);
    expect(response.body.recipient_link_failed).toBe(1);
    expect(response.body.created + response.body.skipped + response.body.failed).toBe(response.body.total);
    // Only the link was re-attempted; the submit deduped rather than creating.
    expect(state.linkRecipient).toHaveBeenCalledTimes(1);
    expect(state.bulkBodies).toHaveLength(1);
  });

  it('keeps a successful recipient link on the plain created status', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'owner';
    state.linkRecipient.mockResolvedValueOnce(undefined);

    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });

    expect(response.status).toBe(200);
    expect(response.body.results[0].status).toBe('created');
    expect(response.body.created).toBe(1);
    expect(response.body.recipient_link_failed).toBe(0);
  });

  it('bounds an unsafe recipient-link error into a stable reason code', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'owner';
    state.linkRecipient.mockRejectedValueOnce(new Error('recipient bob@example.test could not be linked'));

    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });

    expect(response.body.results[0].status).toBe('created_recipient_failed');
    expect(response.body.results[0].reason).toBe('recipient_link_failed');
    // No PII from the thrown message reaches the response.
    expect(JSON.stringify(response.body)).not.toContain('bob@example.test');
  });

  it('rejects more than 100 rows before submitting any row', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      fingerprint: index.toString(16).padStart(64, '0'),
      filename: `${index}.pdf`,
      fingerprint_provided: false,
    }));
    const response = await request(app()).post('/bulk').send({ org_id: null, action: 'queue', rows });
    expect(response.status).toBe(400);
    expect(state.bulkBodies).toEqual([]);
  });

  it('rejects recipient_name without recipient_email before submitting any row', async () => {
    const response = await request(app()).post('/bulk').send({
      org_id: null,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_name: 'Recipient Only',
      }],
    });
    expect(response.status).toBe(400);
    expect(state.bulkBodies).toEqual([]);
  });

  // B1 (BLOCKING regression against main): a caller without recipient-provisioning
  // authority used to have the WHOLE request rejected 403, so a personal-scope user
  // importing a spreadsheet with any column containing "mail" got zero anchors and a
  // generic transport error. The anchor is the durable fact: every row is still
  // submitted, only the link is skipped, and those rows carry their own reason.
  it('anchors every row for a plain member and reports only the recipient link as forbidden', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'member';
    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });
    expect(response.status).toBe(207);
    expect(response.body.results[0]).toEqual({
      fingerprint: 'a'.repeat(64),
      status: 'created_recipient_failed',
      public_id: 'ARK-aaaa',
      reason: 'recipient_provisioning_forbidden',
    });
    expect(response.body.created).toBe(1);
    expect(response.body.failed).toBe(0);
    expect(response.body.recipient_link_failed).toBe(1);
    expect(response.body.created + response.body.skipped + response.body.failed).toBe(response.body.total);
    // The anchor was submitted; the link was never attempted.
    expect(state.bulkBodies).toHaveLength(1);
    expect(state.linkRecipient).not.toHaveBeenCalled();
  });

  it('anchors personal-scope rows that carry a recipient instead of failing the batch', async () => {
    const response = await request(app()).post('/bulk').send({
      org_id: null,
      action: 'queue',
      rows: [
        { fingerprint: 'a'.repeat(64), filename: 'with-recipient.pdf', fingerprint_provided: true, recipient_email: 'recipient@example.test' },
        { fingerprint: 'b'.repeat(64), filename: 'plain.pdf', fingerprint_provided: true },
      ],
    });
    expect(response.status).toBe(207);
    expect(response.body.results[0]).toMatchObject({ status: 'created_recipient_failed', reason: 'recipient_provisioning_forbidden' });
    // A row WITHOUT a recipient stays a plain created/skipped row.
    expect(response.body.results[1]).toEqual({ fingerprint: 'b'.repeat(64), status: 'skipped', public_id: 'ARK-bbbb' });
    expect(response.body.created).toBe(1);
    expect(response.body.skipped).toBe(1);
    expect(response.body.failed).toBe(0);
    expect(response.body.recipient_link_failed).toBe(1);
    expect(state.bulkBodies).toHaveLength(2);
    expect(state.linkRecipient).not.toHaveBeenCalled();
  });

  it('logs the forbidden recipient link at warn level with no recipient PII', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'member';
    await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test', recipient_name: 'Reese Recipient',
      }],
    });
    expect(state.loggerWarn).toHaveBeenCalledTimes(1);
    const [context] = state.loggerWarn.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toEqual({
      reason: 'recipient_provisioning_forbidden',
      publicId: 'ARK-aaaa',
      orgId: state.profileOrg,
    });
    expect(JSON.stringify(state.loggerWarn.mock.calls)).not.toContain('recipient@example.test');
    expect(JSON.stringify(state.loggerWarn.mock.calls)).not.toContain('Reese Recipient');
  });

  it('logs a thrown recipient-link failure at error level with only the bounded reason', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'owner';
    state.linkRecipient.mockRejectedValueOnce(new Error('recipient bob@example.test could not be linked'));
    await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });
    expect(state.loggerError).toHaveBeenCalledTimes(1);
    const [context] = state.loggerError.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toEqual({
      reason: 'recipient_link_failed',
      publicId: 'ARK-aaaa',
      orgId: state.profileOrg,
    });
    // Neither the raw thrown message nor the recipient address may reach the log.
    expect(JSON.stringify(state.loggerError.mock.calls)).not.toContain('bob@example.test');
    expect(JSON.stringify(state.loggerError.mock.calls)).not.toContain('could not be linked');
  });

  // S7: a missing RECIPIENT_IDENTIFIER_PEPPER is a config outage, not a row defect.
  // It must be distinguishable in the logs and page ONCE per request, not once per row.
  it('raises the pepper-unavailable alert once per request no matter how many rows fail', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.membershipRole = 'owner';
    state.linkRecipient.mockRejectedValue(new RecipientPepperUnavailableError());
    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [
        { fingerprint: 'a'.repeat(64), filename: 'one.pdf', fingerprint_provided: true, recipient_email: 'one@example.test' },
        { fingerprint: 'c'.repeat(64), filename: 'two.pdf', fingerprint_provided: true, recipient_email: 'two@example.test' },
      ],
    });
    expect(response.body.recipient_link_failed).toBe(2);
    expect(response.body.results.map((row: { reason?: string }) => row.reason))
      .toEqual(['recipient_pepper_unavailable', 'recipient_pepper_unavailable']);
    expect(state.capturePepperAlert).toHaveBeenCalledTimes(1);
    expect(state.capturePepperAlert).toHaveBeenCalledWith({
      operation: 'anchor-self-service-bulk.linkBulkRecipient',
      orgId: state.profileOrg,
      affectedRows: 2,
    });
    // Every row still logs its own bounded line.
    expect(state.loggerError).toHaveBeenCalledTimes(2);
  });

  it('still rejects the whole request when recipient authority cannot be read', async () => {
    state.profileOrg = '22222222-2222-4222-8222-222222222222';
    state.authorityUnavailable = true;
    const response = await request(app()).post('/bulk').send({
      org_id: state.profileOrg,
      action: 'queue',
      rows: [{
        fingerprint: 'a'.repeat(64), filename: 'recipient.pdf', fingerprint_provided: true,
        recipient_email: 'recipient@example.test',
      }],
    });
    // Unknown authority is transient and pre-work: nothing was created, so a
    // retryable 503 loses no durable state. Only a DENIED answer degrades to a
    // per-row outcome.
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('recipient_authorization_unavailable');
    expect(state.bulkBodies).toEqual([]);
  });

  it('derives the API-key import tenant and rejects a caller-chosen mismatch', async () => {
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => {
      req.apiKey = {
        keyId: 'key-1', keyPrefix: 'arkv_', userId: 'user-1',
        orgId: '22222222-2222-4222-8222-222222222222', scopes: ['anchor:write'], rateLimitTier: 'paid',
      };
      next();
    });
    api.post('/api/v1/anchor/import', handleAnchorImport);
    const row = { fingerprint: 'a'.repeat(64), filename: 'one.pdf', fingerprint_provided: true };

    const accepted = await request(api).post('/api/v1/anchor/import').send({ action: 'queue', rows: [row] });
    expect(accepted.status).toBe(200);
    expect(state.bulkBodies).toHaveLength(1);

    const denied = await request(api).post('/api/v1/anchor/import').send({
      org_id: '33333333-3333-4333-8333-333333333333', action: 'queue', rows: [row],
    });
    expect(denied.status).toBe(403);
    expect(state.bulkBodies).toHaveLength(1);
  });
});
