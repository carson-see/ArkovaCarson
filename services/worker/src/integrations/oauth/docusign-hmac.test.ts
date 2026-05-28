import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyDocusignConnectHmacMultiKey } from './docusign-hmac.js';

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

const BODY = '{"event":"envelope-completed","envelopeId":"abc-123"}';
const KEY_A = 'secret-key-alpha-000';
const KEY_B = 'secret-key-bravo-111';
const KEY_C = 'secret-key-charlie-222';

describe('verifyDocusignConnectHmacMultiKey', () => {
  it('accepts valid signature with a single key', () => {
    const sig = sign(BODY, KEY_A);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [sig],
        keys: [KEY_A],
      }),
    ).toBe(true);
  });

  it('accepts when any signature matches any key (key A, sig from A)', () => {
    const sigA = sign(BODY, KEY_A);
    const sigB = sign(BODY, KEY_B);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [sigA, sigB],
        keys: [KEY_A, KEY_B],
      }),
    ).toBe(true);
  });

  it('accepts during rotation: new key matches second signature header', () => {
    const sigOld = sign(BODY, KEY_A);
    const sigNew = sign(BODY, KEY_B);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [sigOld, sigNew],
        keys: [KEY_B],
      }),
    ).toBe(true);
  });

  it('accepts during rotation: old key matches first signature header', () => {
    const sigOld = sign(BODY, KEY_A);
    const sigNew = sign(BODY, KEY_B);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [sigOld, sigNew],
        keys: [KEY_A],
      }),
    ).toBe(true);
  });

  it('rejects when no signature matches any key', () => {
    const sigA = sign(BODY, KEY_A);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [sigA],
        keys: [KEY_C],
      }),
    ).toBe(false);
  });

  it('rejects when signatures array is empty', () => {
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [],
        keys: [KEY_A],
      }),
    ).toBe(false);
  });

  it('rejects when keys array is empty', () => {
    const sig = sign(BODY, KEY_A);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [sig],
        keys: [],
      }),
    ).toBe(false);
  });

  it('rejects tampered body', () => {
    const sig = sign(BODY, KEY_A);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY + 'tampered'),
        signatures: [sig],
        keys: [KEY_A],
      }),
    ).toBe(false);
  });

  it('rejects malformed base64 signature gracefully', () => {
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: ['not-valid-base64!!!'],
        keys: [KEY_A],
      }),
    ).toBe(false);
  });

  it('handles string rawBody', () => {
    const sig = sign(BODY, KEY_A);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: BODY,
        signatures: [sig],
        keys: [KEY_A],
      }),
    ).toBe(true);
  });

  it('filters undefined/empty signature entries', () => {
    const sig = sign(BODY, KEY_A);
    expect(
      verifyDocusignConnectHmacMultiKey({
        rawBody: Buffer.from(BODY),
        signatures: [undefined as unknown as string, '', sig],
        keys: [KEY_A],
      }),
    ).toBe(true);
  });
});
