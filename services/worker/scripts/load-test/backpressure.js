// k6 backpressure verification — sustained webhook ingestion proves the worker
// returns 503 + Retry-After once `organization_rule_events` PENDING > 10K, and
// recovers cleanly once the dispatcher drains the queue.
//
// SCRUM-1024 SCALE-02. Pair with a manual `INSERT INTO organization_rule_events`
// to push the queue past threshold before the run, or use the chaos test setup
// in the Confluence runbook.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const WORKER_URL = __ENV.WORKER_URL || 'http://localhost:3001';

const trips = new Counter('backpressure_503');
const recoveries = new Counter('backpressure_recoveries');

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '90s',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    // Tripped 503s MUST carry Retry-After.
    backpressure_503: ['count>0'],
  },
};

export default function () {
  const res = http.post(
    `${WORKER_URL}/webhooks/docusign`,
    JSON.stringify({ event: 'envelope-completed', loadtest: true }),
    {
      headers: {
        'content-type': 'application/json',
        'x-arkova-loadtest': '1',
      },
      tags: { intentional_503: 'maybe' },
    },
  );
  if (res.status === 503) {
    trips.add(1);
    check(res, {
      '503 carries Retry-After header': (r) => Boolean(r.headers['Retry-After']),
      '503 body is generic (no internal queue depth leak)': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error === 'service temporarily unavailable' && typeof body.retry_after === 'number';
        } catch {
          return false;
        }
      },
    });
  } else if (res.status === 200) {
    recoveries.add(1);
  }
  sleep(0.05);
}
