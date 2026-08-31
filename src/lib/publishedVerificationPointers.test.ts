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
 * deliberately host-shaped rather than string-equality snapshots: the copy may
 * be reworded, but it may never again name a bare `arkova.ai/verify` host, and
 * it may never again name a tool this repository does not ship.
 */
import { describe, expect, it } from 'vitest';

import { CERTIFICATE_COPY, INDEPENDENT_VERIFY_LABELS } from './copy';

/**
 * Any `arkova.ai/verify…` reference whose host is NOT `app.arkova.ai`.
 * `https://arkova.ai/verify` and `//www.arkova.ai/verify` both match; only the
 * `app.` host serves a verification UI.
 */
const NON_APP_VERIFY_HOST = /(?<![\w.])(?!app\.)(?:[\w-]+\.)*arkova\.(?:ai|io)\/verify/i;

const ALL_PUBLISHED_COPY: Array<[string, Record<string, string>]> = [
  ['CERTIFICATE_COPY', CERTIFICATE_COPY],
  ['INDEPENDENT_VERIFY_LABELS', INDEPENDENT_VERIFY_LABELS],
];

describe('published verification pointers — host correctness', () => {
  it.each(ALL_PUBLISHED_COPY)(
    '%s never names an arkova.ai/verify host without the app. prefix',
    (_name, block) => {
      const offenders = Object.entries(block).filter(
        ([, v]) => typeof v === 'string' && NON_APP_VERIFY_HOST.test(v),
      );
      expect(offenders).toEqual([]);
    },
  );

  it('the ratchet regex actually catches the string it was written for', () => {
    // Guard the guard: a regex that matches nothing would pass the test above
    // forever. This is the exact string that shipped on every certificate.
    expect(
      NON_APP_VERIFY_HOST.test(
        'Reference verifier: https://arkova.ai/verify — paste the proof packet to run all checks in your browser.',
      ),
    ).toBe(true);
    expect(NON_APP_VERIFY_HOST.test('https://www.arkova.ai/verify')).toBe(true);
    // …and does NOT flag the correct host.
    expect(NON_APP_VERIFY_HOST.test('https://app.arkova.ai/verify/independent')).toBe(false);
    expect(NON_APP_VERIFY_HOST.test('https://app.arkova.ai/verify/ARK-2026-001')).toBe(false);
  });
});

describe('certificate offline-verify pointer', () => {
  it('points at the live independent-verification page', () => {
    expect(CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL).toContain(
      'https://app.arkova.ai/verify/independent',
    );
  });

  it('does NOT claim a browser tool that accepts a pasted proof packet (§1.5)', () => {
    const tool = CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL.toLowerCase();
    expect(tool).not.toContain('paste');
    expect(tool).not.toContain('in your browser');
  });
});

describe('independent-verify page instructions', () => {
  it('names no tool this repository does not ship', () => {
    const everyLabel = Object.values(INDEPENDENT_VERIFY_LABELS).join('\n');
    // `verify.sh` never existed in this repo — the button 404'd and the command
    // could not be run by anyone.
    expect(everyLabel).not.toMatch(/verify\.sh/);
  });

  it('step 3 invokes the real in-repo reference verifier binary', () => {
    // packages/verifier-cli declares bin `arkova-verify`; its README documents
    // `arkova-verify <proof.json> [--rpc <url>] …`.
    expect(INDEPENDENT_VERIFY_LABELS.STEP_3_CMD).toMatch(/^arkova-verify\s/);
    expect(INDEPENDENT_VERIFY_LABELS.STEP_3_CMD).toContain('proof-package.json');
  });

  it('does NOT tell readers to install an unpublished package from a registry', () => {
    // Neither @arkova/verifier nor @arkova/verifier-cli is published; telling a
    // reader to `npm install` one is a claim of external status we do not hold
    // (§1.13 R-7).
    const everyLabel = Object.values(INDEPENDENT_VERIFY_LABELS).join('\n');
    expect(everyLabel).not.toMatch(/npm\s+(?:install|i|add)\s+@arkova\//);
    expect(everyLabel).not.toMatch(/npx\s+@?arkova/);
  });

  it('says how the verifier is obtained today: built from the in-repo source', () => {
    const everyLabel = Object.values(INDEPENDENT_VERIFY_LABELS).join('\n');
    expect(everyLabel).toContain('packages/verifier-cli');
  });
});
