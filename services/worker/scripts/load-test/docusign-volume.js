/* global __ENV, __VU, __ITER */

// k6 DocuSign Connect volume profile — SCRUM-2094 [DS-VOL-01] / verify subtask
// SCRUM-2104. Sustained 100 rps for 30 min at the 15% production-observed
// DocuSign mix, firing REAL HMAC-signed Connect payloads through the webhook
// intake path (parse → multi-key HMAC verify → integration lookup → nonce
// dedupe → enqueue).
//
// SLO (SCRUM-2094 DoD): DocuSign-leg p99 < 300ms, error rate < 0.1%, zero
// dropped envelopes.
//
// RUN ONLY against an isolated staging rig (CLAUDE.md §1.11/§1.11A) with a
// seeded DocuSign integration whose account_id + Connect HMAC key match the
// envs below. NEVER against prod, and never against shared staging mid-soak.
// Required envs: WORKER_URL, DOCUSIGN_HMAC_KEY, DOCUSIGN_ACCOUNT_ID.
// Optional: DOCUSIGN_NOTARY_RATE (0..1) to exercise the SCRUM-1872 notary leg.
import { check, sleep } from 'k6';

import { DEFAULT_MIX, pickScenario } from './lib/docusign-synth.js';
import { executeScenario } from './lib/k6-docusign.js';

const K6_ENV = typeof __ENV === 'undefined' ? {} : __ENV;
const WORKER_URL = K6_ENV.WORKER_URL || 'http://localhost:3001';
const DOCUSIGN_HMAC_KEY = K6_ENV.DOCUSIGN_HMAC_KEY || '';
const DOCUSIGN_ACCOUNT_ID = K6_ENV.DOCUSIGN_ACCOUNT_ID || 'loadtest-account';

export function parseNotaryRate(raw = K6_ENV.DOCUSIGN_NOTARY_RATE) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 0;

  const rate = Number(String(raw).trim());
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error('DOCUSIGN_NOTARY_RATE must be a finite number in [0,1].');
  }
  return rate;
}

const NOTARY_RATE = parseNotaryRate();

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '30m',
      preAllocatedVUs: 50,
      maxVUs: 200,
      tags: { phase: 'sustained' },
    },
  },
  thresholds: {
    // Overall guard + a DocuSign-isolated guard so the webhook path is measured
    // on its own (the scenario:docusign tag), not blended with health/verify.
    'http_req_duration{intentional_503:no}': ['p(99)<300'],
    'http_req_failed{intentional_503:no}': ['rate<0.001'],
    'http_req_duration{scenario:docusign}': ['p(99)<300'],
    'http_req_failed{scenario:docusign}': ['rate<0.001'],
  },
};

// Fail fast: this profile exists to exercise the signed DocuSign path. Running
// it without a key would silently degrade every envelope to /health and produce
// meaningless "passing" evidence.
export function setup() {
  if (!DOCUSIGN_HMAC_KEY) {
    throw new Error(
      'docusign-volume.js requires DOCUSIGN_HMAC_KEY (and a staging integration ' +
        'seeded with DOCUSIGN_ACCOUNT_ID). Refusing to run a degraded profile.',
    );
  }
}

export default function () {
  const scenario = pickScenario(Math.random(), DEFAULT_MIX); // NOSONAR S2245: weighted load-distribution sampling in a k6 client script — not a security context
  const withNotary = scenario === 'docusign' && NOTARY_RATE > 0 && Math.random() < NOTARY_RATE; // NOSONAR S2245: notary sampling fraction — not a security context

  const res = executeScenario(scenario, {
    workerUrl: WORKER_URL,
    key: DOCUSIGN_HMAC_KEY,
    accountId: DOCUSIGN_ACCOUNT_ID,
    vu: typeof __VU === 'undefined' ? 0 : __VU,
    iter: typeof __ITER === 'undefined' ? 0 : __ITER,
    withNotary,
  });

  check(res, {
    'no 5xx (except intentional 503)': (r) =>
      r.status < 500 || (r.status === 503 && Boolean(r.headers['Retry-After'])),
  });
  sleep(0.05);
}
