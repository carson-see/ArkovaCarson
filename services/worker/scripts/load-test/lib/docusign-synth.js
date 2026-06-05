/**
 * SCRUM-2094 [DS-VOL-01] — synthetic DocuSign Connect load-payload generator.
 *
 * Pure, dependency-free ESM so it imports cleanly into BOTH runtimes:
 *   - the k6 harness (Goja) — signs with k6/crypto and POSTs the payload
 *   - Vitest (Node)         — cross-validates the output against the real
 *                             receiver (parseDocusignConnectPayload, the HMAC
 *                             verifier, extractNotaryData)
 *
 * It deliberately contains NO crypto, NO clock, and NO RNG: the caller supplies
 * ids / timestamps / a random draw, which keeps every output byte-for-byte
 * deterministic (so a signature computed over serializeConnectPayload() is
 * stable) and makes the unit tests reproducible.
 *
 * The shapes here mirror the completed-envelope contract enforced by
 * RawConnectPayload / parseDocusignConnectPayload in
 * src/integrations/oauth/docusign.ts. If that schema changes, the Vitest
 * cross-validation in docusign-synth.test.ts fails — by design.
 */

/**
 * @typedef {Object} ScenarioMix
 * @property {number} health   Fraction routed to GET /health.
 * @property {number} verify   Fraction routed to GET /api/v1/verify/anchor/…
 * @property {number} docusign Fraction routed to POST /webhooks/docusign.
 */

/**
 * Production-observed traffic mix for the first-client volume profile: 15% of
 * requests are DocuSign Connect envelope-completed webhooks (SCRUM-2094 spec),
 * the remainder split across health/diagnostics and anchor verification.
 * @type {ScenarioMix}
 */
export const DEFAULT_MIX = { health: 0.5, verify: 0.35, docusign: 0.15 };

/**
 * Weighted scenario selection. `rand` is a draw in [0, 1) supplied by the
 * caller (k6: Math.random(); tests: a seeded PRNG). Cumulative order is
 * health → verify → docusign.
 * @param {number} rand
 * @param {ScenarioMix} [mix]
 * @returns {'health' | 'verify' | 'docusign'}
 */
export function pickScenario(rand, mix = DEFAULT_MIX) {
  if (rand < mix.health) return 'health';
  if (rand < mix.health + mix.verify) return 'verify';
  return 'docusign';
}

/**
 * @typedef {Object} SyntheticConnectOptions
 * @property {string} accountId            DocuSign account id (the staging
 *                                         integration's account_id, or any
 *                                         value when probing the orphan path).
 * @property {string} envelopeId           Unique per request (use VU/iter).
 * @property {string} [eventId]            Connect event id (replay-dedupe key).
 * @property {string} [generatedDateTime]  ISO timestamp; caller-supplied.
 * @property {number} [documentCount]      Number of envelope documents (>=1).
 * @property {string} [senderEmail]        Override sender; defaults to a
 *                                         non-PII @example.com address.
 * @property {boolean} [withNotary]        Include a notary recipient so the
 *                                         SCRUM-1872 notarization leg is exercised.
 */

const DEFAULT_SENDER_EMAIL = 'loadtest@example.com';
const DEFAULT_NOTARY_COMPLETED_AT = '2026-01-01T00:00:00.000Z';

/**
 * Build a synthetic `envelope-completed` Connect payload that the real
 * receiver accepts. Returns a plain object; serialize with
 * serializeConnectPayload() before signing/sending so the signed bytes and the
 * sent bytes are identical.
 * @param {SyntheticConnectOptions} opts
 * @returns {Record<string, unknown>}
 */
export function buildSyntheticConnectPayload(opts) {
  const documentCount = Math.max(1, opts.documentCount ?? 1);
  const envelopeDocuments = [];
  for (let i = 1; i <= documentCount; i++) {
    envelopeDocuments.push({
      documentId: String(i),
      name: `loadtest-document-${i}.pdf`,
    });
  }

  /** @type {Record<string, unknown>} */
  const payload = {
    event: 'envelope-completed',
    eventId: opts.eventId,
    envelopeId: opts.envelopeId,
    accountId: opts.accountId,
    status: 'completed',
    generatedDateTime: opts.generatedDateTime,
    sender: { email: opts.senderEmail ?? DEFAULT_SENDER_EMAIL },
    envelopeDocuments,
  };

  if (opts.withNotary) {
    payload.recipients = {
      notaries: [
        {
          name: 'Loadtest Notary',
          notaryCommissionState: 'CA',
          notaryCommissionNumber: 'LT-LOADTEST',
          completedDateTime: opts.generatedDateTime ?? DEFAULT_NOTARY_COMPLETED_AT,
        },
      ],
    };
  }

  return payload;
}

/**
 * Canonical serialization used for BOTH signing and sending. Single source so
 * the HMAC is computed over the exact bytes transmitted. (JSON.stringify drops
 * keys whose value is undefined, e.g. an absent eventId.)
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function serializeConnectPayload(payload) {
  return JSON.stringify(payload);
}
