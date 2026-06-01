# packages/embed/src/agents.md

Source code for the `@arkova/embed` verification widget (INT-03 / SCRUM-644).

## Files

- **`index.ts`** — entry point: auto-init scans for `data-arkova-credential` attributes; exposes `window.ArkovaEmbed.mount()`.
- **`web-component.ts`** — `<arkova-verify>` custom element with `credential`, `mode`, `theme`, `api-base` attributes.
- **`render.ts`** — pure rendering functions returning HTMLElement subtrees (loading, error, widget states).
- **`styles.ts`** — CSS-in-JS styles and root card layout.
- **`themes.ts`** — light/dark theme support.
- **`types.ts`** — `ArkovaEmbedConfig`, `AnchorData`, `EmbedMode` interfaces.
- **`report-block.ts`** — renders the verification report detail block.
- **`*.test.ts`** — colocated unit tests for each module.

## Recent Changes

- 2026-05-26 SCRUM-2013: `render.ts` CREDENTIAL_LABELS expanded to include `CPE`, `ACCREDITATION`, `CONTRACT_PRESIGNING`, and `CONTRACT_POSTSIGNING`.

## Conventions

- No external dependencies; Web Crypto + DOM APIs only.
- Pure render functions (no DOM mutation) for testability.
