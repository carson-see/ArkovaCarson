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
