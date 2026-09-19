# packages/embed/agents.md

`@arkova/embed` — embeddable verification widget (INT-03 / SCRUM-644). Single `<script>` tag for third-party sites.

## Structure
- **`src/`** — widget source: auto-init, manual mount, web component, render, styles, themes.
- **`README.md`** — usage guide for integrators.
- **`vite.config.ts`** — Vite build config; target < 15 KB gzipped.
- **`package.json`** — standalone package, vanilla JS, no runtime dependencies.

## Conventions
- CSP-safe: no inline styles injected at runtime; uses shadow DOM isolation.
- Deployed to CDN via `scripts/deploy-embed-cdn.sh`.
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE`. Listed in `package.json` `files` so it actually ships in the published tarball. See `scripts/security/package-license-files.test.ts`.

## 2026-09-02 — typecheck fix + README CDN accuracy pass
- `npm run typecheck` was red: `src/themes.ts` used `String.prototype.replaceAll` (ES2021)
  against a `tsconfig.json` `lib` capped at `["ES2020", "DOM", "DOM.Iterable"]`, and
  `src/web-component.ts` imported the unused type `ArkovaEmbedConfig`. Fixed by adding
  `"ES2021.String"` to `lib` (no `target` change — `target` stays `ES2020`) and dropping the
  unused import. `npm run typecheck` is clean.
- README pointed every script `src` at `cdn.arkova.ai`, a host with **no DNS record** — nothing
  there resolves. Replaced all six references with `app.arkova.ai` (the host that actually
  serves today) and added an explicit "No CDN exists yet" callout right after the Quickstart
  snippet so integrators don't copy a dead host. `scripts/deploy-embed-cdn.sh` (not owned by
  this package) is the eventual path to a real CDN host; until it exists, self-hosting
  `dist/embed.iife.js` per the "Styling and customization" section is the documented
  alternative to depending on `app.arkova.ai`.

## 2026-09-19 — first-public-release build qualification

- Vite 8's configured `minify: 'esbuild'` path requires its optional `esbuild`
  peer to be installed explicitly. Pin `esbuild` in devDependencies and the
  lockfile; a clean checkout without it fails before emitting any bundle.
- The default verification origin is the stable public gateway `https://api.arkova.ai`
  across manual mounting, the web component, and report-block rendering. Keep the
  three behavioral regressions aligned; `apiBaseUrl` remains an explicit override
  for staging and local development.
