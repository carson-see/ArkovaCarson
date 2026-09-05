/* global __ENV, __VU, __ITER */

// k6 DocuSign BILATERAL soak driver — CTO Decision Record R9 (docusign-bilateral-2026-08).
//
// Drives a realistic + adversarial mix of DocuSign Connect deliveries against
// an isolated staging rig running ALL FOUR bilateral PRs (#2472 metadata
// write-authority guard, #2474 outbound signer capture, #2476 inbound
// Recipient-Connect classification, migration 0424 tenant-scoped nonce). Every
// event is HMAC-signed exactly the way the real receiver verifies it
// (`verifyDocusignConnectHmacMultiKey` / `resolveHmacKeys`'s per-account
// `hmac_keys` -> env-var-fallback chain) — see lib/docusign-synth.js and
// lib/k6-docusign.js for the payload/signing contract, and
// lib/docusign-bilateral-synth.test.ts for the cross-validation against the
// real receiver's parsers.
//
// Designed for a CONTINUOUS run across the full T3 soak window (48h+, per
// CLAUDE.md §1.12) at a modest steady RPS — this is a correctness/security
// mix, not a throughput profile (see docusign-volume.js for the dedicated
// throughput/SLO profile). The adversarial families (self-forgery, wrong-HMAC,
// replay, malformed) are EXPECTED to return non-2xx / non-202 statuses; that
// is the point (see `expectStatus` on each BilateralStep) — this profile does
// NOT threshold on a blanket "zero errors", it thresholds on "every response
// matched what the family's own security contract predicts."
//
// RUN ONLY against an isolated staging rig (CLAUDE.md §1.11/§1.11A) seeded
// with TWO DocuSign integrations (org A + org B), each with its OWN
// `hmac_keys` entry matching the envs below — this is what lets
// `inbound_declared_hash` exercise a TRUE cross-org path (org B's envelope,
// delivered to org A's Recipient-Connect listener) and lets the companion
// evidence query (docusign-bilateral-evidence.sql) assert per-org isolation.
// NEVER against prod, and never against shared staging mid-soak.
//
// Required envs:
//   WORKER_URL, DOCUSIGN_ORG_A_ACCOUNT_ID, DOCUSIGN_ORG_A_HMAC_KEY,
//   DOCUSIGN_ORG_B_ACCOUNT_ID, DOCUSIGN_ORG_B_HMAC_KEY, DOCUSIGN_HMAC_KEY
//   (the shared/env-var-fallback key — used ONLY for the unknown_account_orphan
//   family, matching the real receiver's per-org-key-else-env-var resolution
//   order; must NOT equal either org's real key or the orphan path silently
//   stops being an orphan path).
// Optional envs:
//   DOCUSIGN_SOAK_RPS (default 2), DOCUSIGN_SOAK_DURATION (default '30m' —
//   set to '48h' for the real T3 soak), DOCUSIGN_SOAK_PREALLOCATED_VUS
//   (default 10), DOCUSIGN_SOAK_MAX_VUS (default 50).
import { check, sleep } from 'k6';

import { BILATERAL_MIX, pickBilateralFamily } from './lib/docusign-synth.js';
import { executeBilateralRequest } from './lib/k6-docusign.js';

const K6_ENV = typeof __ENV === 'undefined' ? {} : __ENV;
const WORKER_URL = K6_ENV.WORKER_URL || 'http://localhost:3001';

const ORG_A = {
  accountId: K6_ENV.DOCUSIGN_ORG_A_ACCOUNT_ID || '',
  key: K6_ENV.DOCUSIGN_ORG_A_HMAC_KEY || '',
};
const ORG_B = {
  accountId: K6_ENV.DOCUSIGN_ORG_B_ACCOUNT_ID || '',
  key: K6_ENV.DOCUSIGN_ORG_B_HMAC_KEY || '',
};
const SHARED_KEY = K6_ENV.DOCUSIGN_HMAC_KEY || '';

function parsePositiveNumber(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const RPS = parsePositiveNumber(K6_ENV.DOCUSIGN_SOAK_RPS, 2);
const DURATION = K6_ENV.DOCUSIGN_SOAK_DURATION || '30m';
const PREALLOCATED_VUS = parsePositiveNumber(K6_ENV.DOCUSIGN_SOAK_PREALLOCATED_VUS, 10);
const MAX_VUS = parsePositiveNumber(K6_ENV.DOCUSIGN_SOAK_MAX_VUS, 50);

export const options = {
  scenarios: {
    bilateral: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PREALLOCATED_VUS,
      maxVUs: MAX_VUS,
      tags: { phase: 'bilateral' },
    },
  },
  thresholds: {
    // The security contract, not a happy-path contract: every step's
    // response must match ITS OWN family's documented expectStatus (401 for
    // wrong_hmac, 413 for oversized, 200/202 for everything legitimate, ...).
    // A failure here means the receiver's behavior DRIFTED from the CTO
    // Decision Record's documented contract, which is exactly what a T3 soak
    // exists to catch.
    'checks{check:response matches family expectStatus}': ['rate>0.999'],
  },
};

// Fail fast: this profile exists to exercise the bilateral feature's signed
// paths on BOTH synthetic orgs. Running without real per-org keys would
// silently degrade every request into a 401, producing meaningless "the
// soak ran" evidence with zero actual coverage.
export function setup() {
  const missing = [];
  if (!ORG_A.accountId) missing.push('DOCUSIGN_ORG_A_ACCOUNT_ID');
  if (!ORG_A.key) missing.push('DOCUSIGN_ORG_A_HMAC_KEY');
  if (!ORG_B.accountId) missing.push('DOCUSIGN_ORG_B_ACCOUNT_ID');
  if (!ORG_B.key) missing.push('DOCUSIGN_ORG_B_HMAC_KEY');
  if (!SHARED_KEY) missing.push('DOCUSIGN_HMAC_KEY');
  if (missing.length > 0) {
    throw new Error(
      `docusign-bilateral-soak.js requires ${missing.join(', ')} (two seeded staging ` +
        'DocuSign integrations, org A + org B, each with its own hmac_keys entry, plus ' +
        'the env-var fallback key for the orphan-account family). Refusing to run a degraded profile.',
    );
  }
  if (ORG_A.accountId === ORG_B.accountId) {
    throw new Error('DOCUSIGN_ORG_A_ACCOUNT_ID and DOCUSIGN_ORG_B_ACCOUNT_ID must be distinct accounts.');
  }
}

export default function () {
  const vu = typeof __VU === 'undefined' ? 0 : __VU;
  const iter = typeof __ITER === 'undefined' ? 0 : __ITER;

  const family = pickBilateralFamily(Math.random(), BILATERAL_MIX); // NOSONAR S2245: weighted load-distribution sampling in a k6 client script — not a security context

  // Alternate which synthetic org is "own" per VU so both orgs generate
  // traffic across every family — required for the evidence query's
  // per-org-isolation assertion to have something to assert about.
  const useA = vu % 2 === 0;
  const own = useA ? ORG_A : ORG_B;
  const foreign = useA ? ORG_B : ORG_A;

  const results = executeBilateralRequest(family, {
    vu,
    iter,
    generatedDateTime: new Date().toISOString(),
    ownAccountId: own.accountId,
    foreignAccountId: foreign.accountId,
    orphanAccountId: `loadtest-orphan-${vu}-${iter}-${Date.now()}`,
    workerUrl: WORKER_URL,
    orgKey: own.key,
    sharedKey: SHARED_KEY,
  });

  for (const { step, res } of results) {
    check(
      res,
      {
        'response matches family expectStatus': (r) =>
          !step.expectStatus || step.expectStatus.includes(r.status),
      },
      { family: step.label },
    );
  }

  sleep(0.05);
}
