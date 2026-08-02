import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-worker.yml'), 'utf8');

/** Return checkout step blocks occurring before the worker-test command. */
function checkoutStepsBeforeWorkerTests(job: string): string[] {
  const testCommandIndex = job.indexOf('run: npm test');
  if (testCommandIndex < 0) return [];

  const lines = job.slice(0, testCommandIndex).split('\n');
  const starts = lines.flatMap((line, index) => (
    /^\s*-\s+uses:\s*actions\/checkout@/u.test(line) ? [index] : []
  ));

  return starts.map((start) => {
    const indent = lines[start]?.slice(0, lines[start]?.indexOf('-')) ?? '';
    const nextStep = lines.findIndex((line, index) => (
      index > start && line.startsWith(`${indent}- `)
    ));
    return lines.slice(start, nextStep < 0 ? lines.length : nextStep).join('\n');
  });
}

describe('Deploy Worker pre-deploy Git history contract', () => {
  it('uses an isolated full-history checkout for history-bound worker tests', () => {
    const preDeployJob = workflow.match(/\n {2}pre-deploy-checks:\n([\s\S]*?)\n {2}deploy:\n/)?.[1];

    expect(preDeployJob).toBeDefined();
    const checkoutSteps = checkoutStepsBeforeWorkerTests(preDeployJob ?? '');
    const effectiveCheckout = checkoutSteps.at(-1) ?? '';

    expect(checkoutSteps.length).toBeGreaterThan(0);
    expect([...effectiveCheckout.matchAll(/^\s+fetch-depth:\s*(\S+)/gmu)]
      .map((match) => match[1])).toEqual(['0']);
    expect([...effectiveCheckout.matchAll(/^\s+persist-credentials:\s*(\S+)/gmu)]
      .map((match) => match[1])).toEqual(['false']);
  });

  it('selects the last checkout before tests as the effective checkout', () => {
    const job = `
      - uses: actions/checkout@1111111111111111111111111111111111111111
        with:
          fetch-depth: 0
      - uses: actions/checkout@2222222222222222222222222222222222222222
        with:
          fetch-depth: 1
      - name: Test
        run: npm test
    `;

    expect(checkoutStepsBeforeWorkerTests(job).at(-1)).toContain('fetch-depth: 1');
  });
});

/**
 * Live incident, 2026-08-01: prod was caught mid-deploy on
 * `arkova-worker-00892-jd2` carrying 50 env vars while the canary had 57, and
 * the DocuSign Connect webhook was returning 503 `integration_disabled`.
 *
 * Cause: service traffic is pinned `--to-latest` by the promote step, and that
 * setting persists on the service. `Clear conflicting env/secret types` runs
 * `gcloud run services update --remove-secrets/--remove-env-vars`, which
 * CREATES A REVISION — so the moment it lands, "latest" is a revision with the
 * DocuSign/CRON names stripped, and prod follows onto it instantly. It
 * self-heals when the canary is promoted, but any failure between the clear and
 * the promote (canary deploy, smoke test, a cancelled run) leaves prod
 * DocuSign-blind indefinitely, with nothing alarming on it.
 *
 * The invariant these tests pin: **no traffic-serving revision may ever lack
 * the DocuSign/CRON configuration.** Every step that mutates the service before
 * the smoke test must be `--no-traffic`, and traffic may only move in the
 * dedicated promote step that runs after the canary passes its health check.
 */
describe('Deploy Worker traffic-safety contract', () => {
  const step = (name: string): string => {
    const start = workflow.indexOf(`- name: ${name}`);
    expect(start, `deploy-worker.yml must have a "${name}" step`).toBeGreaterThan(-1);
    const next = workflow.indexOf('\n      - name: ', start + 1);
    return workflow.slice(start, next < 0 ? workflow.length : next);
  };

  const clearStep = (): string => step('Clear conflicting env/secret types');
  const canaryStep = (): string => step('Deploy canary (no traffic)');
  const promoteStep = (): string => step('Promote canary to full traffic');

  it('never lets the clear step create a traffic-serving revision', () => {
    expect(clearStep()).toMatch(/--no-traffic/u);
  });

  it('never swallows the clear step failure into silence', () => {
    // The step is intentionally non-fatal (clearing an unset name is a no-op),
    // but it must not DISCARD its diagnostics. `2>/dev/null || true` made a
    // real rejection — unsupported flag, missing IAM, wrong service — look
    // exactly like "nothing to clear"; the only downstream symptom was an
    // apparently-unrelated env/secret type conflict in the canary deploy.
    // Assert against the EXECUTABLE lines only — the step's own comment
    // explains the old `2>/dev/null` form by name, and matching that would be
    // the test grading prose rather than behaviour.
    const executable = clearStep()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(executable).not.toMatch(/2>\s*\/dev\/null/u);
    expect(executable).toMatch(/::warning/u);
  });

  it('keeps the canary off traffic until it has passed its smoke test', () => {
    expect(canaryStep()).toMatch(/--no-traffic/u);
    expect(workflow.indexOf('- name: Smoke test canary revision'))
      .toBeLessThan(workflow.indexOf('- name: Promote canary to full traffic'));
  });

  it('moves traffic in exactly one place, after the smoke test', () => {
    const trafficMoves = [...workflow.matchAll(/^\s*gcloud run services update-traffic/gmu)];
    expect(trafficMoves).toHaveLength(1);
    expect(promoteStep()).toMatch(/--to-latest/u);
  });

  it('re-sets every name the clear step removes, so a removal is never permanent', () => {
    const removed = [...clearStep().matchAll(/--remove-(?:secrets|env-vars)\s+(\S+)/gu)]
      .flatMap((match) => match[1].split(','))
      .map((name) => name.trim())
      .filter(Boolean);
    expect(removed.length).toBeGreaterThan(0);

    const canary = canaryStep();
    for (const name of new Set(removed)) {
      expect(canary, `${name} is cleared but never re-set by the canary deploy`)
        .toMatch(new RegExp(`[|,"]${name}=`, 'u'));
    }
  });

  it('sets ENABLE_CONNECTOR_ARTIFACT_DRAIN so the drain cron stops no-opping', () => {
    // Env-only flag (services/worker/src/config.ts reads process.env directly —
    // there is no switchboard row for it), so a manual `gcloud run services
    // update` would be wiped by the next deploy: --set-env-vars is exhaustive.
    expect(canaryStep()).toMatch(/\|\|ENABLE_CONNECTOR_ARTIFACT_DRAIN=true/u);
  });

  it('asserts at runtime that the serving revision carries the required config', () => {
    const verify = step('Verify serving revision carries required config');
    expect(verify).toMatch(/gcloud run revisions describe/u);
    for (const name of [
      'CRON_SECRET',
      'DOCUSIGN_INTEGRATION_KEY',
      'DOCUSIGN_CLIENT_SECRET',
      'DOCUSIGN_CONNECT_HMAC_SECRET',
      'ENABLE_DOCUSIGN_OAUTH',
      'ENABLE_DOCUSIGN_WEBHOOK',
      'DOCUSIGN_DEMO',
      'ENABLE_CONNECTOR_ARTIFACT_DRAIN',
    ]) {
      expect(verify, `${name} is not asserted on the serving revision`).toContain(name);
    }
  });

  it('does NOT yet set ENABLE_CONNECTOR_ARTIFACT_ENQUEUE', () => {
    // docs/release/prod-enablement-checklist-2026-08.md §2.3: DRAIN first,
    // observe one clean cron cycle, THEN decide on ENQUEUE. Enabling the
    // producer before the consumer is confirmed piles up `pending`
    // connector_artifact rows that nothing drains.
    expect(workflow).not.toMatch(/ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true/u);
  });
});
