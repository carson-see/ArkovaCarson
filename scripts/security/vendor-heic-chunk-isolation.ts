/**
 * Static guard for the vite.config.ts `manualChunks` engineering rule
 * (counsel LGPL review, 2026-07-28): any module belonging to `heic-decode`
 * or `libheif-js` (LGPL-3.0) must be routed to its own isolated,
 * lazily-loaded chunk — never merged into a shared vendor chunk that also
 * ships in the initial bundle. The LGPL-3.0 compliance position recorded in
 * scripts/security/license-denylist.allowlist.json depends on this holding.
 *
 * This inspects the SOURCE TEXT of the `manualChunks` function body rather
 * than an actual build, so it works before the dependency exists (today, on
 * `main`) and after it lands (PR #1740). It cannot verify runtime chunk
 * output — see the accompanying test file for a build-output companion once
 * that's practical to add without a full production build in CI.
 */

const HEIC_MODULE_PATTERN = /heic-decode|libheif-js/;

/**
 * Strips `//` line comments so an EXAMPLE line inside a documentation
 * comment (like the one this rule leaves in vite.config.ts pointing future
 * authors at the exact branch to add) doesn't get parsed as if it were live
 * code. Deliberately simple (no block-comment or string-literal awareness —
 * this file's inputs are trusted, checked-in vite.config.ts source, not
 * arbitrary untrusted input).
 */
function stripLineComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

export interface HeicChunkIsolationResult {
  /** True if the source references heic-decode/libheif-js at all. */
  referencesHeicModules: boolean;
  /** True if isolation is satisfied (or vacuously true — no reference yet). */
  isolated: boolean;
  /** Human-readable reason when `isolated` is false. */
  violation?: string;
}

/**
 * Parses the body of `manualChunks: (id) => { ... }` out of a vite.config.ts
 * source string and checks that any branch matching heic-decode/libheif-js
 * returns a distinct chunk name that no OTHER branch also returns (i.e. it
 * is not silently folded into an existing shared vendor chunk).
 */
export function assertHeicChunkIsolated(
  viteConfigSource: string,
  /**
   * Whether heic-decode/libheif-js is actually in the dependency tree.
   *
   * THIS PARAMETER EXISTS BECAUSE THE GUARD USED TO BE UNFALSIFIABLE. It only
   * ever parsed vite.config.ts, so "no heic branch in manualChunks" was read as
   * "the dependency isn't in the tree yet — vacuously satisfied" and returned
   * GREEN. That is precisely the violating state: `heic-decode@2.1.0` has been
   * a production dependency, and `libheif-js@1.19.8` in the lockfile, the whole
   * time — dynamically imported at src/lib/ocrWorker.ts. The guard reported
   * compliance at the exact moment the rule was broken.
   *
   * Callers should pass `isHeicDependencyInstalled()`. Defaults to false to
   * preserve the old signature for the pure source-parsing unit tests.
   */
  dependencyInstalled = false,
): HeicChunkIsolationResult {
  const manualChunksMatch = viteConfigSource.match(/manualChunks:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{8}\},/);
  const body = stripLineComments(manualChunksMatch?.[1] ?? viteConfigSource);

  if (!HEIC_MODULE_PATTERN.test(body)) {
    if (dependencyInstalled) {
      return {
        referencesHeicModules: false,
        isolated: false,
        violation:
          'heic-decode/libheif-js IS in the dependency tree, but vite.config.ts manualChunks has no ' +
          "branch routing it to an isolated chunk. It will be folded into a shared vendor chunk, " +
          'which defeats the LGPL-3.0 relinking position recorded in ' +
          'scripts/security/license-denylist.allowlist.json. Add: ' +
          "if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-heic';",
      };
    }
    // Genuinely nothing to isolate — the dependency is absent AND unreferenced.
    return { referencesHeicModules: false, isolated: true };
  }

  // Collect every `if (...) return 'chunk-name';` branch (single or double
  // quoted) so we can see what chunk name the heic branch returns and
  // whether any OTHER branch returns that same name (which would mean the
  // isolation was defeated by aliasing, not just by deleting the branch).
  // Lazy `[\s\S]*?` (not `[^)]*`) so a condition containing its own
  // parentheses — e.g. `id.includes('heic-decode') || id.includes(...)` —
  // is captured in full instead of truncating at the first inner `)`.
  const branchPattern = /if\s*\(([\s\S]*?)\)\s*return\s*['"]([\w-]+)['"]/g;
  const branches: { condition: string; chunkName: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = branchPattern.exec(body)) !== null) {
    branches.push({ condition: match[1], chunkName: match[2] });
  }

  const heicBranches = branches.filter((b) => HEIC_MODULE_PATTERN.test(b.condition));

  if (heicBranches.length === 0) {
    return {
      referencesHeicModules: true,
      isolated: false,
      violation:
        'heic-decode/libheif-js is referenced in manualChunks but no `if (...) return \'chunk-name\'` ' +
        'branch matches it — it will fall through to a shared/default chunk.',
    };
  }

  for (const heicBranch of heicBranches) {
    const collidingBranch = branches.find(
      (b) => b.chunkName === heicBranch.chunkName && !HEIC_MODULE_PATTERN.test(b.condition),
    );
    if (collidingBranch) {
      return {
        referencesHeicModules: true,
        isolated: false,
        violation:
          `heic-decode/libheif-js branch returns chunk '${heicBranch.chunkName}', which is ALSO returned by ` +
          `a non-heic branch (condition: ${collidingBranch.condition}) — the chunk is not isolated.`,
      };
    }
  }

  return { referencesHeicModules: true, isolated: true };
}

/**
 * Is heic-decode / libheif-js actually in the dependency tree?
 *
 * Checks the root package.json dependency maps AND the lockfile, because the
 * LGPL obligation attaches to what we SHIP, not to what a config file mentions.
 * Pure over its inputs so it is trivially testable; `loadHeicDependencyState`
 * does the file I/O.
 */
export function isHeicDependencyInstalled(args: {
  packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  packageLockJson: { packages?: Record<string, unknown> };
}): boolean {
  const declared = {
    ...(args.packageJson.dependencies ?? {}),
    ...(args.packageJson.devDependencies ?? {}),
  };
  if ('heic-decode' in declared || 'libheif-js' in declared) return true;

  return Object.keys(args.packageLockJson.packages ?? {}).some(
    (p) => p.endsWith('node_modules/heic-decode') || p.endsWith('node_modules/libheif-js'),
  );
}
