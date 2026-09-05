/**
 * SCRUM-2094 [DS-VOL-01] — k6-only request glue for the DocuSign Connect leg.
 *
 * This module imports k6/http + k6/crypto, so it runs ONLY in the k6 (Goja)
 * harness — Vitest cannot import it. That is fine: the drift-prone part (the
 * payload shape + canonical serialization) lives in the runtime-agnostic
 * ./docusign-synth.js, which IS cross-validated against the real receiver in
 * docusign-synth.test.ts. The contract that lets this glue stay untested:
 *
 *   k6 crypto.hmac('sha256', key, body, 'base64')
 *     ≡ node crypto.createHmac('sha256', key).update(body).digest('base64')
 *
 * for identical input bytes — and the Vitest suite proves the node-side HMAC
 * over serializeConnectPayload(...) is accepted by the worker's verifier. Since
 * we sign the exact bytes we send, the two runtimes agree by construction.
 */
import http from 'k6/http';
import crypto from 'k6/crypto';
import { sleep } from 'k6';

import {
  buildSyntheticConnectPayload,
  serializeConnectPayload,
  buildBilateralRequest,
} from './docusign-synth.js';

const VERIFY_PATH = '/api/v1/verify/anchor/00000000-0000-0000-0000-000000000000';

// Inert marker so ops can filter synthetic GET traffic in logs. Deliberately
// NOT applied to the signed POST: it is not part of the signed body and must
// not perturb the bytes the worker verifies.
const LOADTEST_HEADERS = { 'x-arkova-loadtest': '1' };

/** base64 HMAC-SHA256 over the raw body, matching the worker's verifier. */
export function signConnectBase64(body, key) {
  return crypto.hmac('sha256', key, body, 'base64');
}

/**
 * Build a signed `envelope-completed` Connect POST. Returns { body, headers }
 * where `body` is the EXACT string that was signed (so signed bytes == sent
 * bytes). envelopeId/eventId are made unique per VU+iter so nonce-dedupe does
 * not collapse the run into a single processed envelope.
 */
export function buildSignedConnectPost({ accountId, key, vu, iter, withNotary = false }) {
  const payload = buildSyntheticConnectPayload({
    accountId,
    envelopeId: `loadtest-env-${vu}-${iter}`,
    eventId: `loadtest-evt-${vu}-${iter}`,
    generatedDateTime: new Date().toISOString(),
    withNotary,
  });
  const body = serializeConnectPayload(payload);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'X-DocuSign-Signature-1': signConnectBase64(body, key),
    },
  };
}

/**
 * Fire one request for the chosen scenario and return the k6 http response.
 * Centralizes route + tag assignment so every profile tags traffic the same
 * way (`scenario:health|verify|docusign`).
 * @param {'health'|'verify'|'docusign'} scenario
 */
export function executeScenario(scenario, { workerUrl, key, accountId, vu, iter, withNotary = false }) {
  if (scenario === 'verify') {
    return http.get(`${workerUrl}${VERIFY_PATH}`, {
      headers: LOADTEST_HEADERS,
      tags: { scenario: 'verify' },
    });
  }
  if (scenario === 'docusign') {
    const { body, headers } = buildSignedConnectPost({ accountId, key, vu, iter, withNotary });
    return http.post(`${workerUrl}/webhooks/docusign`, body, {
      headers,
      tags: { scenario: 'docusign' },
    });
  }
  return http.get(`${workerUrl}/health`, {
    headers: LOADTEST_HEADERS,
    tags: { scenario: 'health' },
  });
}

// ── docusign-bilateral-2026-08 (CTO Decision Record, R9) ────────────────────
//
// k6-only glue for the bilateral soak: signs + posts every `BilateralStep`
// `buildBilateralRequest` (docusign-synth.js) produces. Same division of
// labor as the rest of this file — payload SHAPE lives in the crypto-free
// synth module (cross-validated in docusign-bilateral-synth.test.ts), signing
// + HTTP assembly lives here (k6-only, not unit-tested directly).

/**
 * A key that is deliberately never equal to any real signing key, for the
 * 'wrong_hmac' family. Suffix guarantees non-collision even if `realKey` is
 * empty or already ends oddly.
 * @param {string} realKey
 * @returns {string}
 */
function deliberatelyWrongKey(realKey) {
  return `${realKey}-loadtest-wrong-key-do-not-use`;
}

/**
 * Resolve which key material a step's `signAs` role maps to.
 * @param {'org'|'wrong'|'shared'} signAs
 * @param {{ orgKey: string, sharedKey: string }} keys
 * @returns {string}
 */
function resolveSigningKey(signAs, keys) {
  if (signAs === 'shared') return keys.sharedKey;
  if (signAs === 'wrong') return deliberatelyWrongKey(keys.orgKey);
  return keys.orgKey;
}

/**
 * Fire ONE BilateralStep and return the k6 http response.
 * @param {import('./docusign-synth.js').BilateralStep} step
 * @param {{ workerUrl: string, orgKey: string, sharedKey: string }} keys
 */
export function executeBilateralStep(step, keys) {
  const body = typeof step.payload === 'string' ? step.payload : serializeConnectPayload(step.payload);
  const signingKey = resolveSigningKey(step.signAs, keys);
  const signature = signConnectBase64(body, signingKey);
  const query = step.customrecipient ? '?customrecipient=true' : '';

  return http.post(`${keys.workerUrl}/webhooks/docusign${query}`, body, {
    headers: {
      'content-type': 'application/json',
      'X-DocuSign-Signature-1': signature,
    },
    tags: { scenario: 'docusign', family: step.label },
  });
}

/**
 * Build + fire every step for a bilateral family (most families are one
 * step; 'replay' and 'self_forgery_provenance_conflict' are two paired
 * steps — `delayMs` on a step sleeps before firing it). Returns the ordered
 * `{ step, res }` pairs so the caller's `check()` calls can assert per-step
 * `expectStatus`.
 * @param {string} family
 * @param {import('./docusign-synth.js').BilateralContext & { workerUrl: string, orgKey: string, sharedKey: string }} ctx
 * @returns {Array<{ step: import('./docusign-synth.js').BilateralStep, res: unknown }>}
 */
export function executeBilateralRequest(family, ctx) {
  const steps = buildBilateralRequest(family, ctx);
  const results = [];
  for (const step of steps) {
    if (step.delayMs) sleep(step.delayMs / 1000);
    results.push({ step, res: executeBilateralStep(step, ctx) });
  }
  return results;
}
