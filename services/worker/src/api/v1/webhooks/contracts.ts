import { Router, type Request, type Response } from 'express';
import {
  verifyAdobeSignWebhookSignature,
  verifyDocuSignConnectSignature,
} from '../../../ai/contracts/e-signature-providers.js';

export const contractsWebhookRouter = Router();

contractsWebhookRouter.post('/docusign', (req: Request, res: Response) => {
  const rawBody = readRawBody(req);
  const secret = process.env.DOCUSIGN_CONNECT_HMAC_SECRET;
  const signature = headerValue(req, 'x-docusign-signature-1');

  if (!verifyDocuSignConnectSignature(rawBody, signature, secret)) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  const payload = parseWebhookJson(rawBody);
  if (!payload) {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }

  res.status(202).json({
    received: true,
    provider: 'docusign',
    envelopeId: readNestedString(payload, ['data', 'envelopeId']) ?? readString(payload, 'envelopeId') ?? 'unknown',
    event: readString(payload, 'event') ?? readString(payload, 'eventType') ?? 'unknown',
  });
});

contractsWebhookRouter.get('/adobe', (req: Request, res: Response) => {
  const expectedClientId = process.env.ADOBE_SIGN_CLIENT_ID;
  const clientId = headerValue(req, 'x-adobesign-clientid');

  if (!expectedClientId || clientId !== expectedClientId) {
    res.status(403).json({ error: 'invalid_client_id' });
    return;
  }

  res.setHeader('X-AdobeSign-ClientId', expectedClientId);
  res.json({ xAdobeSignClientId: expectedClientId });
});

contractsWebhookRouter.post('/adobe', (req: Request, res: Response) => {
  const rawBody = readRawBody(req);
  const expectedClientId = process.env.ADOBE_SIGN_CLIENT_ID;

  if (!verifyAdobeSignWebhookSignature({
    rawBody,
    headers: req.headers as Record<string, string | string[] | undefined>,
    expectedClientId,
    sharedSecret: process.env.ADOBE_SIGN_WEBHOOK_SECRET,
  })) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  const payload = parseWebhookJson(rawBody);
  if (!payload) {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }

  if (expectedClientId) {
    res.setHeader('X-AdobeSign-ClientId', expectedClientId);
  }
  res.status(202).json({
    received: true,
    provider: 'adobe_sign',
    envelopeId: readNestedString(payload, ['agreement', 'id']) ?? readString(payload, 'agreementId') ?? 'unknown',
    event: readString(payload, 'event') ?? readString(payload, 'eventType') ?? 'unknown',
    xAdobeSignClientId: expectedClientId,
  });
});

function readRawBody(req: Request): Buffer {
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return Buffer.from(JSON.stringify(req.body ?? {}));
}

function parseWebhookJson(rawBody: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function headerValue(req: Request, wanted: string): string | undefined {
  const value = req.headers[wanted] ?? req.headers[wanted.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : null;
}

function readNestedString(value: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
