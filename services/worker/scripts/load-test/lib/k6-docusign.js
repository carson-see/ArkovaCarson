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

import {
  buildSyntheticConnectPayload,
  serializeConnectPayload,
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
 * way (`scenario:health|verify|docusign`, `intentional_503:no`).
 * @param {'health'|'verify'|'docusign'} scenario
 */
export function executeScenario(scenario, { workerUrl, key, accountId, vu, iter, withNotary = false }) {
  if (scenario === 'verify') {
    return http.get(`${workerUrl}${VERIFY_PATH}`, {
      headers: LOADTEST_HEADERS,
      tags: { intentional_503: 'no', scenario: 'verify' },
    });
  }
  if (scenario === 'docusign') {
    const { body, headers } = buildSignedConnectPost({ accountId, key, vu, iter, withNotary });
    return http.post(`${workerUrl}/webhooks/docusign`, body, {
      headers,
      tags: { intentional_503: 'no', scenario: 'docusign' },
    });
  }
  return http.get(`${workerUrl}/health`, {
    headers: LOADTEST_HEADERS,
    tags: { intentional_503: 'no', scenario: 'health' },
  });
}
