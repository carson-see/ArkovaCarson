/**
 * lazyWithRetry — resilient dynamic-import wrapper for route-level code splitting.
 *
 * SCRUM-2246 / HARDEN-1-C.
 *
 * After a deploy, Vite emits new content-hashed chunk filenames. A browser tab
 * still running the previous `index.html` requests an old chunk URL that no
 * longer exists → 404 → `import()` rejects → React.lazy + Suspense crash. Sentry
 * sees this as FRONTEND-3 / FRONTEND-8: "Failed to fetch dynamically imported
 * module".
 *
 * Recovery strategy (per loader, on a CHUNK-LOAD error only):
 *   1. Retry the import a few times with short backoff — covers a transient
 *      network blip or an asset that is still propagating to the CDN edge.
 *   2. If it still fails AND we have not already reloaded for this reason
 *      (sessionStorage sentinel unset): set the sentinel and call
 *      `window.location.reload()` ONCE. A fresh index.html points at the new
 *      chunk names, so the next load succeeds.
 *   3. If the sentinel IS set, a reload already happened and the chunk is still
 *      missing — reloading again would loop. Instead, rethrow so the route error
 *      boundary renders a graceful "refresh for the newest version" fallback.
 *
 * Non-chunk errors (a real bug in the page module) must NEVER trigger a reload —
 * they fail fast and propagate to the error boundary unchanged.
 *
 * The sentinel is cleared on any successful load so a *future* deploy can recover
 * via the same one-reload path.
 *
 * NOTE (caching dependency): this fix assumes the server serves `index.html`
 * with a short/no-cache policy while hashed `/assets/*` files are immutable. If
 * index.html is itself cached immutably, the post-reload index would still point
 * at stale chunk names and the reload would not recover. See vercel.json — as of
 * this change, `/assets/*` is `immutable` and the SPA fallback to /index.html has
 * NO explicit Cache-Control (so it inherits Vercel's default short-lived edge
 * behavior, which is correct for this fix). Flagged for review, not changed here.
 */

import React from 'react';

/** sessionStorage key recording that we already force-reloaded for a chunk miss. */
export const RETRY_SENTINEL_KEY = 'arkova:chunk-reload';

/**
 * Module shape returned by a dynamic import used with React.lazy. Mirrors
 * React.lazy's own `{ default: ComponentType<any> }` constraint so any page
 * module (regardless of its props type) is accepted.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ComponentModule = { default: React.ComponentType<any> };

/** A loader is the `() => import('...')` thunk passed to React.lazy. */
type Loader<T> = () => Promise<T>;

export interface RetryOptions {
  /** Number of in-place retries before falling back to reload. Default 2. */
  retries?: number;
  /** Base backoff between retries, in ms. Grows linearly. Default 300. */
  backoffMs?: number;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 300;

/**
 * Browser/bundler chunk-load failure signatures. Different engines word this
 * differently, so we match a SET, not one string.
 *  - Chrome/Edge: "Failed to fetch dynamically imported module"
 *  - Firefox:     "error loading dynamically imported module"
 *  - Safari:      "Importing a module script failed"
 *  - Vite:        "Unable to preload CSS for ..." / "error loading dynamically..."
 *  - Webpack-era: "ChunkLoadError" / "Loading chunk N failed"
 */
const CHUNK_ERROR_SIGNATURES: readonly RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /unable to preload css/i,
  /loading chunk [\w-]+ failed/i,
  /loading css chunk [\w-]+ failed/i,
  /chunkloaderror/i,
];

/**
 * True only for errors that look like a missing/failed JS or CSS chunk fetch.
 * Accepts an `unknown` so it is safe to call directly on a caught value.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const haystack = `${error.name} ${error.message}`;
  return CHUNK_ERROR_SIGNATURES.some((re) => re.test(haystack));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSentinel(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(RETRY_SENTINEL_KEY) != null;
  } catch {
    // sessionStorage can throw in private mode / sandboxed iframes.
    return false;
  }
}

function setSentinel(): void {
  try {
    globalThis.sessionStorage?.setItem(RETRY_SENTINEL_KEY, String(Date.now()));
  } catch {
    /* best-effort */
  }
}

function clearSentinel(): void {
  try {
    globalThis.sessionStorage?.removeItem(RETRY_SENTINEL_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Core retry/reload loop. Exported for unit testing; route code uses
 * {@link lazyWithRetry}.
 *
 * Resolves with the imported module. On a persistent chunk error with the
 * sentinel unset, it triggers a one-time reload and returns a never-settling
 * promise (the page is navigating away). On any non-chunk error, or a chunk
 * error after a prior reload, it rejects with the original error.
 */
export async function loadWithRetry<T>(
  loader: Loader<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const mod = await loader();
      // Success — a fresh chunk loaded. Reset the recovery latch so a future
      // deploy can recover via the same one-reload path.
      clearSentinel();
      return mod;
    } catch (error) {
      lastError = error;

      // Real page bug (not a chunk miss) — fail fast, never reload.
      if (!isChunkLoadError(error)) {
        throw error;
      }

      // Transient chunk error and we still have retries left — back off and retry.
      if (attempt < retries) {
        await delay(backoffMs * (attempt + 1));
        continue;
      }
    }
  }

  // Exhausted retries on a chunk error.
  if (readSentinel()) {
    // We already reloaded once and the chunk is STILL missing. Do not loop —
    // let the error boundary show the graceful fallback.
    throw lastError;
  }

  // First persistent chunk miss: latch and reload to pick up a fresh index.html.
  setSentinel();
  globalThis.location.reload();

  // The page is reloading; keep the consumer suspended rather than flashing an
  // error boundary in the moment before navigation.
  return new Promise<T>(() => {
    /* intentionally never settles — navigation supersedes this */
  });
}

/**
 * Drop-in replacement for `React.lazy(() => import('...'))` that adds
 * stale-chunk retry + one-time reload recovery.
 *
 * @example
 *   const DashboardPage = lazyWithRetry(() =>
 *     import('@/pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
 */
export function lazyWithRetry<T extends ComponentModule>(
  loader: Loader<T>,
  options?: RetryOptions,
): React.LazyExoticComponent<T['default']> {
  return React.lazy(() => loadWithRetry(loader, options));
}
