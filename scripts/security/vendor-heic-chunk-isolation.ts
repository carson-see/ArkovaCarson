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
export function assertHeicChunkIsolated(viteConfigSource: string): HeicChunkIsolationResult {
  const manualChunksMatch = viteConfigSource.match(/manualChunks:\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s{8}\},/);
  const body = stripLineComments(manualChunksMatch?.[1] ?? viteConfigSource);

  if (!HEIC_MODULE_PATTERN.test(body)) {
    // Nothing to isolate yet — the dependency isn't in the tree. Vacuously
    // satisfied; this branch is what keeps the test green on `main` today.
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
