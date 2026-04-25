// k6 baseline profile — current production traffic mix (~5 rps).
// SCRUM-1024 SCALE-02. Run before the 10k-dau profile to establish a baseline.
import http from 'k6/http';
import { check, sleep } from 'k6';

const WORKER_URL = __ENV.WORKER_URL || 'http://localhost:3001';

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    // p99 < 500ms is the SCALE-02 DoD threshold.
    'http_req_duration{intentional_503:no}': ['p(99)<500'],
    'http_req_failed{intentional_503:no}': ['rate<0.001'],
  },
};

export default function () {
  const params = {
    headers: {
      'content-type': 'application/json',
      'x-arkova-loadtest': '1',
    },
    tags: { intentional_503: 'no' },
  };
  const res = http.get(`${WORKER_URL}/health`, params);
  check(res, {
    'health 200': (r) => r.status === 200,
  });
  sleep(0.2);
}
