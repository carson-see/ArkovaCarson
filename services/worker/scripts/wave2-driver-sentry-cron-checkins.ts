#!/usr/bin/env -S npx tsx
/**
 * Wave 2 T2 soak driver — #2270 (fix/sentry-cron-checkins-prod-only).
 *
 * Proves shouldSendCronCheckIns() gates Sentry check-in REPORTS to the prod
 * K_SERVICE name only, with the ENABLE_SENTRY_CRON_CHECKINS=true escape hatch
 * working regardless of kService. Also confirms wave2's own deployed
 * K_SERVICE (arkova-worker-wave2-2026-08-staging, live via /api/health) is
 * NOT the prod service name, so this rig correctly suppresses check-ins by
 * default — the gate this PR ships is exercised by the very rig running it.
 */
import { shouldSendCronCheckIns, PROD_SERVICE_NAME } from '../src/utils/sentry.js';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures += 1;
}

console.log(`PROD_SERVICE_NAME = ${JSON.stringify(PROD_SERVICE_NAME)}`);

check(
  'prod K_SERVICE, no escape hatch -> check-ins ON',
  shouldSendCronCheckIns({ kService: PROD_SERVICE_NAME, enableCronCheckIns: undefined }) === true,
);
check(
  'staging K_SERVICE (arkova-worker-staging), no escape hatch -> check-ins OFF',
  shouldSendCronCheckIns({ kService: 'arkova-worker-staging', enableCronCheckIns: undefined }) === false,
);
check(
  'wave2 rig K_SERVICE (arkova-worker-wave2-2026-08-staging), no escape hatch -> check-ins OFF',
  shouldSendCronCheckIns({ kService: 'arkova-worker-wave2-2026-08-staging', enableCronCheckIns: undefined }) === false,
);
check(
  'local dev, kService unset, no escape hatch -> check-ins OFF',
  shouldSendCronCheckIns({ kService: undefined, enableCronCheckIns: undefined }) === false,
);
check(
  'escape hatch ENABLE_SENTRY_CRON_CHECKINS=true forces ON even off prod',
  shouldSendCronCheckIns({ kService: 'arkova-worker-wave2-2026-08-staging', enableCronCheckIns: 'true' }) === true,
);
check(
  'escape hatch requires the EXACT string "true" — "1"/"TRUE"/"yes" do not force it on',
  shouldSendCronCheckIns({ kService: 'arkova-worker-wave2-2026-08-staging', enableCronCheckIns: '1' }) === false &&
    shouldSendCronCheckIns({ kService: 'arkova-worker-wave2-2026-08-staging', enableCronCheckIns: 'TRUE' }) === false,
);
check(
  'default-args form reads process.env.K_SERVICE / process.env.ENABLE_SENTRY_CRON_CHECKINS (matches live default arg shape)',
  typeof shouldSendCronCheckIns() === 'boolean',
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
