# @arkova/embed

> The Arkova embeddable verification widget. Drop a single `<script>` tag on any third-party site and a verification badge appears. Vanilla JavaScript, zero dependencies, CSP-safe, under 15 KB gzipped.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

---

## Quickstart

The shortest path: drop in a div and one script tag.

```html
<!-- 1. The badge will render here -->
<div data-arkova-credential="ARK-2026-001"></div>

<!-- 2. The script auto-mounts every [data-arkova-credential] on page load -->
<script src="https://cdn.arkova.ai/embed.js" defer></script>
```

That's the entire integration. No backend, no SDK, no auth tokens.

---

## How it works

When the script loads, it scans the document for elements with `data-arkova-credential="<publicId>"` and mounts a verification badge inside each one. The badge fetches the credential's public verification data from `https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/{publicId}` (CORS-enabled, no API key needed) and renders one of three states:

| State | When |
|---|---|
| **Loading** | Initial render while the fetch is in flight |
| **Verified** ✓ | `verified: true` and status is `ACTIVE` |
| **Revoked** ⊘ | Status is `REVOKED` |
| **Not Found** ✕ | 404 or other error |

Every render is a single HTMLElement subtree built with inline styles — no `<style>` blocks, no external fonts, no images, no React. The widget is CSP-safe by construction.

---

## Render modes

### Full (default)

```html
<div data-arkova-credential="ARK-2026-001" data-arkova-mode="full"></div>
```

A 384px-wide card with a status header, document/issuer/type/secured-date detail rows, the truncated fingerprint, and a "Full verification details →" link to `app.arkova.ai/verify/{publicId}`.

### Compact

```html
<div data-arkova-credential="ARK-2026-001" data-arkova-mode="compact"></div>
```

A 320px single-line badge showing just status icon + label + filename + Arkova brand. Ideal for inline contexts (signature lines, footer rows, page headers).

---

## Configuration via data attributes

| Attribute | Required | Default | Description |
|---|---|---|---|
| `data-arkova-credential` | ✅ | — | Anchor public ID, e.g. `ARK-2026-001` |
| `data-arkova-mode` | ❌ | `full` | `compact` or `full` |
| `data-arkova-api-base` | ❌ | production worker URL | Override the API base (staging, local) |
| `data-arkova-app-base` | ❌ | `https://app.arkova.ai` | Override the app base for the "full details" link |

---

## Manual mounting (for SPAs and dynamic content)

If your app injects credentials after page load — common in React/Vue/Svelte apps — call `ArkovaEmbed.mount()` directly:

```html
<script src="https://cdn.arkova.ai/embed.js"></script>
<script>
  ArkovaEmbed.mount({
    publicId: 'ARK-2026-001',
    target: document.getElementById('badge-container'),
    mode: 'full',
  });
</script>
```

The auto-init pass is idempotent — once an element is mounted, it carries `data-arkova-initialized="true"` and is skipped on subsequent scans, so calling `ArkovaEmbed.autoInit()` again after appending new elements is safe.

### React example

```tsx
import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    ArkovaEmbed?: { mount: (config: any) => Promise<void> };
  }
}

export function ArkovaBadge({ publicId }: { publicId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && window.ArkovaEmbed) {
      window.ArkovaEmbed.mount({ publicId, target: ref.current, mode: 'full' });
    }
  }, [publicId]);
  return <div ref={ref} />;
}
```

Add the `<script src="https://cdn.arkova.ai/embed.js"></script>` to your `index.html` and you're done.

### Vue example

```vue
<template>
  <div ref="badgeRef"></div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
const badgeRef = ref(null);
const props = defineProps({ publicId: String });

onMounted(() => {
  window.ArkovaEmbed?.mount({
    publicId: props.publicId,
    target: badgeRef.value,
    mode: 'full',
  });
});
</script>
```

---

## Programmatic API

Imported directly via npm (`@arkova/embed`) or accessed at `window.ArkovaEmbed`:

```typescript
import { mount, autoInit } from '@arkova/embed';
import type { ArkovaEmbedConfig, AnchorData, EmbedMode } from '@arkova/embed';

await mount({
  publicId: 'ARK-2026-001',
  target: document.getElementById('badge')!,
  mode: 'full',                     // 'compact' | 'full'
  apiBaseUrl: 'https://...',        // optional override
  appBaseUrl: 'https://...',        // optional override
  disableAnalytics: false,          // optional, default false
});

// Or scan the document manually after injecting new elements
autoInit();
```

### Types

```typescript
interface ArkovaEmbedConfig {
  publicId: string;
  mode?: 'compact' | 'full';
  target?: HTMLElement;
  apiBaseUrl?: string;
  appBaseUrl?: string;
  disableAnalytics?: boolean;
}

interface AnchorData {
  verified: boolean;
  status: string;
  issuer_name?: string | null;
  credential_type?: string | null;
  anchor_timestamp?: string | null;
  network_receipt_id?: string | null;
  record_uri?: string | null;
  filename?: string | null;
  fingerprint?: string | null;
  public_id?: string | null;
  error?: string | null;
}
```

---

## Distribution

The bundle is built three ways and served from `https://cdn.arkova.ai`:

| File | Purpose | Use when |
|---|---|---|
| `embed.iife.js` | IIFE, attaches `window.ArkovaEmbed` | Plain `<script>` tag (recommended for direct embedding) |
| `embed.es.js` | ES module | Modern bundlers (Vite, Webpack, esbuild) importing `@arkova/embed` |
| `embed.umd.js` | UMD | Legacy bundlers and AMD/CommonJS environments |

Source maps (`.map`) are published alongside each bundle for debugging.

**Bundle size budget:** under 15 KB gzipped. Verified in CI.

---

## Cross-origin and CSP

The widget is designed to drop into hostile environments without breaking:

- **CORS:** the public verification API allows wildcard origins for read-only verify calls.
- **CSP `script-src`:** the bundle is served from `cdn.arkova.ai` — add it to your `script-src` allowlist.
- **CSP `connect-src`:** add `arkova-worker-270018525501.us-central1.run.app` (or your custom `apiBaseUrl`).
- **CSP `style-src`:** **no allowlist change needed.** The widget uses inline `style="..."` attributes only — no `<style>` blocks, no `style-src 'unsafe-inline'` requirement *if* the inline style attribute hash is allowlisted. Most sites already allow inline style attributes.
- **No external fonts.** The widget uses the `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...` system font stack.
- **No images, no link tags, no eval.** Verified in test (`CSP / inline-style safety` suite).

---

## Analytics

Each successful render fires a `method=embed` verification event so org admins can see usage in the Arkova dashboard. The fetch is `keepalive: true` and any failure is silently swallowed — analytics never block the widget render. Pass `disableAnalytics: true` to opt out:

```html
<div data-arkova-credential="ARK-2026-001" data-arkova-disable-analytics></div>
```

(or `mount({ ..., disableAnalytics: true })` for manual mounting.)

---

## Styling and customization

The widget renders fully styled with inline CSS — there are no external stylesheets to override. If you need custom colors or layout, host your own copy:

1. `git clone` the Arkova monorepo
2. Edit `packages/embed/src/styles.ts`
3. `pnpm --filter @arkova/embed build`
4. Self-host the resulting `dist/embed.iife.js`

The widget surface is intentionally minimal so the design stays consistent across every site that embeds it (which is the whole point of "every badge is a backlink"). For deeply branded experiences, render the badge inside your own card and use it as a status pill.

---

## Frequently asked questions

**Does the badge phone home with my visitors' data?**
No. It fetches the public verification record by ID and (optionally) logs a `method=embed` event with no PII. It does not set cookies, does not load fingerprinting libraries, and does not send referrer headers beyond what the browser does by default.

**Can I render multiple badges on one page?**
Yes. Each `[data-arkova-credential]` element is mounted independently. There's no global state.

**What if my site uses a strict CSP?**
You'll need to allowlist `cdn.arkova.ai` in `script-src` and `arkova-worker-270018525501.us-central1.run.app` in `connect-src`. The widget itself is `unsafe-eval`-free and avoids `<style>` blocks.

**Can I use this in a Shadow DOM?**
Yes. Pass a target inside an open shadow root:

```typescript
const shadow = host.attachShadow({ mode: 'open' });
const target = document.createElement('div');
shadow.appendChild(target);
ArkovaEmbed.mount({ publicId: 'ARK-2026-001', target });
```

**How do I rotate the credential displayed?**
Either change the `data-arkova-credential` attribute (then call `ArkovaEmbed.autoInit()`), or call `mount()` again with the new ID — the previous content is cleared automatically.

---

## License

MIT © Arkova

## See also

- [@arkova/sdk](../sdk) — TypeScript SDK for the Arkova verification API
- [docs/api/webhooks.md](../../docs/api/webhooks.md) — Webhook CRUD developer guide
- [docs/api/README.md](../../docs/api/README.md) — Full API documentation index
