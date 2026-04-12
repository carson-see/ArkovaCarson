/**
 * @arkova/embed — Arkova Embeddable Verification Widget (INT-03 / SCRUM-644)
 *
 * Single-script-tag verification badge for any third-party site. Vanilla JS,
 * no dependencies, CSP-safe, <15 KB gzipped target.
 *
 * Auto-init: when the script loads, it scans for elements with the
 * data-arkova-credential attribute and mounts a widget at each one.
 *
 * Manual init: call window.ArkovaEmbed.mount({ publicId, target, mode }).
 *
 * @example Auto-init
 *   <div data-arkova-credential="ARK-2026-001"></div>
 *   <script src="https://cdn.arkova.ai/embed.js"></script>
 *
 * @example Manual init
 *   <script src="https://cdn.arkova.ai/embed.js"></script>
 *   <script>
 *     ArkovaEmbed.mount({
 *       publicId: 'ARK-2026-001',
 *       target: document.getElementById('badge'),
 *       mode: 'full',
 *     });
 *   </script>
 */

import type { ArkovaEmbedConfig, AnchorData, EmbedMode } from './types';
import { renderLoading, renderError, renderWidget } from './render';

const DEFAULT_API_BASE = 'https://arkova-worker-270018525501.us-central1.run.app';
const DEFAULT_APP_BASE = 'https://app.arkova.ai';

/** Strip trailing slash characters without regex (avoids ReDoS). */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === url.length ? url : url.slice(0, end);
}

/** Resolve a config to its concrete defaults. */
function resolveConfig(config: ArkovaEmbedConfig): Required<Omit<ArkovaEmbedConfig, 'target'>> & {
  target: HTMLElement | null;
} {
  return {
    publicId: config.publicId,
    mode: config.mode ?? 'full',
    target: config.target ?? null,
    apiBaseUrl: stripTrailingSlashes(config.apiBaseUrl ?? DEFAULT_API_BASE),
    appBaseUrl: stripTrailingSlashes(config.appBaseUrl ?? DEFAULT_APP_BASE),
    disableAnalytics: config.disableAnalytics ?? false,
  };
}

/** Fetch anchor data from the public verification API. */
async function fetchAnchor(apiBaseUrl: string, publicId: string): Promise<AnchorData> {
  const url = `${apiBaseUrl}/api/v1/verify/${encodeURIComponent(publicId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as AnchorData;
}

/** Fire-and-forget analytics: log an embed verification event. */
function logEmbedEvent(apiBaseUrl: string, publicId: string, result: 'verified' | 'revoked' | 'not_found'): void {
  // Use the public RPC to record method=embed; ignore failures completely.
  const url = `${apiBaseUrl}/api/v1/verify/${encodeURIComponent(publicId)}/event`;
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ method: 'embed', result, fingerprint_provided: false }),
    keepalive: true,
  }).catch(() => {
    /* swallow — analytics must never break the widget */
  });
}

/** Render a subtree into the target element, replacing any prior content. */
function renderInto(target: HTMLElement, mode: EmbedMode, child: HTMLElement): void {
  child.dataset.arkovaMode = mode;
  target.replaceChildren(child);
}

/**
 * Mount a single widget instance. Returns a Promise that resolves once
 * the widget has rendered (success or error state).
 */
export async function mount(config: ArkovaEmbedConfig): Promise<void> {
  const c = resolveConfig(config);
  if (!c.target) {
    throw new Error('ArkovaEmbed.mount: target is required when called manually');
  }
  if (!c.publicId) {
    renderInto(c.target, c.mode, renderError(c.mode, 'Missing publicId'));
    return;
  }

  // Show loading immediately
  renderInto(c.target, c.mode, renderLoading(c.mode));

  try {
    const data = await fetchAnchor(c.apiBaseUrl, c.publicId);

    if (data.error || !data.verified) {
      renderInto(c.target, c.mode, renderError(c.mode, data.error ?? 'Verification failed'));
      if (!c.disableAnalytics) logEmbedEvent(c.apiBaseUrl, c.publicId, 'not_found');
      return;
    }

    renderInto(c.target, c.mode, renderWidget(c.mode, data, c.appBaseUrl));
    if (!c.disableAnalytics) {
      logEmbedEvent(c.apiBaseUrl, c.publicId, data.status === 'REVOKED' ? 'revoked' : 'verified');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Verification failed';
    renderInto(c.target, c.mode, renderError(c.mode, msg));
    if (!c.disableAnalytics) logEmbedEvent(c.apiBaseUrl, c.publicId, 'not_found');
  }
}

/**
 * Auto-init: scan the document for `[data-arkova-credential]` elements
 * and mount a widget at each one. Reads optional data attributes:
 *
 *   data-arkova-credential="ARK-2026-001"   (required)
 *   data-arkova-mode="compact" | "full"     (optional, default "full")
 *   data-arkova-api-base="https://..."      (optional)
 *   data-arkova-app-base="https://..."      (optional)
 *
 * Idempotent: elements already initialized are skipped.
 */
export function autoInit(): void {
  const elements = document.querySelectorAll<HTMLElement>('[data-arkova-credential]');
  elements.forEach((el) => {
    if (el.dataset.arkovaInitialized === 'true') return;
    el.dataset.arkovaInitialized = 'true';

    const publicId = el.dataset.arkovaCredential ?? '';
    const modeAttr = el.dataset.arkovaMode;
    const mode: EmbedMode = modeAttr === 'compact' ? 'compact' : 'full';
    const apiBaseUrl = el.dataset.arkovaApiBase ?? undefined;
    const appBaseUrl = el.dataset.arkovaAppBase ?? undefined;

    void mount({ publicId, target: el, mode, apiBaseUrl, appBaseUrl });
  });
}

// ─── Auto-init on script load ──────────────────────────────────────────────

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    // Defer to next tick so the script tag's siblings have parsed
    setTimeout(autoInit, 0);
  }
}

// ─── Public exports ────────────────────────────────────────────────────────

export type { ArkovaEmbedConfig, AnchorData, EmbedMode } from './types';

const ArkovaEmbed = { mount, autoInit };

// Attach to window for IIFE / UMD consumers
if (typeof window !== 'undefined') {
  (window as unknown as { ArkovaEmbed: typeof ArkovaEmbed }).ArkovaEmbed = ArkovaEmbed;
}

export default ArkovaEmbed;
