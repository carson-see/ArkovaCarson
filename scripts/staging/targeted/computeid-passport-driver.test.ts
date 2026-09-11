// @vitest-environment node
import { createServer } from 'node:http';

import { createHmac, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { newDriverStats, summarizeEvidence } from './driver-core';
import {
  COMPUTEID_DRIVER,
  classifyKeyState,
  deriveKeyIdFromSpkiPem,
  planCycle,
  recordAssertion,
  redactAdmissionBody,
  signDelivery,
  signReceipt,
  runTerminalRevocation,
} from './computeid-passport-driver';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SPKI_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const PASSPORT = '3f1d2c4b-5a6e-4f70-8b91-0c2d3e4f5a6b';

describe('computeid-passport-driver: receipt signing (what the rig verifies against its pinned CA)', () => {
  it('derives key_id exactly as the worker does — sha256 over the SPKI PEM text, first 16 hex', () => {
    const keyId = deriveKeyIdFromSpkiPem(SPKI_PEM);
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('signs receipt_payload with RSA-SHA256 and mirrors every field into the unsigned siblings', () => {
    const receipt = signReceipt({
      privateKeyPem: PRIVATE_PEM,
      spkiPem: SPKI_PEM,
      passportId: PASSPORT,
      issuedAt: '2026-09-07T12:00:00.000Z',
      expiresAt: '2026-09-07T12:30:00.000Z',
    });
    expect(receipt.receipt_algorithm).toBe('RSA-SHA256');
    expect(receipt.key_id).toBe(deriveKeyIdFromSpkiPem(SPKI_PEM));
    expect(receipt.status).toBe('active');
    expect(receipt.signature_valid).toBe(true);
    const signed = JSON.parse(receipt.receipt_payload) as Record<string, unknown>;
    expect(signed).toEqual({
      passport_id: PASSPORT,
      status: 'active',
      signature_valid: true,
      issued_at: receipt.issued_at,
      expires_at: receipt.expires_at,
      key_id: receipt.key_id,
    });
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(receipt.receipt_payload, 'utf8'),
      publicKey,
      Buffer.from(receipt.receipt_signature, 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('lets a cycle mint a deliberately NON-active receipt so the rig must refuse it', () => {
    const receipt = signReceipt({
      privateKeyPem: PRIVATE_PEM,
      spkiPem: SPKI_PEM,
      passportId: PASSPORT,
      issuedAt: '2026-09-07T12:00:00.000Z',
      expiresAt: '2026-09-07T12:30:00.000Z',
      status: 'revoked',
    });
    expect(JSON.parse(receipt.receipt_payload).status).toBe('revoked');
  });
});

describe('computeid-passport-driver: webhook delivery signing (ComputeID wire format)', () => {
  it('produces compact JSON and X-ComputeID-Signature: sha256=<hex HMAC over the exact bytes>', () => {
    const { body, headers } = signDelivery('shh-secret', {
      event: 'passport.revoked',
      passport_id: PASSPORT,
      timestamp: '2026-09-07T12:00:01.000Z',
      reason: 'soak',
    });
    expect(body).toBe(
      `{"event":"passport.revoked","passport_id":"${PASSPORT}","timestamp":"2026-09-07T12:00:01.000Z","reason":"soak"}`,
    );
    const expected = 'sha256=' + createHmac('sha256', 'shh-secret').update(body).digest('hex');
    expect(headers['X-ComputeID-Signature']).toBe(expected);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('a different secret yields a different signature (the rig must 401 it)', () => {
    const a = signDelivery('one', { event: 'test', timestamp: '2026-09-07T12:00:00Z' });
    const b = signDelivery('two', { event: 'test', timestamp: '2026-09-07T12:00:00Z' });
    expect(a.body).toBe(b.body);
    expect(a.headers['X-ComputeID-Signature']).not.toBe(b.headers['X-ComputeID-Signature']);
  });
});

describe('computeid-passport-driver: key-state classification via GET /api/v1/verify/:publicId', () => {
  it('401 means the agent key no longer authenticates; 400/404 mean it does', () => {
    expect(classifyKeyState(401)).toBe('off');
    expect(classifyKeyState(404)).toBe('on');
    expect(classifyKeyState(400)).toBe('on');
  });
  it('transport failure and 5xx are unknown — never counted as either state', () => {
    expect(classifyKeyState(0)).toBe('unknown');
    expect(classifyKeyState(500)).toBe('unknown');
    expect(classifyKeyState(429)).toBe('unknown');
  });
});

describe('computeid-passport-driver: cycle plan is deterministic and strictly ordered', () => {
  const now = new Date('2026-09-07T12:00:00.000Z');
  const plan = planCycle(now, 7, () => '3f1d2c4b-5a6e-4f70-8b91-0c2d3e4f5a6b');

  it('receipt issued_at precedes every lifecycle timestamp and expires later than the cycle', () => {
    const issued = Date.parse(plan.receipt.issuedAt);
    const expires = Date.parse(plan.receipt.expiresAt);
    expect(issued).toBeLessThan(Date.parse(plan.lifecycle.suspendAt));
    expect(expires).toBeGreaterThan(Date.parse(plan.lifecycle.lateReinstateAt));
  });

  it('lifecycle timestamps ascend: suspend < reinstate < revoke < lateReinstate', () => {
    const ts = [plan.lifecycle.suspendAt, plan.lifecycle.reinstateAt, plan.lifecycle.revokeAt, plan.lifecycle.lateReinstateAt].map(Date.parse);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(new Set(ts).size).toBe(4);
  });

  it('the terminal revocation timestamp predates receipt issued_at', () => {
    expect(Date.parse(plan.preAdmissionRevokeAt)).toBeLessThan(Date.parse(plan.receipt.issuedAt));
  });

  it('the race has six interleaved events with distinct ascending timestamps ending on passport.revoked', () => {
    expect(plan.race).toHaveLength(6);
    const ts = plan.race.map((r) => Date.parse(r.timestamp));
    expect(new Set(ts).size).toBe(6);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(plan.race.at(-1)?.event).toBe('passport.revoked');
    expect(plan.race.map((r) => r.event)).toContain('passport.suspended');
    expect(plan.race.map((r) => r.event)).toContain('passport.reinstated');
  });

  it('names the cycle so evidence files are attributable', () => {
    expect(plan.cycle).toBe(7);
    expect(plan.agentName).toBe('computeid-soak-c7');
  });
});

describe('computeid-passport-driver: semantic assertions become labeled outcomes', () => {
  it('a passing assertion is expected; a failing one is unexpected and flips allExpected', () => {
    const stats = newDriverStats();
    recordAssertion(stats, 'suspend-applied', true, { applied: 1 });
    recordAssertion(stats, 'key-off-after-suspend', false, { status: 404 });
    expect(stats.byLabel['suspend-applied'].expected).toBe(1);
    expect(stats.byLabel['key-off-after-suspend'].unexpected).toBe(1);
    const failing = stats.outcomes.find((o) => o.label === 'key-off-after-suspend');
    expect(failing?.expected).toBe(false);
    expect(failing?.capturedBody).toEqual({ status: 404 });
  });
});

describe('computeid-passport-driver: the raw agent key never reaches evidence', () => {
  it('redacts `key` and leaves the public agent/binding shape intact', () => {
    const redacted = redactAdmissionBody({
      agent: { id: 'a1', status: 'active' },
      binding: { issuer: 'computeid', passport_id: PASSPORT },
      key: 'ak_live_deadbeef',
      warning: 'once',
    });
    expect(redacted).toEqual({
      agent: { id: 'a1', status: 'active' },
      binding: { issuer: 'computeid', passport_id: PASSPORT },
      key: '[REDACTED]',
      warning: 'once',
    });
  });
  it('is a no-op on non-object bodies', () => {
    expect(redactAdmissionBody('nope')).toBe('nope');
    expect(redactAdmissionBody(null)).toBeNull();
  });
});

describe('computeid-passport-driver: identity', () => {
  it('names the PR it soaks', () => {
    expect(COMPUTEID_DRIVER).toEqual({ driver: 'computeid-passport', pr: '#2668' });
  });
});


describe('computeid-passport-driver: terminal scenario over real loopback HTTP', () => {
  async function drive(legacyOrderingFloor: boolean) {
    const agentKey = 'ak_test_driver_only_terminal';
    const webhookSecret = 'local-driver-test-secret';
    const plan = planCycle(new Date('2026-09-10T12:00:00.000Z'), 1, () => PASSPORT);
    const seen: Array<{ path: string; key?: string; body: string; signature?: string }> = [];
    let revocations = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({
        path: request.url ?? '',
        key: request.headers['x-api-key'] as string | undefined,
        body,
        signature: request.headers['x-computeid-signature'] as string | undefined,
      });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/v1/agents/computeid/admit') {
        response.writeHead(201).end(JSON.stringify({ agent: { id: 'fixture-agent' }, key: agentKey }));
      } else if (request.url === '/webhooks/computeid') {
        revocations += 1;
        const applied = legacyOrderingFloor ? Number(revocations === 2) : Number(revocations === 1);
        response.writeHead(200).end(JSON.stringify({ applied }));
      } else if (request.url === '/api/v1/verify/ARK-SOAK-NOPE') {
        response.writeHead(legacyOrderingFloor && revocations === 1 ? 404 : 401).end('{}');
      } else {
        response.writeHead(500).end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      const apiBase = `http://127.0.0.1:${address.port}`;
      const stats = newDriverStats();
      await runTerminalRevocation({
        apiBase, stats, capture: true,
        rig: {
          orgApiKey: 'local-org-fixture', webhookSecret, signerKeyPem: PRIVATE_PEM,
          golden: { body: '', header_name: '', header_value: '', content_type: '' },
          db: null, iam: () => ({}),
        },
      }, plan);
      const evidence = summarizeEvidence(stats, { ...COMPUTEID_DRIVER, apiBase });
      expect(seen.map(({ path }) => path)).toEqual([
        '/api/v1/agents/computeid/admit', '/webhooks/computeid', '/api/v1/verify/ARK-SOAK-NOPE',
        '/webhooks/computeid', '/api/v1/verify/ARK-SOAK-NOPE',
      ]);
      expect(seen[0].key).toBe('local-org-fixture');
      expect(seen[2].key).toBe(agentKey);
      expect(seen[4].key).toBe(agentKey);
      const receipt = JSON.parse(seen[0].body).verification_receipt;
      expect(cryptoVerify('sha256', Buffer.from(receipt.receipt_payload), publicKey,
        Buffer.from(receipt.receipt_signature, 'base64'))).toBe(true);
      const older = JSON.parse(seen[1].body);
      expect(Date.parse(older.timestamp)).toBeLessThan(Date.parse(receipt.issued_at));
      for (const delivery of [seen[1], seen[3]]) {
        expect(delivery.signature).toBe('sha256=' + createHmac('sha256', webhookSecret).update(delivery.body).digest('hex'));
      }
      expect(JSON.stringify(evidence)).not.toContain(agentKey);
      return evidence;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  it('qualifies terminal revocation before admission time and its subsequent replay', async () => {
    const evidence = await drive(false);
    expect(evidence.allExpected).toBe(true);
    expect(evidence.byLabel['terminal-revoke-overrides-receipt-floor'].expected).toBe(1);
    expect(evidence.byLabel['terminal-revoke-remains-enforced'].expected).toBe(1);
  });

  it('rejects legacy ordering-floor responses even when both webhooks return 200', async () => {
    const evidence = await drive(true);
    expect(evidence.allExpected).toBe(false);
    expect(evidence.byLabel['pre-admission-revoke-200'].expected).toBe(1);
    expect(evidence.byLabel['floor-current-revoke-200'].expected).toBe(1);
    expect(evidence.byLabel['terminal-revoke-overrides-receipt-floor'].unexpected).toBe(1);
    expect(evidence.byLabel['terminal-revoke-remains-enforced'].unexpected).toBe(1);
    expect(evidence.byLabel['key-refused-after-terminal-revoke'].unexpected).toBe(1);
  });
});
