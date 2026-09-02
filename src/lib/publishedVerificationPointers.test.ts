/**
 * Published verification pointers — anti-rot ratchet.
 *
 * Every proof certificate and the public "Verify Without Arkova" page tell a
 * reader where to go and what to run. Both pointed somewhere that does not
 * work:
 *
 *  - `CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL` named `https://arkova.ai/verify`,
 *    which 302s to the marketing homepage (control: `arkova.ai/nonsense-xyz`
 *    404s, so the redirect is deliberate — not a fallthrough). It also promised
 *    "paste the proof packet to run all checks in your browser", a capability
 *    that exists on no page in this app. §1.5: state what is measured, not what
 *    we wish were true.
 *  - `INDEPENDENT_VERIFY_LABELS.STEP_3_CMD` told readers to run `./verify.sh`.
 *    No file by that name exists anywhere in this repository, and the page's
 *    download button linked to `/verify.sh` — a 404.
 *
 * These tests pin the correction so it cannot silently rot back. They are
 * deliberately host- and shape-based rather than string-equality snapshots: the
 * copy may be reworded, but it may never again name a bare `arkova.ai/verify`
 * host, and it may never again name a tool this repository does not ship.
 *
 * SCOPE: the whole `copy.ts` module, not a hand-listed pair of blocks. The
 * original defect was one dead pointer in one constant; a ratchet that only
 * watches the two constants we already fixed cannot catch the next one in a
 * block nobody thought to add. `everyPublishedString()` walks every export, so
 * new copy blocks are covered the day they are added.
 */
import { describe, expect, it } from 'vitest';

import * as copy from './copy';

/**
 * Every string reachable from `copy.ts`'s exports, with the export path that
 * leads to it (so a failure names the offending constant, not just the text).
 */
function everyPublishedString(): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      out.push({ path, value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    }
  };
  for (const [name, value] of Object.entries(copy)) walk(value, name);
  return out;
}

/**
 * An `arkova.ai` / `arkova.io` URL whose host is NOT `app.` — the only host
 * that serves a verification UI. Requires the scheme so it cannot match an
 * email address like `privacy@arkova.ai`.
 */
const NON_APP_ARKOVA_URL = /https?:\/\/(?!app\.)(?:[\w-]+\.)*arkova\.(?:ai|io)(?![\w.-])/i;

/** …and the narrower original: such a host carrying a `/verify` path. */
const NON_APP_VERIFY_URL =
  /https?:\/\/(?!app\.)(?:[\w-]+\.)*arkova\.(?:ai|io)\/verify/i;

/** Does this string read like it is telling someone how to verify something? */
const VERIFICATION_CONTEXT = /verif/i;

describe('published verification pointers — host correctness', () => {
  it('no copy string anywhere names an arkova.ai/verify host without the app. prefix', () => {
    const offenders = everyPublishedString()
      .filter(({ value }) => NON_APP_VERIFY_URL.test(value))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('no verification-context copy string points at a non-app. arkova origin', () => {
    // Catches the pathless variant the first rule misses: a bare
    // `https://arkova.ai` offered as somewhere to go and verify is the same
    // defect without the `/verify` segment.
    const offenders = everyPublishedString()
      .filter(
        ({ value }) => VERIFICATION_CONTEXT.test(value) && NON_APP_ARKOVA_URL.test(value),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('the ratchet actually reaches the constants it claims to cover', () => {
    // Guard the guard, part 1: a walk that silently returned [] would pass
    // every rule above forever.
    const paths = everyPublishedString().map(e => e.path);
    expect(paths).toContain('CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL');
    expect(paths).toContain('INDEPENDENT_VERIFY_LABELS.STEP_3_CMD');
    expect(paths.length).toBeGreaterThan(500);
  });

  it('the ratchet regexes actually catch the strings they were written for', () => {
    // Guard the guard, part 2: regexes that match nothing pass vacuously.
    expect(
      NON_APP_VERIFY_URL.test(
        'Reference verifier: https://arkova.ai/verify — paste the proof packet to run all checks in your browser.',
      ),
    ).toBe(true);
    expect(NON_APP_VERIFY_URL.test('https://www.arkova.ai/verify')).toBe(true);
    expect(NON_APP_ARKOVA_URL.test('Go to https://arkova.ai to verify')).toBe(true);
    // …and do NOT flag the correct host, or an email address.
    expect(NON_APP_VERIFY_URL.test('https://app.arkova.ai/verify/independent')).toBe(false);
    expect(NON_APP_ARKOVA_URL.test('https://app.arkova.ai/verify/ARK-2026-001')).toBe(false);
    expect(NON_APP_ARKOVA_URL.test('Contact privacy@arkova.ai to verify')).toBe(false);
  });
});

describe('certificate offline-verify pointer', () => {
  it('points at the live independent-verification page', () => {
    expect(copy.CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL).toContain(
      'https://app.arkova.ai/verify/independent',
    );
  });

  it('does NOT claim a browser tool that accepts a pasted proof packet (§1.5)', () => {
    const tool = copy.CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL.toLowerCase();
    expect(tool).not.toContain('paste');
    expect(tool).not.toContain('in your browser');
  });
});

describe('independent-verify page instructions', () => {
  const everyLabel = () => Object.values(copy.INDEPENDENT_VERIFY_LABELS).join('\n');

  it('names no tool this repository does not ship', () => {
    // `verify.sh` never existed in this repo — the button 404'd and the command
    // could not be run by anyone.
    expect(everyLabel()).not.toMatch(/verify\.sh/);
  });

  it('step 3 runs the in-repo verifier by a path that exists after the build', () => {
    // NOT the bare `arkova-verify`: that is the package's `bin` mapping, which
    // only reaches PATH via `npm link` or a global install. `npm run build` is
    // just `tsc`, so a reader who follows the build and pastes a bare
    // `arkova-verify` gets `command not found` — the same class of unrunnable
    // instruction this file exists to prevent. Invoking dist/cli.js directly
    // needs neither a link nor a global install.
    const cmd = copy.INDEPENDENT_VERIFY_LABELS.STEP_3_CMD;
    expect(cmd).toContain('packages/verifier-cli/dist/cli.js');
    expect(cmd).toMatch(/^node\s/);
    expect(cmd).toContain('proof-package.json');
    // A bare `arkova-verify …` invocation must never come back.
    expect(cmd).not.toMatch(/(^|&&\s*|;\s*)arkova-verify\s/);
  });

  it('the build instruction compiles the file: dependency before the CLI', () => {
    // packages/verifier-cli depends on `@arkova/verifier` as `file:../verifier`,
    // whose main/types point into `dist/` — and `dist/` is gitignored, so on a
    // fresh clone it does not exist. Building only the CLI fails with
    // `TS2307: Cannot find module '@arkova/verifier'`. Both halves, in order.
    const build = copy.INDEPENDENT_VERIFY_LABELS.VERIFIER_BUILD_CMD;
    const libBuild = build.indexOf('packages/verifier ');
    const cliBuild = build.indexOf('packages/verifier-cli ');
    expect(libBuild).toBeGreaterThanOrEqual(0);
    expect(cliBuild).toBeGreaterThanOrEqual(0);
    expect(libBuild).toBeLessThan(cliBuild);
    expect(build).toContain('run build');
  });

  it('does NOT tell readers to install an unpublished package from a registry', () => {
    // Neither @arkova/verifier nor @arkova/verifier-cli is published; telling a
    // reader to `npm install` one is a claim of external status we do not hold
    // (§1.13 R-7). `npm --prefix <path> install` installs a LOCAL directory's
    // own deps and is not a registry fetch of our package, so it is exempt.
    const labels = everyLabel();
    expect(labels).not.toMatch(/npm\s+(?:install|i|add)\s+@arkova\//);
    expect(labels).not.toMatch(/npx\s+@?arkova/);
  });

  it('says how the verifier is obtained today: built from the in-repo source', () => {
    expect(everyLabel()).toContain('packages/verifier-cli');
  });
});
