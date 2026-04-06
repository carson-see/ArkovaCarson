/**
 * Arkova Embeddable Verification Widget (MVP-14 / SCRUM-91)
 *
 * Drop-in script for third parties to embed credential verification.
 *
 * Usage:
 *   <div id="arkova-verify" data-public-id="ARK-UMICH-DOC-A1B2C3"></div>
 *   <script src="https://app.arkova.ai/embed.js"></script>
 *
 * Options (data attributes on the container):
 *   data-public-id  — Required. The credential public ID to verify.
 *   data-mode       — "full" (default) or "compact"
 *   data-theme      — "light" (default) or "dark"
 *
 * The widget renders inside the container element as an iframe
 * pointing to /embed/verify/:publicId on the Arkova domain.
 */
(function () {
  'use strict';

  var ARKOVA_BASE = 'https://app.arkova.ai';

  // Find all widget containers
  var containers = document.querySelectorAll('[data-arkova-verify], #arkova-verify');

  for (var i = 0; i < containers.length; i++) {
    var el = containers[i];
    var publicId = el.getAttribute('data-public-id');
    if (!publicId) continue;

    var rawMode = el.getAttribute('data-mode') || 'full';
    var rawTheme = el.getAttribute('data-theme') || 'light';

    // Validate mode/theme against allowed values to prevent injection
    var mode = rawMode === 'compact' ? 'compact' : 'full';
    var theme = rawTheme === 'dark' ? 'dark' : 'light';

    var iframe = document.createElement('iframe');
    iframe.src = ARKOVA_BASE + '/embed/verify/' + encodeURIComponent(publicId) + '?mode=' + encodeURIComponent(mode) + '&theme=' + encodeURIComponent(theme);
    iframe.style.border = 'none';
    iframe.style.width = '100%';
    iframe.style.height = mode === 'compact' ? '60px' : '280px';
    iframe.style.maxWidth = '480px';
    iframe.style.borderRadius = '8px';
    iframe.style.overflow = 'hidden';
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('title', 'Arkova Credential Verification');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

    el.innerHTML = '';
    el.appendChild(iframe);
  }
})();
