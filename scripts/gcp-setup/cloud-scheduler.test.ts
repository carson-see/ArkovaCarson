/**
 * Cloud Scheduler job declaration — CE Registry drift-check trigger gap.
 *
 * `services/worker/src/routes/cron.ts` wires `POST /jobs/ce-registry-drift-check`
 * (`services/worker/src/jobs/ce-registry-drift.ts`) behind
 * `ENABLE_CE_REGISTRY_DRIFT_CHECK` (default false) — the read-back
 * verification that proves a Credential Engine Registry record still matches
 * what Arkova anchored. The flag defaulting OFF is deliberate (the job makes
 * new outbound traffic to a partner's public infrastructure, so it "ships
 * dark and is turned on deliberately" per that file's own header comment).
 *
 * But the route had NO Cloud Scheduler declaration anywhere in this script —
 * a job with no trigger. Flipping the flag on would still do nothing: there
 * was no way to ever invoke the route, not even once, deliberately or not.
 * This test pins the declaration (mirroring every other job in this file, per
 * this folder's own agents.md: "When you create a scheduler job in prod, add
 * it here in the same change") so the gap cannot silently reopen.
 *
 * SCOPE: this test proves the declaration exists in this script. It does NOT
 * prove the job exists in prod GCP Scheduler — creating it there requires
 * running this script with `gcloud auth login` project-admin credentials,
 * which is an operator step this test (and the session that wrote it) cannot
 * perform. See scripts/gcp-setup/agents.md's own "NOT a complete inventory"
 * warning before citing this test as proof of live prod state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

const scheduleScript = fs.readFileSync(
  path.join(repoRoot, 'scripts/gcp-setup/cloud-scheduler.sh'),
  'utf8',
);

const cronRoutes = fs.readFileSync(
  path.join(repoRoot, 'services/worker/src/routes/cron.ts'),
  'utf8',
);

const workerIndex = fs.readFileSync(
  path.join(repoRoot, 'services/worker/src/index.ts'),
  'utf8',
);

function findJobLine(script: string, jobName: string): string | undefined {
  return script
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(`"${jobName}|`));
}

describe('cloud-scheduler.sh — ce-registry-drift-check job declaration', () => {
  it('sanity: cronRouter is mounted at /jobs, so a bare route path becomes /jobs/<path>', () => {
    expect(workerIndex).toContain("app.use('/jobs', cronRouter);");
  });

  it('sanity: cron.ts actually registers the /ce-registry-drift-check route this test defends', () => {
    expect(cronRoutes).toContain("cronRouter.post('/ce-registry-drift-check'");
  });

  it('declares a ce-registry-drift-check job pointed at the registered route', () => {
    const jobLine = findJobLine(scheduleScript, 'ce-registry-drift-check');
    expect(jobLine, 'ce-registry-drift-check must be declared in the JOBS array').toBeDefined();

    const [name, schedule, endpointPath, retry] = jobLine!.replace(/^"|"$/g, '').split('|');
    expect(name).toBe('ce-registry-drift-check');
    // Full external path is the /jobs mount prefix + the route's own sub-path.
    expect(endpointPath).toBe('/jobs/ce-registry-drift-check');
    // Cron syntax sanity: 5 space-separated fields (minute hour day month weekday).
    expect(schedule.trim().split(/\s+/)).toHaveLength(5);
    expect(retry).toBeTruthy();
  });

  it('uses a retry policy, not NO_RETRY — a load failure (500) should be retried, not silently dropped', () => {
    // ce-registry-drift.ts returns 500 specifically when the load itself
    // failed (loadFailed), precisely so Cloud Scheduler retries rather than
    // recording a false "nothing to reconcile" success.
    const jobLine = findJobLine(scheduleScript, 'ce-registry-drift-check');
    const [, , , retry] = jobLine!.replace(/^"|"$/g, '').split('|');
    expect(retry).not.toBe('NO_RETRY');
    expect(retry.split(',')).toHaveLength(3);
  });

  it('the job is placed before the closing of the JOBS array (well-formed bash)', () => {
    const jobsStart = scheduleScript.indexOf('JOBS=(');
    const jobLine = findJobLine(scheduleScript, 'ce-registry-drift-check');
    const jobIndex = scheduleScript.indexOf(jobLine!);
    const jobsEnd = scheduleScript.indexOf('\n)', jobsStart);
    expect(jobsStart).toBeGreaterThan(-1);
    expect(jobsEnd).toBeGreaterThan(-1);
    expect(jobIndex).toBeGreaterThan(jobsStart);
    expect(jobIndex).toBeLessThan(jobsEnd);
  });
});

/**
 * Scheduler-coverage ratchet (2026-08-10 CTO-decision audit; SCRUM-2900).
 *
 * Every `cronRouter.post` route must be accounted for in cloud-scheduler.sh:
 * either declared in `JOBS` (it has — or will have, on next script run — a
 * Cloud Scheduler trigger) or listed in `NOT_SCHEDULED` with an explicit
 * reason (manual operator run, flag-coupled dormant feature, parked program,
 * superseded, or product-gated). A route in neither set is exactly how
 * `org-queue-scheduler` (two customer anchors PENDING for three days),
 * `nonce-sweep` (SOC 2 CC7.4 control that never executed), and
 * `drive-file-changed` (launch-critical drain with live producers) went
 * silently untriggered — in-process node-cron is dormant on Cloud Run
 * (PROOF-03), so an unbound route NEVER runs in production.
 *
 * Adding a cron route without deciding its trigger fails this test; the
 * author must place it in one of the two registries in the same change.
 */

function extractQuotedArrayEntries(script: string, arrayName: string): string[] {
  const start = script.indexOf(`${arrayName}=(`);
  expect(start, `${arrayName}=( block must exist in cloud-scheduler.sh`).toBeGreaterThan(-1);
  const end = script.indexOf('\n)', start);
  expect(end, `${arrayName} array must be closed`).toBeGreaterThan(start);
  return script
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"'))
    .map((line) => line.replace(/^"|"$/g, ''));
}

const postRoutePaths = [...cronRoutes.matchAll(/cronRouter\.post\('([^']+)'/g)].map(
  (m) => `/jobs${m[1]}`,
);

describe('cloud-scheduler.sh — every cron route is scheduled or documented as not-scheduled', () => {
  const jobEntries = extractQuotedArrayEntries(scheduleScript, 'JOBS');
  const notScheduledEntries = extractQuotedArrayEntries(scheduleScript, 'NOT_SCHEDULED');

  const scheduledPaths = new Set(
    jobEntries.map((entry) => entry.split('|')[2].split('?')[0]),
  );
  const notScheduledPaths = new Set(
    notScheduledEntries.map((entry) => entry.split('|')[0]),
  );

  it('sanity: route extraction sees the full cron surface (>=100 POST routes)', () => {
    expect(postRoutePaths.length).toBeGreaterThanOrEqual(100);
  });

  it('every POST cron route appears in JOBS or NOT_SCHEDULED', () => {
    const unaccounted = postRoutePaths.filter(
      (p) => !scheduledPaths.has(p) && !notScheduledPaths.has(p),
    );
    expect(
      unaccounted,
      `route(s) with no trigger decision — add to JOBS or NOT_SCHEDULED with a reason: ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });

  it('no route is in both JOBS and NOT_SCHEDULED', () => {
    const both = [...scheduledPaths].filter((p) => notScheduledPaths.has(p));
    expect(both).toEqual([]);
  });

  it('every JOBS endpoint path targets a registered route', () => {
    const routeSet = new Set(postRoutePaths);
    const stale = [...scheduledPaths].filter((p) => !routeSet.has(p));
    expect(stale, `JOBS entries pointing at nonexistent routes: ${stale.join(', ')}`).toEqual([]);
  });

  it('every NOT_SCHEDULED path targets a registered route', () => {
    const routeSet = new Set(postRoutePaths);
    const stale = [...notScheduledPaths].filter((p) => !routeSet.has(p));
    expect(stale, `NOT_SCHEDULED entries pointing at nonexistent routes: ${stale.join(', ')}`).toEqual([]);
  });

  it('every NOT_SCHEDULED entry carries a non-empty reason', () => {
    for (const entry of notScheduledEntries) {
      const [path, reason] = entry.split('|');
      expect(reason?.trim(), `NOT_SCHEDULED entry for ${path} must state a reason`).toBeTruthy();
    }
  });

  it('every JOBS entry is well-formed: 5-field cron, valid retry, optional PAUSED state', () => {
    for (const entry of jobEntries) {
      const [name, schedule, endpointPath, retry, state] = entry.split('|');
      expect(name, entry).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(schedule.trim().split(/\s+/), `bad cron in: ${entry}`).toHaveLength(5);
      expect(endpointPath, entry).toMatch(/^\/jobs\//);
      const retryOk =
        retry === 'NO_RETRY' || retry === 'DEFAULT' || /^\d+s,\d+s,\d+$/.test(retry);
      expect(retryOk, `bad retry field in: ${entry}`).toBe(true);
      if (state !== undefined) {
        expect(state, `only PAUSED is a valid 5th field: ${entry}`).toBe('PAUSED');
      }
    }
  });
});

describe('cloud-scheduler.sh — 2026-08-10 CTO-decision bindings', () => {
  const jobEntries = extractQuotedArrayEntries(scheduleScript, 'JOBS');
  const byName = new Map(jobEntries.map((e) => [e.split('|')[0], e.split('|')]));

  const decisions: Array<[name: string, path: string, schedule: string, retry: string]> = [
    ['docusign-notarization-completed', '/jobs/docusign-notarization-completed', '*/15 * * * *', '30s,120s,2'],
    ['treasury-alert-check', '/jobs/treasury-alert-check', '0 * * * *', 'NO_RETRY'],
    ['detect-reorgs', '/jobs/detect-reorgs', '*/30 * * * *', 'NO_RETRY'],
    ['monitor-stuck-txs', '/jobs/monitor-stuck-txs', '*/30 * * * *', 'NO_RETRY'],
    ['rebroadcast-txs', '/jobs/rebroadcast-txs', '0 * * * *', '30s,120s,2'],
    ['smoke-test', '/jobs/smoke-test', '30 * * * *', 'NO_RETRY'],
    ['reconcile-stripe', '/jobs/reconcile-stripe', '0 7 * * *', 'NO_RETRY'],
    ['cleanup-retention', '/jobs/cleanup-retention', '30 5 * * *', '30s,120s,2'],
  ];

  it.each(decisions)('%s is declared at its decided schedule', (name, path, schedule, retry) => {
    const fields = byName.get(name);
    expect(fields, `${name} must be declared in JOBS`).toBeDefined();
    expect(fields![2]).toBe(path);
    expect(fields![1]).toBe(schedule);
    expect(fields![3]).toBe(retry);
  });
});
