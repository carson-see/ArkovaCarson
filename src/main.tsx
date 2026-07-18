/**
 * Arkova Application Entry Point
 *
 * Sentry is initialized BEFORE React renders to capture all errors.
 * PII scrubbing is mandatory (Constitution 1.4 + 1.6).
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { registerArkovaWebMcpOnPage } from './webmcp';
import './index.css';

// Render React FIRST for fastest possible first paint.
// Sentry initialization is deferred to after the first frame renders,
// so the browser paints the UI before loading error-tracking overhead.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// WebMCP is progressive enhancement; unsupported browsers continue normally.
const webMcpController = registerArkovaWebMcpOnPage();
if (webMcpController) {
  window.addEventListener('pagehide', () => webMcpController.abort(), { once: true });
}

// Defer Sentry init — PII scrubbing enabled, sendDefaultPii=false
// Uses requestIdleCallback (with 2s fallback) so it never blocks rendering.
const initSentryDeferred = () => import('./lib/sentry').then(m => m.initSentry());
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => initSentryDeferred());
} else {
  setTimeout(() => initSentryDeferred(), 2000);
}
