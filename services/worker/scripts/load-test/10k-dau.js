/* global __ENV, __VU, __ITER */

// k6 10K-DAU profile — sustained 100 rps, 500 rps burst, 5 min total.
// SCRUM-1024 SCALE-02 acceptance test. Run against staging or prod-canary,
// never directly against prod outside a coordinated maintenance window.
//
// SCRUM-2094 [DS-VOL-01]: the DocuSign leg now fires REAL HMAC-signed Connect
// payloads (shared ./lib generator) when DOCUSIGN_HMAC_KEY is set, so the
// webhook intake path is genuinely exercised. Without a key the DocuSign share
// degrades to /health, so a default run never POSTs unsigned junk. (The old
// `{ event:'envelope-completed', loadtest:true }` body had no signature and no
// envelopeId/accountId, so the real receiver 401'd it — the middleware meant to
// drop loadtest-tagged bodies never shipped, so that 20% leg was silently
// blowing this script's own error-rate threshold.)
import { check, sleep } from 'k6';

import { pickScenario } from './lib/docusign-synth.js';
import { executeScenario } from './lib/k6-docusign.js';

const WORKER_URL = __ENV.WORKER_URL || 'http://localhost:3001';
const DOCUSIGN_HMAC_KEY = __ENV.DOCUSIGN_HMAC_KEY || '';
const DOCUSIGN_ACCOUNT_ID = __ENV.DOCUSIGN_ACCOUNT_ID || 'loadtest-account';

// SCALE-02 contract mix: 50% health/diagnostics, 30% verification, 20% webhook
// intake. (The dedicated docusign-volume.js profile uses the 15%
// production-observed DEFAULT_MIX instead.)
const MIX = { health: 0.5, verify: 0.3, docusign: 0.2 };

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 200,
      tags: { phase: 'sustained' },
    },
    burst: {
      executor: 'ramping-arrival-rate',
      startTime: '4m',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { target: 500, duration: '15s' }, // ramp to burst
        { target: 500, duration: '30s' }, // hold burst
        { target: 100, duration: '15s' }, // ramp back down
      ],
      tags: { phase: 'burst' },
    },
  },
  thresholds: {
    // SCALE-02 DoD: p99 < 500ms, zero 5xx (excluding intentional 503).
    http_req_duration: ['p(99)<500'],
    'checks{check:no 5xx (except intentional 503)}': ['rate>0.999'],
  },
};

export default function () {
  let scenario = pickScenario(Math.random(), MIX); // NOSONAR S2245: weighted load-distribution sampling in a k6 client script — not a security context
  // No signing key configured → do not fire unsigned webhook traffic; fall back
  // to /health so the run stays within its error-rate threshold.
  if (scenario === 'docusign' && !DOCUSIGN_HMAC_KEY) scenario = 'health';

  const res = executeScenario(scenario, {
    workerUrl: WORKER_URL,
    key: DOCUSIGN_HMAC_KEY,
    accountId: DOCUSIGN_ACCOUNT_ID,
    vu: __VU,
    iter: __ITER,
  });

  check(res, {
    'no 5xx (except intentional 503)': (r) =>
      r.status < 500 || (r.status === 503 && Boolean(r.headers['Retry-After'])),
  });
  sleep(0.05);
}
