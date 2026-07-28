# scripts/security/agents.md

Security scanning scripts for dependency and license compliance.

## Files
- **`license-denylist.ts`** — scans all `package-lock.json` files for AGPL/GPL/LGPL/SSPL-licensed dependencies. Returns denied matches with package name, version, and license.
- **`license-denylist.test.ts`** — colocated tests for the license scanner.
- **`license-denylist.allowlist.json`** — explicit allowlist for packages with acceptable reasons despite flagged license strings.
- **`package-license-files.test.ts`** — asserts the publishable MIT packages (`packages/sdk`, `packages/verifier`, `sdks/mcp-server`, `packages/embed`, `sdks/langchain-ts`, `packages/arkova-py`) actually ship a `LICENSE` file (present on disk, correct MIT text, and included in the package's published `files`/`license-files` packaging config — a LICENSE that isn't packaged doesn't discharge anything).
- **`generate-third-party-notices.ts`** — generates `src/data/thirdPartyNotices.generated.json`, the data source for the shipped `/legal/third-party-notices` page. Run via `npm run license:notices:generate`. Merges a real `license-checker` scan of the root (frontend) production dependency tree with hand-curated entries in `third-party-notices.pinned.json`. Any dependency whose license matches `GPL_DENYLIST` is EXCLUDED from the general list unless it has a `license-denylist.allowlist.json` entry — fail-safe, so the notices page can't silently drift ahead of or behind the compliance gate.
- **`generate-third-party-notices.test.ts`** — colocated tests for the classification logic (`classifyEntries`).
- **`third-party-notices.pinned.json`** — hand-curated notice entries (currently: `libheif-js`) that need to ship before (or with more detail than) an automated scan of the currently-installed tree can produce on its own.
- **`vendor-heic-chunk-isolation.ts`** / **`.test.ts`** — static guard for the `vite.config.ts` `manualChunks` engineering rule below.

## Conventions
- Denylist regex: `/\b(?:AGPL|LGPL|GPL|SSPL)(?:[-\s]?(?:v?\d+...)?)?\b/i`. **2026-07-28 fix:** the pre-fix pattern was `/\b(?:AGPL|GPL|SSPL).../` — `\b` requires a word boundary immediately before the match, and "LGPL-3.0" has "L" (a word char) right before "GPL", so no boundary exists there and the whole license string went undetected. `libheif-js@1.19.8` (LGPL-3.0) is what surfaced this (engineering-counsel review). Regression-covered in `license-denylist.test.ts`.
- Allowlisted packages must include a `reason` field explaining why they are safe.
- Run as a CI gate (`npm run security:license-denylist`) to block PRs introducing copyleft dependencies.
- **A copyleft dependency can be pre-cleared before it's actually installed.** `libheif-js@1.19.8` is allowlisted even though it isn't in `main`'s lockfile yet — it ships via the in-development client-side HEIC/HEIF decode path (PR #1740, not yet merged). This is intentional: fixing the gate and clearing the known dependency in the same PR means PR #1740 doesn't get blocked by a compliance gap discovered on its own turn.
- **Known open finding (2026-07-28, not yet resolved): `@img/sharp-libvips-*` (LGPL-3.0-or-later)**, a transitive optional dependency of `sharp` (itself pulled in by the root `@huggingface/transformers` dependency), is present in `package-lock.json` TODAY and is newly caught by the fixed regex. It has NO allowlist entry — `npm run security:license-denylist` fails on `main` until Carson/counsel triages it (allowlist with a reason, or resolve the `sharp` dependency chain). Do not allowlist it without that review.

## Engineering rule: `vendor-heic` chunk isolation (counsel LGPL review, 2026-07-28)
Any module belonging to `heic-decode` or its dependency `libheif-js` (LGPL-3.0) MUST resolve to its own isolated, lazily-loaded Vite chunk (conventionally `vendor-heic`) in `vite.config.ts`'s `manualChunks` — never folded into a shared vendor chunk that also ships in the initial bundle. The LGPL-3.0 compliance position recorded in `license-denylist.allowlist.json` and disclosed at `/legal/third-party-notices` depends on this holding: it's what lets us ship an unmodified wasm bundle without triggering LGPL's main-program relinking obligation. `vendor-heic-chunk-isolation.test.ts` statically asserts `vite.config.ts` honors this (vacuously true today since the dependency isn't in the tree yet; becomes a real check once PR #1740 lands).
