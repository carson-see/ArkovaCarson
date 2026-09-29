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

  it('wires the proof-signing KMS key so ?format=signed stops answering 503', () => {
    // SCRUM-5258. The signer (api/v1/verify-proof.ts `resolveSigner`) reads
    // PROOF_SIGNING_KMS_KEY + PROOF_SIGNING_KEY_ID straight off process.env and
    // returns null when either is absent, so `?format=signed` answered 503 on
    // every prod revision from the feature shipping (SCRUM-900, 2026-04-28)
    // until this wiring landed — 3.5 months during which the KMS key existed,
    // was ENABLED, carried the right IAM, and had its PUBLIC half already
    // published at /.well-known/arkova-keys.json and /.well-known/did.json.
    // Nothing was broken; two env vars were never set.
    //
    // There is NO Zod validation for these two in config.ts (unlike the
    // Bitcoin KMS key), so a typo here does not fail the boot — it silently
    // restores the 503. That is exactly why this is asserted in the workflow
    // contract and again against the serving revision below.
    //
    // The key id must match the `active` entry in the public key registry
    // (`proofKeysRouter`), or a verifier resolving a bundle's signing_key_id
    // finds no key and cannot check the signature.
    const canary = canaryStep();
    expect(canary).toMatch(
      /\|\|PROOF_SIGNING_KMS_KEY=projects\/arkova1\/locations\/global\/keyRings\/arkova-signing\/cryptoKeys\/proof-signing\/cryptoKeyVersions\/1/u,
    );
    expect(canary).toMatch(/\|\|PROOF_SIGNING_KEY_ID=arkova-proof-2026-q2/u);
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
      'PROOF_SIGNING_KMS_KEY',
      'PROOF_SIGNING_KEY_ID',
    ]) {
      expect(verify, `${name} is not asserted on the serving revision`).toContain(name);
    }
  });

  it('never enables the connector-artifact producer without its consumer', () => {
    // docs/release/prod-enablement-checklist-2026-08.md §2.3 ordered these:
    // DRAIN first, observe one clean cron cycle, THEN decide on ENQUEUE. The
    // hazard it guards is a producer with no consumer, which piles up `pending`
    // connector_artifact rows that nothing drains.
    //
    // That gate has since been passed, so this asserts the surviving invariant
    // rather than the one-time ordering. ENQUEUE landed in 4dc9b19ff without
    // this test being updated, which red-lined every PR that merged main.
    //
    // Evidence for the promotion (prod vzwyaatejekddvltxyye, 2026-08-02):
    // both flags true on the serving revision, and connector_artifact held 3
    // rows, all `anchored`, 0 `pending` — the drain is demonstrably consuming.
    if (/ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true/u.test(workflow)) {
      expect(canaryStep(), 'ENQUEUE is set without DRAIN — the producer would outrun the consumer')
        .toMatch(/\|\|ENABLE_CONNECTOR_ARTIFACT_DRAIN=true/u);
    }
  });
});

/**
 * Secret Manager preflight coverage ratchet (SCRUM-4495 review).
 *
 * `--set-secrets` names Secret Manager secrets by id. A name that does not
 * exist is not a warning — `gcloud run deploy` rejects the whole revision, so
 * the deploy dies AFTER the image build, the Trivy scan and the push, with an
 * error that reads as a Cloud Run problem rather than "nobody created the
 * secret yet". The preflight step exists to catch that in seconds, and it can
 * only do so for names it actually checks.
 *
 * Pre-existing ids are proven to exist by every green deploy on `main`, so the
 * preflight lists only the NEWLY-introduced ones — which means the coverage
 * decision is invisible in the diff and silently rots. This pins it: any id
 * added to `--set-secrets` from here on must either be listed in the preflight
 * loop or added to the grandfathered baseline below, in the same change.
 */
describe('Deploy Worker Secret Manager preflight coverage', () => {
  const setSecrets = /--set-secrets\s+"([^"]+)"/.exec(workflow)?.[1];
  const preflight = /Preflight required Secret Manager entries[\s\S]*?\n      - name:/.exec(workflow)?.[0]
    ?? /Preflight required Secret Manager entries[\s\S]*/.exec(workflow)?.[0];

  /**
   * Every secret id already live before the preflight step existed. Each is
   * proven present by the green deploy history on `main`; they are exempt so
   * the ratchet applies to NEW risk only. Do not extend this list to dodge the
   * check — add the id to the preflight loop instead.
   */
  const GRANDFATHERED = new Set([
    'supabase-url', 'supabase-service-role-key', 'supabase-jwt-secret', 'stripe-secret-key',
    'stripe-webhook-secret', 'bitcoin-treasury-wif', 'sentry-dsn', 'api-key-hmac-secret',
    'gemini-api-key', 'cron-secret', 'resend-api-key', 'together-api-key',
    'courtlistener-api-token', 'openstates-api-key', 'bitcoin-rpc-url',
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'runpod-api-key',
    'edgar-user-agent', 'sam-gov-api-key', 'cloudflare-api-token', 'cloudflare-tunnel-token',
    'google-oauth-client-id', 'google-oauth-client-secret', 'docusign_integration_key',
    'docusign_secretkey_prod', 'docusign_connect_hmac_secret_prod',
    'INTEGRATION_STATE_HMAC_SECRET', 'HEALTH_DETAIL_TOKEN', 'ip-hash-pepper',
  ]);

  it('sanity: both the --set-secrets list and the preflight step are parseable', () => {
    expect(setSecrets, '--set-secrets "..." must be present').toBeTruthy();
    expect(preflight, 'the preflight step must be present').toBeTruthy();
  });

  it('every newly-introduced --set-secrets id is covered by the preflight loop', () => {
    // "ENV_NAME=secret-id:latest" → "secret-id"
    const ids = setSecrets!.split(',').map((pair) => pair.split('=')[1]?.split(':')[0]).filter(Boolean) as string[];
    expect(ids.length).toBeGreaterThan(30);
    const uncovered = ids.filter((id) => !GRANDFATHERED.has(id) && !preflight!.includes(id));
    expect(
      uncovered,
      `--set-secrets ids with no preflight coverage (add them to the preflight loop in the SAME commit): ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('the preflight reads existence only — it must never access a secret VALUE', () => {
    // `describe` returns metadata; `versions access` returns the payload. The
    // payload must never be fetched here: it would land in an Actions log.
    expect(preflight).toContain('gcloud secrets describe');
    expect(preflight).not.toContain('versions access');
  });

  it('pins the durable recipient identity key and preflights its Secret Manager metadata', () => {
    const mappings = new Map(
      setSecrets!.split(',').map((pair) => {
        const [envName, secretRef] = pair.split('=');
        return [envName, secretRef] as const;
      }),
    );
    const recipientPepper = mappings.get('RECIPIENT_IDENTIFIER_PEPPER');

    expect(recipientPepper).toBe('recipient-identifier-pepper:1');
    expect(preflight).toContain('recipient-identifier-pepper');
    expect(preflight).toContain('gcloud secrets versions describe 1');
    expect(preflight).toContain('--secret=recipient-identifier-pepper');
    expect(preflight).toContain('ENABLED');
    expect(preflight).toContain('Pinned recipient key version unavailable');
  });

  it('only an unambiguous NOT_FOUND fails the deploy', () => {
    // The deploy SA (github-actions-deploy@arkova1, verified 2026-09-12) holds
    // no Secret Manager role, so `describe` returns PERMISSION_DENIED. A
    // preflight that treats every gcloud failure as "missing" reds EVERY prod
    // deploy with a remediation that cannot work — it becomes the outage it
    // exists to prevent.
    expect(preflight).toContain('NOT_FOUND');
    expect(preflight).toContain('::warning title=');
  });
});
