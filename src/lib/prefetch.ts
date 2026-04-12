/**
 * Route Prefetching (PERF-11)
 *
 * Uses requestIdleCallback to prefetch likely next routes after
 * the initial page is interactive. This makes navigation feel instant
 * by pre-loading route chunks in the background.
 *
 * Bandwidth-conscious: skips prefetch on slow connections.
 */

/** Routes to prefetch after initial load (highest traffic pages) */
const PREFETCH_ROUTES = [
  () => import('@/pages/DashboardPage'),
  () => import('@/pages/MyRecordsPage'),
  () => import('@/pages/DocumentsPage'),
  () => import('@/pages/SettingsPage'),
  () => import('@/pages/MyCredentialsPage'),
];

let prefetched = false;

/**
 * Prefetch critical route chunks during idle time.
 * Call once after the app has fully rendered its initial route.
 */
export function prefetchCriticalRoutes(): void {
  if (prefetched) return;
  prefetched = true;

  // Skip on slow connections
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } };
  if (nav.connection?.saveData || nav.connection?.effectiveType === 'slow-2g' || nav.connection?.effectiveType === '2g') {
    return;
  }

  // Stagger prefetches to avoid saturating the network
  PREFETCH_ROUTES.forEach((loader, i) => {
    const delay = 2000 + i * 500;
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => {
        loader().catch(() => { /* Prefetch failure is non-critical */ });
      }, { timeout: delay });
    } else {
      setTimeout(() => {
        loader().catch(() => { /* Prefetch failure is non-critical */ });
      }, delay);
    }
  });
}
