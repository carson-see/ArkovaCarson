// k6 10K-DAU profile — sustained 100 rps, 500 rps burst, 5 min total.
// SCRUM-1024 SCALE-02 acceptance test. Run against staging or prod-canary,
// never directly against prod outside a coordinated maintenance window.
import http from 'k6/http';
import { check, sleep } from 'k6';

const WORKER_URL = __ENV.WORKER_URL || 'http://localhost:3001';

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
    'http_req_duration{intentional_503:no}': ['p(99)<500'],
    'http_req_failed{intentional_503:no}': ['rate<0.001'],
  },
};

// Traffic mix matches production observed ratio:
// 50% health/diagnostics, 30% verification, 20% webhook intake.
function pickRoute() {
  const r = Math.random();
  if (r < 0.5) return { method: 'GET', path: '/health', body: null };
  if (r < 0.8) {
    return {
      method: 'GET',
      path: '/api/v1/verify/anchor/00000000-0000-0000-0000-000000000000',
      body: null,
    };
  }
  return {
    method: 'POST',
    path: '/webhooks/docusign',
    // Loadtest-tagged body — middleware drops it before downstream side effects.
    body: JSON.stringify({ event: 'envelope-completed', loadtest: true }),
  };
}

export default function () {
  const route = pickRoute();
  const params = {
    headers: {
      'content-type': 'application/json',
      'x-arkova-loadtest': '1',
    },
    tags: { intentional_503: 'no' },
  };
  const res =
    route.method === 'GET'
      ? http.get(`${WORKER_URL}${route.path}`, params)
      : http.post(`${WORKER_URL}${route.path}`, route.body, params);
  check(res, {
    'no 5xx (except intentional 503)': (r) =>
      r.status < 500 || (r.status === 503 && r.headers['Retry-After']),
  });
  sleep(0.05);
}
