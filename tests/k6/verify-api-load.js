/**
 * k6 Load Test: Verification API (PERF-14)
 *
 * Tests the GET /api/v1/verify/:publicId endpoint under load.
 * Measures p95 latency, error rate, and throughput.
 *
 * Usage:
 *   k6 run tests/k6/verify-api-load.js
 *   k6 run --env BASE_URL=https://arkova-worker-270018525501.us-central1.run.app tests/k6/verify-api-load.js
 *
 * Requires: k6 installed (brew install k6)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const verifyLatency = new Trend('verify_latency', true);

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 10 },  // Ramp up to 10 users
    { duration: '1m', target: 50 },   // Ramp up to 50 users
    { duration: '2m', target: 50 },   // Sustain 50 users
    { duration: '30s', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],    // p95 < 500ms
    http_req_failed: ['rate<0.01'],      // Error rate < 1%
    errors: ['rate<0.01'],
    verify_latency: ['p(95)<200'],       // Verify p95 < 200ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';

// Sample public IDs for testing — replace with real production IDs
const SAMPLE_PUBLIC_IDS = [
  'ARK-2026-TEST-001',
  'ARK-2026-TEST-002',
  'ARK-2026-TEST-003',
];

export default function () {
  const publicId = SAMPLE_PUBLIC_IDS[Math.floor(Math.random() * SAMPLE_PUBLIC_IDS.length)];
  const url = `${BASE_URL}/api/v1/verify/${publicId}`;

  const res = http.get(url, {
    headers: { 'Accept': 'application/json' },
    tags: { name: 'verify' },
  });

  verifyLatency.add(res.timings.duration);

  const success = check(res, {
    'status is 200 or 404': (r) => r.status === 200 || r.status === 404,
    'response is JSON': (r) => {
      try { JSON.parse(r.body); return true; } catch { return false; }
    },
    'has verified field': (r) => {
      try { return JSON.parse(r.body).hasOwnProperty('verified'); } catch { return false; }
    },
    'latency < 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(!success);
  sleep(0.5 + Math.random() * 0.5);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}

function textSummary(data, opts) {
  // k6 built-in text summary
  return JSON.stringify(data.metrics, null, 2);
}
