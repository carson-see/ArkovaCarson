/**
 * <arkova-verify> — Custom Element wrapper for the Arkova Embed Widget (MVP-14).
 *
 * Usage:
 *   <arkova-verify credential="ARK-2026-001"></arkova-verify>
 *   <arkova-verify credential="ARK-2026-001" mode="compact" theme="dark"></arkova-verify>
 *
 * Attributes:
 *   credential  — required, the public ID of the anchor
 *   mode        — "full" (default) or "compact"
 *   theme       — "light" (default) or "dark"
 *   api-base    — override the verification API base URL
 *   app-base    — override the app verification page base URL
 *   no-analytics — disable embed analytics event logging
 */

import type { ArkovaEmbedConfig, AnchorData, EmbedMode } from './types';
import { renderLoading, renderError, renderWidget } from './render';
import { applyDarkTheme } from './themes';

const DEFAULT_API_BASE = 'https://arkova-worker-270018525501.us-central1.run.app';
const DEFAULT_APP_BASE = 'https://app.arkova.ai';

/** Inline mount for web component — avoids circular dep with index.ts */
async function mountInto(
  target: HTMLElement,
  config: { publicId: string; mode: EmbedMode; apiBaseUrl?: string; appBaseUrl?: string; disableAnalytics?: boolean },
): Promise<void> {
  const apiBase = config.apiBaseUrl ?? DEFAULT_API_BASE;
  const appBase = config.appBaseUrl ?? DEFAULT_APP_BASE;
  const mode = config.mode;

  target.replaceChildren(renderLoading(mode));

  try {
    const url = `${apiBase}/api/v1/verify/${encodeURIComponent(config.publicId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as AnchorData;

    if (data.error || !data.verified) {
      const errEl = renderError(mode, data.error ?? 'Verification failed');
      errEl.dataset.arkovaMode = mode;
      target.replaceChildren(errEl);
      return;
    }

    const widget = renderWidget(mode, data, appBase);
    widget.dataset.arkovaMode = mode;
    target.replaceChildren(widget);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Verification failed';
    const errEl = renderError(mode, msg);
    errEl.dataset.arkovaMode = mode;
    target.replaceChildren(errEl);
  }
}

export class ArkovaVerifyElement extends HTMLElement {
  private _initialized = false;
  private _shadowRoot: ShadowRoot;

  static get observedAttributes(): string[] {
    return ['credential', 'mode', 'theme'];
  }

  constructor() {
    super();
    this._shadowRoot = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    if (!this._initialized) {
      this._initialized = true;
      this._render();
    }
  }

  attributeChangedCallback(): void {
    if (this._initialized) {
      this._render();
    }
  }

  private _render(): void {
    const credential = this.getAttribute('credential');
    if (!credential) {
      this._shadowRoot.innerHTML =
        '<div style="color: #ef4444; font-size: 12px;">Missing credential attribute</div>';
      return;
    }

    const container = document.createElement('div');
    this._shadowRoot.replaceChildren(container);

    const mode: EmbedMode =
      this.getAttribute('mode') === 'compact' ? 'compact' : 'full';
    const theme = this.getAttribute('theme') ?? 'light';
    const apiBase = this.getAttribute('api-base') ?? undefined;
    const appBase = this.getAttribute('app-base') ?? undefined;
    const noAnalytics = this.hasAttribute('no-analytics');

    void mountInto(container, {
      publicId: credential,
      mode,
      apiBaseUrl: apiBase,
      appBaseUrl: appBase,
      disableAnalytics: noAnalytics,
    }).then(() => {
      if (theme === 'dark') {
        applyDarkTheme(container);
      }
    });
  }
}

/** Register the custom element. Idempotent — safe to call multiple times. */
export function registerWebComponent(): void {
  if (
    typeof customElements !== 'undefined' &&
    !customElements.get('arkova-verify')
  ) {
    customElements.define('arkova-verify', ArkovaVerifyElement);
  }
}
