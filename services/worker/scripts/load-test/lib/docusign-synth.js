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

// =============================================================================
// docusign-bilateral-2026-08 (CTO Decision Record, R9) — soak harness for the
// 4-PR bilateral feature: outbound signer capture (PR #2474, R6/R7), inbound
// Recipient-Connect classification (PR #2476, R3/R4/R5/F1), the metadata
// write-authority guard (PR #2472), and the tenant-scoped nonce (migration
// 0424, part of PR #2476). ALL FOUR PRs are OPEN, UNMERGED at the time this
// harness was written (verified via `gh pr view` — see agents.md). The wire
// shapes below are transcribed from `gh pr diff 2474` / `gh pr diff 2476`,
// NOT from importable receiver code (most of it does not exist on `main`
// yet) — see docusign-bilateral-synth.test.ts for exactly which pieces are
// cross-validated against real, already-merged parsers today vs. pinned as a
// documented contract against the PR diffs pending merge.
//
// Still NO crypto, NO clock, NO RNG in this file — same rule as above. Every
// builder below takes ids/timestamps from the caller. `buildBilateralRequest`
// additionally takes NO random draw itself; the caller (k6 glue or a test)
// draws `rand` and calls `pickBilateralFamily` separately, exactly mirroring
// the existing `pickScenario` / `executeScenario` split.

/** Mirrors PR #2474's `MAX_CAPTURED_DOCUSIGN_SIGNERS` (integrations/connectors/schemas.ts). */
export const MAX_CAPTURED_SIGNERS = 20;

/**
 * Deterministic GUID-shaped id from an integer seed — no crypto, no
 * Math.random(). Matches `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`,
 * the GUID_PATTERN PR #2474 pins `recipient_id_guid`/`user_id` to. `block` is
 * a single hex character that segments the id-space by caller/purpose (e.g.
 * 'a' for signer recipient ids, 'b' for signer user ids) so two callers
 * seeding from 0 never collide. MUST be a valid hex digit (0-9a-f) — an
 * invalid `block` silently falls back to 'a' (same guard `syntheticSha256`
 * uses for `tag`), so choose tags from that same 16-character alphabet.
 * Mirrors the `testGuid(n)` fixture helper the real PR's own test suites use
 * (decimal digits of `n` are always valid hex).
 * @param {number} seed
 * @param {string} [block]
 * @returns {string}
 */
export function syntheticGuid(seed, block = 'a') {
  const b = /^[0-9a-f]$/i.test(block) ? block.toLowerCase() : 'a';
  const suffix = String(Math.abs(Math.trunc(seed))).padStart(12, '0').slice(-12);
  return `${b.repeat(8)}-${b.repeat(4)}-4${b.repeat(3)}-8${b.repeat(3)}-${suffix}`;
}

/**
 * Deterministic 64-char lowercase-hex "declared" SHA-256 from an integer
 * seed — NOT a real hash of anything (there is no real document). `tag` is a
 * single hex character segmenting the id-space by purpose: 'd' for
 * legitimate outbound document hashes, 'c' for legitimate declared-inbound
 * hashes, 'f' for attacker-chosen forged hashes (self-forgery families).
 * MUST be a valid hex digit (0-9a-f) — an invalid `tag` silently falls back
 * to 'd', which would defeat the whole point of a visually/structurally
 * distinct pool per family; this is exactly the kind of drift the
 * cross-validation test below pins against.
 * @param {number} seed
 * @param {string} [tag]
 * @returns {string}
 */
export function syntheticSha256(seed, tag = 'd') {
  const t = /^[0-9a-f]$/i.test(tag) ? tag.toLowerCase() : 'd';
  const n = Math.abs(Math.trunc(seed)).toString(16).padStart(8, '0').slice(-8);
  return `${t.repeat(56)}${n}`;
}

const DEFAULT_SIGNED_DATE_TIME = '2026-08-20T10:00:00.000Z';

/**
 * Build a signer list for `envelopeSummary.recipients.signers[]`. Even
 * indices get a `userId` (platform-account signer); odd indices omit it
 * (pure email-link signer) — exercises both branches of PR #2474's
 * `extractSigners` (the `user_id` field is optional-absent-when-falsy).
 * @param {number} count
 * @param {{ signedDateTime?: string }} [opts]
 * @returns {Array<Record<string, unknown>>}
 */
export function buildSignerList(count, opts = {}) {
  const n = Math.max(0, Math.trunc(count));
  const signedDateTime = opts.signedDateTime ?? DEFAULT_SIGNED_DATE_TIME;
  const signers = [];
  for (let i = 0; i < n; i++) {
    /** @type {Record<string, unknown>} */
    const signer = {
      recipientIdGuid: syntheticGuid(i, 'a'),
      status: 'completed',
      signedDateTime,
    };
    if (i % 2 === 0) signer.userId = syntheticGuid(i + 100000, 'b');
    signers.push(signer);
  }
  return signers;
}

/**
 * Build an `envelopeDocuments[]` list. `withHashes=false` produces documents
 * with NO `sha256` at all (the "declared hash absent" edge case).
 * @param {number} count
 * @param {{ withHashes?: boolean }} [opts]
 * @returns {Array<Record<string, unknown>>}
 */
function buildEnvelopeDocumentList(count, opts = {}) {
  const n = Math.max(1, Math.trunc(count));
  const withHashes = opts.withHashes !== false;
  const docs = [];
  for (let i = 1; i <= n; i++) {
    /** @type {Record<string, unknown>} */
    const doc = { documentId: String(i), name: `loadtest-document-${i}.pdf` };
    if (withHashes) doc.sha256 = syntheticSha256(i, 'd');
    docs.push(doc);
  }
  return docs;
}

/**
 * @typedef {Object} BilateralEnvelopeOptions
 * @property {string} accountId           Top-level `accountId` — the account
 *                                        whose Connect config delivers this
 *                                        webhook (resolves the integration +
 *                                        HMAC key). See PR #2476's doc
 *                                        comment on `DocusignEnvelopeCompleted.accountId`.
 * @property {string} envelopeId
 * @property {string} [eventId]
 * @property {string} [generatedDateTime]
 * @property {number} [documentCount]
 * @property {number} [signerCount]       0 (default) omits `envelopeSummary`
 *                                        entirely — matches PR #2474's "never
 *                                        an empty array" backward-compat rule.
 * @property {boolean} [withDocumentHashes]
 * @property {string} [senderEmail]
 */

/**
 * Build an OUTBOUND `envelope-completed` payload, optionally carrying
 * `envelopeSummary.recipients.signers[]` (PR #2474, R6). This is the shape
 * `classifyDirection` (PR #2476) resolves as outbound whenever no distinct
 * `sender.accountId` is present — i.e. every payload shape that predates
 * both PRs, unchanged.
 * @param {BilateralEnvelopeOptions} opts
 * @returns {Record<string, unknown>}
 */
export function buildOutboundSignersPayload(opts) {
  const documentCount = Math.max(1, opts.documentCount ?? 1);
  const signerCount = Math.max(0, opts.signerCount ?? 0);
  const envelopeDocuments = buildEnvelopeDocumentList(documentCount, {
    withHashes: opts.withDocumentHashes !== false,
  });
  const signers = buildSignerList(signerCount, { signedDateTime: opts.generatedDateTime });

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
  // Never an empty array (PR #2474: "absent, not merely falsy" — mirrors the
  // real webhook's own convention so a 0-signer generation round-trips
  // identically to a payload that never mentioned recipients at all).
  if (signers.length > 0) {
    payload.envelopeSummary = { recipients: { signers } };
  }
  return payload;
}

/**
 * @typedef {Object} InboundConnectOptions
 * @property {string} accountId           The RECEIVING org's own connected
 *                                        account — resolves the integration
 *                                        + HMAC key (same field as outbound).
 * @property {string} senderAccountId     The envelope's declared owning
 *                                        account (`sender.accountId`) — for a
 *                                        LEGITIMATE inbound delivery this is a
 *                                        real foreign org's connected
 *                                        account; for a SELF-FORGERY delivery
 *                                        this is attacker-chosen and need not
 *                                        correspond to anything real. The
 *                                        wire shape is IDENTICAL either way —
 *                                        that identity IS the F1 threat model
 *                                        (see buildBilateralRequest below).
 * @property {string} envelopeId
 * @property {string} [eventId]
 * @property {string} [generatedDateTime]
 * @property {string} [declaredSha256]    Single declared per-document hash.
 *                                        Omit (or pass `hashCount`) for the
 *                                        "no usable declared hash" variant.
 * @property {number} [hashCount]         0, or >=2 distinct hashes, to
 *                                        exercise `extractSingleDeclaredHash`'s
 *                                        orphan-drop (requires EXACTLY one).
 * @property {string} [senderEmail]
 */

/**
 * Build an INBOUND-shaped (Recipient Connect) `envelope-completed` payload —
 * `sender.accountId` distinct from the top-level `accountId`. Used for BOTH
 * the legitimate inbound family AND the self-forgery adversarial family; see
 * the field doc above for why the shapes cannot and must not differ (PR
 * #2476's whole point is that `classifyDirection` cannot trust the body, only
 * server-stored state).
 * @param {InboundConnectOptions} opts
 * @returns {Record<string, unknown>}
 */
export function buildInboundConnectPayload(opts) {
  // Explicit `hashCount` always wins; otherwise exactly one hash (the normal,
  // usable-declared-hash case) unless the caller wants zero.
  const hashCount = opts.hashCount ?? 1;
  let envelopeDocuments;
  if (hashCount === 0) {
    envelopeDocuments = [{ documentId: 'combined', name: 'inbound-loadtest-document.pdf' }];
  } else if (hashCount === 1) {
    envelopeDocuments = [
      {
        documentId: 'combined',
        name: 'inbound-loadtest-document.pdf',
        sha256: opts.declaredSha256 ?? syntheticSha256(1, 'c'),
      },
    ];
  } else {
    envelopeDocuments = Array.from({ length: hashCount }, (_, i) => ({
      documentId: String(i + 1),
      name: `inbound-loadtest-document-${i + 1}.pdf`,
      sha256: syntheticSha256(i + 1, 'c'),
    }));
  }

  return {
    event: 'envelope-completed',
    eventId: opts.eventId,
    envelopeId: opts.envelopeId,
    accountId: opts.accountId,
    status: 'completed',
    generatedDateTime: opts.generatedDateTime,
    sender: {
      email: opts.senderEmail ?? DEFAULT_SENDER_EMAIL,
      accountId: opts.senderAccountId,
    },
    envelopeDocuments,
  };
}

/**
 * Build a malformed/adversarial-shaped payload as an ALREADY-SERIALIZED
 * string (some kinds are intentionally not valid JSON, or use a type the
 * generator's normal object builders never produce).
 *
 * Expected receiver behavior per `services/worker/src/api/v1/webhooks/docusign.ts`
 * (verified by reading the CURRENT, already-merged handler — see
 * docusign-bilateral-synth.test.ts):
 *   - 'not_json' / 'missing_envelope_id': `parseDocusignConnectPayload` throws
 *     -> the handler returns 401 `invalid_signature`, the SAME code as a bad
 *     HMAC signature. Deliberate anti-oracle design (P0 review finding
 *     2026-05-28, see the handler's own comment) — an attacker must not be
 *     able to distinguish "malformed body" from "wrong key" by status code.
 *   - 'non_array_signers': does NOT reach `parseDocusignConnectPayload` at
 *     all — PR #2474's `extractSigners` re-parses the raw body independently
 *     and wraps the whole function body in try/catch, so a non-array
 *     `signers` value degrades gracefully to zero captured signers (200/202
 *     as normal), never a crash. This variant proves resilience, not
 *     rejection.
 *   - 'oversized': rejected by the ingress body-size limit
 *     (`express.raw({ type:'application/json', limit:'1mb' })`,
 *     `services/worker/src/index.ts`) BEFORE any docusign.ts code runs -> 413.
 * @param {'not_json'|'missing_envelope_id'|'non_array_signers'|'oversized'} kind
 * @param {{ accountId?: string, envelopeId?: string, eventId?: string, generatedDateTime?: string, targetBytes?: number }} [opts]
 * @returns {string}
 */
export function buildMalformedPayload(kind, opts = {}) {
  const base = () =>
    buildOutboundSignersPayload({
      accountId: opts.accountId ?? 'loadtest-malformed-account',
      envelopeId: opts.envelopeId ?? `loadtest-malformed-${kind}`,
      eventId: opts.eventId,
      generatedDateTime: opts.generatedDateTime,
      documentCount: 1,
      signerCount: 0,
    });

  switch (kind) {
    case 'not_json':
      return 'this is not valid JSON for the DocuSign Connect payload {{{';
    case 'missing_envelope_id': {
      const payload = base();
      delete payload.envelopeId;
      return JSON.stringify(payload);
    }
    case 'non_array_signers': {
      const payload = base();
      // A plain object (not an array, not iterable) — extractSigners' outer
      // try/catch turns the resulting TypeError into a graceful `[]`.
      payload.envelopeSummary = { recipients: { signers: { not: 'an-array' } } };
      return JSON.stringify(payload);
    }
    case 'oversized': {
      const targetBytes = opts.targetBytes ?? 1_100_000; // > the worker's 1mb ingress limit
      const payload = base();
      const currentLength = JSON.stringify(payload).length;
      const paddingNeeded = Math.max(0, targetBytes - currentLength - 24);
      // Outside the validated schema shape entirely — RawConnectPayload is
      // `.passthrough()`, so this key would ordinarily just ride along
      // unused; the point here is bytes-on-the-wire, not valid content, and
      // the body-size limit fires before any parsing happens regardless.
      payload._loadtest_padding = 'x'.repeat(paddingNeeded);
      return JSON.stringify(payload);
    }
    default:
      throw new Error(`buildMalformedPayload: unknown kind "${kind}"`);
  }
}

/**
 * Mix shares for the DocuSign-bilateral soak, i.e. the composition of
 * traffic ONCE a request has already been routed to the DocuSign leg (see
 * `DEFAULT_MIX`/`pickScenario` above for the outer health/verify/docusign
 * split — this table governs a second, inner draw). Sums to 1. Each family
 * is documented at its `buildBilateralRequest` case below.
 * @type {Record<string, number>}
 */
export const BILATERAL_MIX = {
  outbound_no_signers: 0.30,
  outbound_with_signers: 0.20,
  outbound_max_cardinality: 0.02,
  inbound_declared_hash: 0.13,
  inbound_no_usable_hash: 0.02,
  self_send_collision: 0.03,
  unknown_account_orphan: 0.05,
  replay: 0.05,
  wrong_hmac: 0.05,
  self_forgery: 0.05,
  self_forgery_provenance_conflict: 0.02,
  malformed_non_array_signers: 0.02,
  malformed_missing_envelope_id: 0.02,
  malformed_not_json: 0.02,
  malformed_oversized: 0.02,
};

/**
 * Weighted family selection over `BILATERAL_MIX`, same cumulative-range
 * contract as `pickScenario` above (`rand` in [0,1) supplied by the caller).
 * @param {number} rand
 * @param {Record<string, number>} [mix]
 * @returns {string}
 */
export function pickBilateralFamily(rand, mix = BILATERAL_MIX) {
  let acc = 0;
  const entries = Object.entries(mix);
  for (const [name, share] of entries) {
    acc += share;
    if (rand < acc) return name;
  }
  return entries[entries.length - 1][0]; // floating-point fallback
}

/**
 * @typedef {Object} BilateralStep
 * @property {string} label              Tag for k6/logging, e.g. "outbound_no_signers".
 * @property {Record<string, unknown>|string} payload  Object to serialize, or
 *   an already-serialized string (malformed 'not_json'/'oversized' kinds).
 * @property {'org'|'wrong'|'shared'} signAs
 *   'org'    — sign with the calling org's OWN real key. Used for every
 *              legitimate family AND both self-forgery families — the
 *              attacker in the F1 threat model is a real, legitimately
 *              connected org signing with its own valid key; that's what
 *              makes it a real vulnerability rather than an HMAC bypass.
 *   'wrong'  — sign with a key that is NOT the resolving account's key.
 *              Exercises the 401 invalid_signature path.
 *   'shared' — sign with the rig-wide env-var fallback key. Exercises the
 *              unknown-integration orphan path (`resolveHmacKeys` falls back
 *              to `DOCUSIGN_CONNECT_HMAC_SECRET` for an account with no
 *              per-org `hmac_keys`).
 * @property {boolean} [customrecipient] Append `?customrecipient=true`.
 * @property {number} [delayMs]          Delay (ms) before firing this step,
 *                                        relative to the previous step in the
 *                                        same request.
 * @property {number[]} [expectStatus]   HTTP statuses considered a pass for
 *                                        this step (soft check only).
 */

/**
 * @typedef {Object} BilateralContext
 * @property {number} vu
 * @property {number} iter
 * @property {string} generatedDateTime   Caller-supplied ISO timestamp — this
 *                                        module has no clock.
 * @property {string} ownAccountId        The calling org's own connected
 *                                        DocuSign account_id.
 * @property {string} foreignAccountId    A DIFFERENT org's connected account
 *                                        (ideally the OTHER synthetic org, so
 *                                        `inbound_declared_hash` exercises a
 *                                        true cross-org path when both orgs
 *                                        are seeded on the rig).
 * @property {string} orphanAccountId     An accountId that matches NO seeded
 *                                        integration on the rig.
 */

/**
 * Top-level dispatcher: given a family name (from `pickBilateralFamily`) and
 * a context, return the ordered `BilateralStep[]` a driver must fire. Most
 * families are a single step; `replay` and `self_forgery_provenance_conflict`
 * return two paired steps.
 * @param {string} family
 * @param {BilateralContext} ctx
 * @returns {BilateralStep[]}
 */
export function buildBilateralRequest(family, ctx) {
  const idBase = `loadtest-bilateral-${family}-${ctx.vu}-${ctx.iter}`;
  const gdt = ctx.generatedDateTime;

  switch (family) {
    case 'outbound_no_signers':
      return [
        {
          label: family,
          payload: buildOutboundSignersPayload({
            accountId: ctx.ownAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            documentCount: 1,
            signerCount: 0,
          }),
          signAs: 'org',
          expectStatus: [202],
        },
      ];

    case 'outbound_with_signers': {
      // Rotate through the R6 signer-count boundaries: 1, the 20-entry cap,
      // and 25 (server-side truncated to 20) — see connector-artifact-drain
      // evidence for the truncation assertion.
      const signerCount = [1, 20, 25][Math.abs(ctx.iter) % 3];
      return [
        {
          label: `${family}[${signerCount}]`,
          payload: buildOutboundSignersPayload({
            accountId: ctx.ownAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            documentCount: 2,
            signerCount,
          }),
          signAs: 'org',
          expectStatus: [202],
        },
      ];
    }

    case 'outbound_max_cardinality':
      // 100 envelopeDocuments (the schema cap) + 20 signers (the R6 cap) —
      // the 16KB organization_rule_events.payload boundary (Finding 7/R6).
      return [
        {
          label: family,
          payload: buildOutboundSignersPayload({
            accountId: ctx.ownAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            documentCount: 100,
            signerCount: 20,
          }),
          signAs: 'org',
          expectStatus: [202],
        },
      ];

    case 'inbound_declared_hash':
      return [
        {
          label: family,
          payload: buildInboundConnectPayload({
            accountId: ctx.ownAccountId,
            senderAccountId: ctx.foreignAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            declaredSha256: syntheticSha256(ctx.iter, 'c'),
          }),
          signAs: 'org',
          customrecipient: true,
          // 200 when ENABLE_DOCUSIGN_INBOUND is off (ack, no nonce/write) or
          // 202 when it's on and the artifact enqueues — the rig's flag
          // state decides which, both are a pass at the HTTP layer.
          expectStatus: [200, 202],
        },
      ];

    case 'inbound_no_usable_hash':
      return [
        {
          label: family,
          payload: buildInboundConnectPayload({
            accountId: ctx.ownAccountId,
            senderAccountId: ctx.foreignAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            hashCount: Math.abs(ctx.iter) % 2 === 0 ? 0 : 2,
          }),
          signAs: 'org',
          customrecipient: true,
          expectStatus: [200],
        },
      ];

    case 'self_send_collision':
      // Own-account both ways (no distinct senderAccountId) but the
      // customrecipient marker is present anyway — R4: the marker alone can
      // never upgrade trust. Must classify OUTBOUND (never the inbound
      // ack/skip shape).
      return [
        {
          label: family,
          payload: buildOutboundSignersPayload({
            accountId: ctx.ownAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            documentCount: 1,
            signerCount: 1,
          }),
          signAs: 'org',
          customrecipient: true,
          expectStatus: [202],
        },
      ];

    case 'unknown_account_orphan':
      return [
        {
          label: family,
          payload: buildOutboundSignersPayload({
            accountId: ctx.orphanAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            documentCount: 1,
            signerCount: 0,
          }),
          signAs: 'shared',
          expectStatus: [200],
        },
      ];

    case 'replay': {
      const step = {
        label: family,
        payload: buildOutboundSignersPayload({
          accountId: ctx.ownAccountId,
          envelopeId: idBase,
          eventId: `${idBase}-evt`,
          generatedDateTime: gdt,
          documentCount: 1,
          signerCount: 0,
        }),
        signAs: 'org',
        expectStatus: [202],
      };
      // Same exact body both times — the second is the actual replay probe.
      return [
        step,
        { ...step, label: `${family}_duplicate`, expectStatus: [200] },
      ];
    }

    case 'wrong_hmac':
      return [
        {
          label: family,
          payload: buildOutboundSignersPayload({
            accountId: ctx.ownAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            documentCount: 1,
            signerCount: 0,
          }),
          signAs: 'wrong',
          expectStatus: [401],
        },
      ];

    case 'self_forgery':
      return [
        {
          label: family,
          payload: buildInboundConnectPayload({
            accountId: ctx.ownAccountId,
            senderAccountId: `loadtest-forged-foreign-${ctx.vu}-${ctx.iter}`,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
            declaredSha256: syntheticSha256(ctx.iter, 'f'), // 'f' tag: attacker-chosen, never the 'd'/'c' legitimate tags
          }),
          signAs: 'org', // self-signed with the attacker's OWN real key — the whole point
          customrecipient: true,
          expectStatus: [200, 202],
        },
      ];

    case 'self_forgery_provenance_conflict': {
      const sharedEnvelopeId = `${idBase}-collide`;
      return [
        {
          // Step 1: a REAL outbound envelope — triggers the async
          // fetch+enqueue job server-side (job_queue -> connector-artifact
          // RPC), which is what the forged write below races against.
          label: `${family}_real_outbound`,
          payload: buildOutboundSignersPayload({
            accountId: ctx.ownAccountId,
            envelopeId: sharedEnvelopeId,
            eventId: `${sharedEnvelopeId}-out-evt`,
            generatedDateTime: gdt,
            documentCount: 1,
            signerCount: 2,
          }),
          signAs: 'org',
          expectStatus: [202],
        },
        {
          // Step 2: the forged inbound for the SAME envelopeId, fired
          // shortly after. Whether this actually wins the race against the
          // outbound job's async fetch is nondeterministic (real wall-clock
          // job-queue timing) — that's WHY this family must run continuously
          // across the full soak: over many iterations, some collisions land
          // on either side, and the evidence query checks that EVERY
          // outcome is either a clean outbound win or a logged, loud F1
          // provenance-conflict — never a silently-accepted forged fingerprint.
          label: `${family}_forged_inbound`,
          payload: buildInboundConnectPayload({
            accountId: ctx.ownAccountId,
            senderAccountId: `loadtest-forged-foreign-${ctx.vu}-${ctx.iter}`,
            envelopeId: sharedEnvelopeId,
            eventId: `${sharedEnvelopeId}-in-evt`,
            generatedDateTime: gdt,
            declaredSha256: syntheticSha256(ctx.iter, 'f'),
          }),
          signAs: 'org',
          customrecipient: true,
          delayMs: 150,
          expectStatus: [200, 202],
        },
      ];
    }

    case 'malformed_non_array_signers':
      return [
        {
          label: family,
          payload: buildMalformedPayload('non_array_signers', {
            accountId: ctx.ownAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
          }),
          signAs: 'org',
          expectStatus: [202],
        },
      ];

    case 'malformed_missing_envelope_id':
      return [
        {
          label: family,
          payload: buildMalformedPayload('missing_envelope_id', {
            accountId: ctx.ownAccountId,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
          }),
          signAs: 'org',
          // 401, not 400 — anti-oracle design, see buildMalformedPayload's doc comment.
          expectStatus: [401],
        },
      ];

    case 'malformed_not_json':
      return [
        {
          label: family,
          payload: buildMalformedPayload('not_json'),
          signAs: 'org',
          expectStatus: [401],
        },
      ];

    case 'malformed_oversized':
      return [
        {
          label: family,
          payload: buildMalformedPayload('oversized', {
            accountId: ctx.ownAccountId,
            envelopeId: idBase,
            eventId: `${idBase}-evt`,
            generatedDateTime: gdt,
          }),
          signAs: 'org',
          expectStatus: [413],
        },
      ];

    default:
      throw new Error(`buildBilateralRequest: unknown family "${family}"`);
  }
}
