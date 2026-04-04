/**
 * Production Smoke Test Script (P7-TS-06)
 *
 * Standalone script that validates a running Arkova worker instance
 * by calling key endpoints and verifying responses.
 *
 * Usage:
 *   npx tsx services/worker/scripts/smoke-test.ts
 *
 * Environment variables:
 *   WORKER_URL — Base URL of the worker (default: http://localhost:3001)
 *
 * Exit codes:
 *   0 — All checks passed
 *   1 — One or more checks failed
 *
 * Constitution refs:
 *   - 1.9: /health always available without auth
 *   - 1.4: Never send real secrets or PII in smoke tests
 */

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:3001';
const TIMEOUT_MS = 10_000;

interface CheckResult {
  name: string;
  status: 'pass' | 'fail';
  durationMs: number;
  detail?: string;
  error?: string;
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── Check 1: Basic health endpoint ─────────────────────────────────

async function checkHealth(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(`${WORKER_URL}/health`);
    const body = await res.json();
    const durationMs = Date.now() - start;

    if (res.status === 200 && body.status === 'healthy') {
      return {
        name: 'health',
        status: 'pass',
        durationMs,
        detail: `version=${body.version} network=${body.network} uptime=${body.uptime}s`,
      };
    }

    return {
      name: 'health',
      status: 'fail',
      durationMs,
      detail: `HTTP ${res.status}: ${body.status}`,
      error: JSON.stringify(body.checks),
    };
  } catch (err) {
    return {
      name: 'health',
      status: 'fail',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Check 2: Detailed health endpoint ──────────────────────────────

async function checkHealthDetailed(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(`${WORKER_URL}/health?detailed=true`);
    const body = await res.json();
    const durationMs = Date.now() - start;

    // Validate response structure has expected subsystem checks
    const hasDatabase = body.checks?.database !== undefined;
    const hasAnchoring = body.checks?.anchoring !== undefined;
    const hasKms = body.checks?.kms !== undefined;
    const hasInfo = body.info !== undefined;

    if (hasDatabase && hasAnchoring && hasKms && hasInfo) {
      const dbStatus = body.checks.database.status ?? body.checks.database;
      const kmsStatus = body.checks.kms.status ?? body.checks.kms;
      return {
        name: 'health-detailed',
        status: 'pass',
        durationMs,
        detail: `database=${dbStatus} kms=${kmsStatus} pending=${body.checks.anchoring.pendingCount ?? 'n/a'}`,
      };
    }

    return {
      name: 'health-detailed',
      status: 'fail',
      durationMs,
      error: `Missing expected checks. Got: ${Object.keys(body.checks ?? {}).join(', ')}`,
    };
  } catch (err) {
    return {
      name: 'health-detailed',
      status: 'fail',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Check 3: Verification endpoint responds (404 for unknown ID) ───

async function checkVerifyEndpoint(): Promise<CheckResult> {
  const start = Date.now();
  const fakePublicId = 'smoke-test-nonexistent-00000000';

  try {
    const res = await fetchWithTimeout(`${WORKER_URL}/api/v1/verify/${fakePublicId}`);
    const durationMs = Date.now() - start;

    // We expect either 404 (not found) or 403 (feature flag disabled) — both are valid
    if (res.status === 404 || res.status === 403) {
      return {
        name: 'verify-endpoint',
        status: 'pass',
        durationMs,
        detail: `HTTP ${res.status} (expected — endpoint responds correctly)`,
      };
    }

    // 200 would be unexpected for a fake ID but still means the endpoint works
    if (res.status === 200) {
      return {
        name: 'verify-endpoint',
        status: 'pass',
        durationMs,
        detail: 'HTTP 200 (endpoint responding)',
      };
    }

    const body = await res.text();
    return {
      name: 'verify-endpoint',
      status: 'fail',
      durationMs,
      error: `Unexpected HTTP ${res.status}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      name: 'verify-endpoint',
      status: 'fail',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Check 4: Worker responds to unknown route with JSON 404 ────────

async function checkNotFoundHandler(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(`${WORKER_URL}/nonexistent-smoke-test-route`);
    const body = await res.json();
    const durationMs = Date.now() - start;

    if (res.status === 404 && body.error === 'not_found') {
      return {
        name: '404-handler',
        status: 'pass',
        durationMs,
        detail: 'JSON 404 handler working correctly',
      };
    }

    return {
      name: '404-handler',
      status: 'fail',
      durationMs,
      error: `Expected JSON 404, got HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name: '404-handler',
      status: 'fail',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Check 5: API docs endpoint ─────────────────────────────────────

async function checkApiDocs(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(`${WORKER_URL}/api/docs/spec.json`);
    const durationMs = Date.now() - start;

    if (res.status === 200) {
      const body = await res.json();
      const hasOpenapi = body.openapi || body.swagger;
      return {
        name: 'api-docs',
        status: hasOpenapi ? 'pass' : 'fail',
        durationMs,
        detail: hasOpenapi ? `OpenAPI ${body.openapi ?? body.swagger}` : 'Missing openapi version',
      };
    }

    return {
      name: 'api-docs',
      status: 'fail',
      durationMs,
      error: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name: 'api-docs',
      status: 'fail',
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Runner ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nArkova Production Smoke Test`);
  console.log(`Target: ${WORKER_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  const results: CheckResult[] = [];

  const checks = [
    checkHealth,
    checkHealthDetailed,
    checkVerifyEndpoint,
    checkNotFoundHandler,
    checkApiDocs,
  ];

  for (const check of checks) {
    const result = await check();
    results.push(result);

    const icon = result.status === 'pass' ? 'PASS' : 'FAIL';
    const line = `[${icon}] ${result.name} (${result.durationMs}ms)`;
    if (result.detail) {
      console.log(`${line} - ${result.detail}`);
    } else if (result.error) {
      console.log(`${line} - ${result.error}`);
    } else {
      console.log(line);
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;

  console.log(`\n--- Summary ---`);
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);

  // Output JSON for machine consumption
  const report = {
    target: WORKER_URL,
    timestamp: new Date().toISOString(),
    passed,
    failed,
    total: results.length,
    results,
  };

  console.log(`\n--- JSON Report ---`);
  console.log(JSON.stringify(report, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test runner failed:', err);
  process.exit(1);
});
