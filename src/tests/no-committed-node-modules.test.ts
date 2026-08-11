/**
 * Repo hygiene: nothing named `node_modules` may be tracked, in ANY mode.
 *
 * `.gitignore` carried only `node_modules/`, which matches a directory and NOT
 * a symlink of the same name. On 2026-08-11 a symlink pointing at an absolute
 * session-scratchpad path
 * (`/private/tmp/.../scratchpad/clone-docs/services/worker/node_modules`) was
 * committed to two branches. It resolves on exactly one machine; on a CI runner
 * it is dangling, so `services/worker/node_modules` shadowed the real `npm ci`
 * install and unrelated suites (db.test.ts, safe-fetch.test.ts,
 * chaos-db-outage.test.ts, db-resilience, db-timeout) failed with no change to
 * the code they cover.
 *
 * A gitignore entry alone cannot catch this: it only stops NEW accidental adds,
 * and never fires on an entry that is already tracked. This test does.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('repo hygiene — node_modules is never tracked', () => {
  it('has no tracked path named node_modules, in any git file mode', () => {
    const out = execFileSync('git', ['ls-files', '-s'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    const offenders = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // `<mode> <sha> <stage>\t<path>`
        const [meta, path] = line.split('\t');
        return { mode: meta.split(' ')[0], path };
      })
      .filter(({ path }) => path === 'node_modules' || /(^|\/)node_modules(\/|$)/.test(path));

    expect(
      offenders,
      `tracked node_modules entries must not exist (mode 120000 = symlink):\n${offenders
        .map((o) => `  ${o.mode} ${o.path}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});
