/**
 * Nessie surfaces stay OFF — mount guard.
 *
 * Founder directive (2026-08-01): Nessie stays OFF; it is verified off in prod
 * and no work may activate it. A second, independent directive (SCRUM-2914,
 * 2026-07-22) removed confidence-score UI everywhere, because the score is
 * unreliable and must not be shown to users.
 *
 * Both were violated at once: `ComplianceDashboardPage` mounted
 * `<NessieIntelligencePanel />` UNCONDITIONALLY — no flag, no
 * `useSwitchboard`, nothing — on `/organization/compliance`, a route guarded
 * by `AuthGuard` + `RouteGuard` only (NOT `PlatformAdminRoute`). Every
 * authenticated customer could reach it, and the panel rendered a confidence
 * percentage plus a confidence-decomposition breakdown against a backend that
 * is switched off, so the visible result was an error banner on a surface that
 * should not have existed.
 *
 * Why a scanner and not a page assertion: the page-level regression test lives
 * in ComplianceDashboardPage.test.tsx, but the class of defect is "a Nessie
 * component gets mounted somewhere". `src/components/anchor/agents.md` asserted
 * these surfaces were "unreachable" because Nessie is off — an assertion that
 * was false at the time it was written, and which is presumably why the
 * SCRUM-2914 cleanup pass skipped them. A prose claim in an agents.md cannot
 * enforce anything. This can: it fails on ANY shipped (non-test) source file
 * that JSX-mounts a `Nessie*` component, including ones that do not exist yet.
 *
 * Scope note: this guards the MOUNT, not the existence of the files. A Nessie
 * component may exist unmounted (`NessieInsights` does, exported from the
 * anchor barrel but rendered by nothing), and its own unit test may render it.
 * What may not happen is a shipped surface putting it in front of a user.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/lib$/, '');

/**
 * JSX mount sites only.
 *
 * The leading `(^|[\s{(>])` is load-bearing: it rejects TYPE positions, where
 * `<` is preceded by an identifier character — `useState<NessieContextResponse
 * | null>(...)` is a generic parameter, not a rendered component, and must not
 * trip the guard.
 */
const NESSIE_MOUNT = /(^|[\s{(>])<(Nessie[A-Za-z]*)[\s/>]/;

function shippedTsxFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '*.tsx'], {
    cwd: SRC_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  // Tests are not shipped surfaces: a component's own unit test is allowed to
  // render it.
  return listed.filter((f) => !f.endsWith('.test.tsx'));
}

describe('Nessie stays OFF — no shipped surface mounts a Nessie component', () => {
  const files = shippedTsxFiles();

  it('sanity: the scanner actually sees the frontend source tree', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('pages/ComplianceDashboardPage.tsx');
  });

  it('no non-test file under src/ renders a <Nessie*> component', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(path.join(SRC_ROOT, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        const match = NESSIE_MOUNT.exec(line);
        if (match) offenders.push(`src/${file}:${i + 1} mounts <${match[2]}>`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('sanity: the pattern matches a real mount and ignores a generic type parameter', () => {
    expect(NESSIE_MOUNT.test('        <NessieIntelligencePanel />')).toBe(true);
    expect(NESSIE_MOUNT.test('  {ready && <NessieChat />}')).toBe(true);
    expect(NESSIE_MOUNT.test('  const [r, setR] = useState<NessieContextResponse | null>(null);')).toBe(
      false,
    );
    expect(NESSIE_MOUNT.test('  let x: Map<NessieCitation> = new Map();')).toBe(false);
  });
});
