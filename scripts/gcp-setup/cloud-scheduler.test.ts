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
