/**
 * Sentry alert rules must be scoped to the production environment.
 *
 * The latent trap
 * ---------------
 * None of the declared rules in `infra/sentry/alert-rules.json` carried an
 * environment scope. That is harmless *today* only because the soak rigs have
 * no `SENTRY_DSN` — so they emit nothing. The moment any rig gets one (a
 * one-line Cloud Run env change, no code review, no PR), every rule routes rig
 * events to #ops identically to prod. `resolveSentryEnvironment` already does
 * the hard half of the work: rigs run `NODE_ENV=production`, so the environment
 * tag is derived from `K_SERVICE` and only `arkova-worker` earns `production`.
 * The rules simply never used it.
 *
 * The one non-worker emitter
 * --------------------------
 * `revision-drift.yml` POSTs a Sentry envelope directly from GitHub Actions
 * rather than through the SDK, so it does not inherit `Sentry.init`'s
 * environment. If the rules gain an environment scope and that envelope does
 * not, the SCRUM-1247 revision-drift alert silently stops matching — the
 * failure mode this whole file exists to prevent. Pinned below so the two
 * cannot drift apart.
 *
 * NOTE, restated because it matters for how this is read: a rule in
 * `alert-rules.json` is a DECLARATION, not a live alarm. Nothing here changes
 * what fires until an admin applies it in the Sentry UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

interface SentryAlertRule {
  name: string;
  environment?: string | null;
}

function readAlertRules(): { rules: SentryAlertRule[] } {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'infra/sentry/alert-rules.json'), 'utf8'),
  ) as { rules: SentryAlertRule[] };
}

const PROD_ENVIRONMENT = 'production';

describe('Sentry alert rules — production environment scope', () => {
  const { rules } = readAlertRules();

  it('declares at least the rules this repo knows about', () => {
    // Guards against an empty/misparsed file silently satisfying every
    // "every rule ..." assertion below by vacuous truth.
    expect(rules.length).toBeGreaterThanOrEqual(13);
  });

  it('EVERY rule is scoped to the production environment', () => {
    const unscoped = rules
      .filter((rule) => rule.environment !== PROD_ENVIRONMENT)
      .map((rule) => rule.name);

    expect(
      unscoped,
      'an unscoped rule routes rig events to #ops the moment a rig gets a SENTRY_DSN',
    ).toEqual([]);
  });

  it('no rule scopes itself to a rig or staging environment', () => {
    for (const rule of rules) {
      expect(rule.environment).toBe(PROD_ENVIRONMENT);
    }
  });
});

describe('the environment tag can only be earned by the prod service', () => {
  const sentryPath = path.join(repoRoot, 'services/worker/src/utils/sentry.ts');
  const sentrySource = fs.readFileSync(sentryPath, 'utf8');

  /**
   * Resolve the VALUE of PROD_SERVICE_NAME instead of pinning the exact
   * declaration line.
   *
   * Why not `toContain("export const PROD_SERVICE_NAME = 'arkova-worker'")`:
   * that pin is a cross-PR landmine. PR #2231 moves the constant to
   * `utils/environmentNamespace.ts` and re-exports it from sentry.ts — same
   * name, same value — so the literal pin is green on either branch alone
   * and red the moment both merge (the 2026-08-11 each-green-alone-red-
   * together deploy-blackout class; root vitest includes every test under
   * scripts/, so this file runs in the main test job).
   *
   * Why not simply `import { PROD_SERVICE_NAME } from '…/utils/sentry.js'`:
   * sentry.ts imports `@sentry/node` / `@sentry/profiling-node`, which are
   * services/worker-only dependencies. This file runs in the ROOT vitest
   * suite, and ci.yml runs that suite before (or without) the worker
   * `npm ci`, so the import fails at resolution in CI (verified: vite
   * import-analysis error with worker node_modules absent). Resolving the
   * value from source — following a relative re-export when the literal is
   * not in sentry.ts — asserts the same fact and survives both shapes.
   */
  function resolveProdServiceNameValue(): { value: string; definedIn: string } | undefined {
    const literalRe = /export\s+const\s+PROD_SERVICE_NAME\s*=\s*['"]([^'"]+)['"]/;

    const inSentry = literalRe.exec(sentrySource);
    if (inSentry) return { value: inSentry[1], definedIn: 'sentry.ts' };

    // Re-export shape: `import { PROD_SERVICE_NAME } from './x.js'` (with a
    // later `export { PROD_SERVICE_NAME }`) or `export { … } from './x.js'`.
    const viaModule =
      /(?:import|export)\s*\{[^}]*\bPROD_SERVICE_NAME\b[^}]*\}\s*from\s*['"](\.[^'"]+)['"]/.exec(
        sentrySource,
      );
    if (!viaModule) return undefined;

    const targetPath = path.join(
      path.dirname(sentryPath),
      viaModule[1].replace(/\.js$/, '.ts'),
    );
    if (!fs.existsSync(targetPath)) return undefined;

    const inTarget = literalRe.exec(fs.readFileSync(targetPath, 'utf8'));
    if (!inTarget) return undefined;
    return { value: inTarget[1], definedIn: path.basename(targetPath) };
  }

  it('PROD_SERVICE_NAME has the value "arkova-worker", wherever it is declared', () => {
    const resolved = resolveProdServiceNameValue();
    expect(
      resolved,
      'PROD_SERVICE_NAME declaration not found in sentry.ts or its re-export source — ' +
        'the alert-rule environment scope depends on this value existing',
    ).toBeDefined();
    expect(resolved?.value).toBe('arkova-worker');
  });

  it('sentry.ts still exports PROD_SERVICE_NAME for its consumers', () => {
    expect(
      /export\s+(?:const\s+PROD_SERVICE_NAME\b|\{[^}]*\bPROD_SERVICE_NAME\b[^}]*\})/.test(
        sentrySource,
      ),
      'PROD_SERVICE_NAME must remain exported from utils/sentry.ts',
    ).toBe(true);
  });

  it('only K_SERVICE === PROD_SERVICE_NAME resolves to "production"', () => {
    expect(sentrySource).toContain(
      "return inputs.kService === PROD_SERVICE_NAME ? 'production' : inputs.kService",
    );
  });

  it('an explicit SENTRY_ENVIRONMENT override cannot let a rig claim production', () => {
    expect(sentrySource).toContain(
      "if (explicit !== 'production' || inputs.kService === PROD_SERVICE_NAME)",
    );
  });

  it('a bare NODE_ENV=production without the prod service identity is not "production"', () => {
    expect(sentrySource).toContain(
      "return inputs.nodeEnv === 'production' ? 'local-production' : inputs.nodeEnv",
    );
  });
});

describe('the non-SDK emitter stamps the same environment', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/revision-drift.yml'),
    'utf8',
  );

  it('revision-drift.yml sets environment on its raw Sentry envelope', () => {
    // It POSTs the envelope by hand rather than via Sentry.init, so it does not
    // inherit an environment. Without this the SCRUM-1247 rule stops matching.
    expect(
      workflow,
      'revision-drift emits a hand-built envelope — it must stamp environment itself',
    ).toContain('environment: "production"');
  });
});
