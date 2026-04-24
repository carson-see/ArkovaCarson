import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { contractsWebhookRouter } from './contracts.js';

function app() {
  const testApp = express();
  testApp.use(express.raw({ type: 'application/json' }));
  testApp.use((req, _res, next) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    next();
  });
  testApp.use('/webhooks/contracts', contractsWebhookRouter);
  return testApp;
}

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('contractsWebhookRouter', () => {
  it('verifies DocuSign Connect HMAC before accepting a completion event', async () => {
    process.env.DOCUSIGN_CONNECT_HMAC_SECRET = 'connect-secret';
    const rawBody = Buffer.from(JSON.stringify({
      event: 'envelope-completed',
      data: { envelopeId: 'DS-ENV-100' },
    }));
    const signature = createHmac('sha256', 'connect-secret').update(rawBody).digest('base64');

    const res = await request(app())
      .post('/webhooks/contracts/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', signature)
      .send(rawBody.toString('utf8'))
      .expect(202);

    expect(res.body).toEqual({
      received: true,
      provider: 'docusign',
      envelopeId: 'DS-ENV-100',
      event: 'envelope-completed',
    });
  });

  it('rejects DocuSign completion events with a bad signature', async () => {
    process.env.DOCUSIGN_CONNECT_HMAC_SECRET = 'connect-secret';

    await request(app())
      .post('/webhooks/contracts/docusign')
      .set('Content-Type', 'application/json')
      .set('X-DocuSign-Signature-1', 'bad-signature')
      .send(Buffer.from('{"event":"envelope-completed"}'))
      .expect(401);
  });

  it('responds to Adobe verification-of-intent requests with the registered client id', async () => {
    process.env.ADOBE_SIGN_CLIENT_ID = 'adobe-client-1';

    const res = await request(app())
      .get('/webhooks/contracts/adobe')
      .set('X-AdobeSign-ClientId', 'adobe-client-1')
      .expect(200);

    expect(res.headers['x-adobesign-clientid']).toBe('adobe-client-1');
    expect(res.body).toEqual({ xAdobeSignClientId: 'adobe-client-1' });
  });

  it('verifies Adobe completion events against the registered client id', async () => {
    process.env.ADOBE_SIGN_CLIENT_ID = 'adobe-client-1';

    const res = await request(app())
      .post('/webhooks/contracts/adobe')
      .set('Content-Type', 'application/json')
      .set('X-AdobeSign-ClientId', 'adobe-client-1')
      .send(JSON.stringify({
        event: 'AGREEMENT_ACTION_COMPLETED',
        agreement: { id: 'ADOBE-AGR-200' },
      }))
      .expect(202);

    expect(res.body).toEqual({
      received: true,
      provider: 'adobe_sign',
      envelopeId: 'ADOBE-AGR-200',
      event: 'AGREEMENT_ACTION_COMPLETED',
      xAdobeSignClientId: 'adobe-client-1',
    });
  });
});
