# scripts/security/agents.md

Security scanning scripts for dependency and license compliance.

## 2026-08-31 — `thirdPartyNotices.generated.json` carries ONE hand-inserted entry, because the generator cannot run

`npm run license:notices:generate` currently **fails closed**:

```
FATAL: allowlist-cleared copyleft dependencies have no entry in third-party-notices.pinned.json,
so they would receive NO attribution on /legal/third-party-notices.
  - @img/sharp-libvips-darwin-arm64@1.2.4 (LGPL-3.0-or-later)
```

That package arrives via the **production** dependency
`@huggingface/transformers -> sharp -> @img/sharp-darwin-arm64` (and again, dev-only,
via `wrangler -> miniflare -> sharp`). It is a **pre-existing** gap — the committed
file is dated `2026-07-28` and nothing in `.github/workflows` or `scripts/ci/`
runs this generator, so nobody noticed it had stopped producing output.

The consequence is not just that the LGPL component is undisclosed: **no new
dependency can be disclosed either**, because the FATAL returns before the file
is written. `qrcode-generator@2.0.4` (MIT, added for the certificate QR, imported
only by `src/lib/certificateQr.ts`) hit exactly that, and MIT attribution is not
optional.

So its entry was inserted **by hand** into `generalDependencies`, using the exact
values `license-checker` reports and the exact sort position the generator would
choose (`'qrcode-generator'.localeCompare('qrcode.react') === -1`). The patch
asserted `json.dumps(indent=2) + '\n'` round-trips the existing file byte-for-byte
first, so the diff is the six inserted lines and nothing else. **The next
successful regeneration reproduces the identical entry** — this is idempotent,
not a fork.

Rules if you touch this:

- **Do not bypass the FATAL.** It exists because `jszip` — a dependency whose
  allowlist entry records a license *election*, making MIT attribution
  load-bearing — once fell into no bucket and got zero attribution. Silencing it
  recreates that.
- **Do not hand-edit this file as a habit.** One permissive entry with a
  reproducible value is the narrow case. Anything requiring a judgement call
  about a copyleft license belongs in `third-party-notices.pinned.json` after
  counsel review, not here — and note that the pinned file's shape
  (`PinnedCopyleftEntry`: `status`, `unmodified`, `licenseTextUrls`) renders into
  `copyleftDependencies`, so it is the wrong home for an MIT dep regardless.
- **Fixing the sharp gap unblocks everything.** Resolve that, run the generator,
  and this note can go.

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
- **A copyleft dependency can be pre-cleared before it's actually installed** — but `libheif-js` is NOT such a case. **Correction (2026-08-01):** this bullet previously read "`libheif-js@1.19.8` is allowlisted even though it isn't in `main`'s lockfile yet ... ships via the in-development decode path (PR #1740, not yet merged)". That was false. `heic-decode@2.1.0` is a **production dependency** in the root `package.json`, `libheif-js@1.19.8` is in `package-lock.json`, and `src/lib/ocrWorker.ts` dynamically imports it (`loadHeicDecode`) from the live OCR path. **It ships today.** The consequences were real, not cosmetic: the `/legal/third-party-notices` page rendered an "In development — not yet shipped" badge for a component we actually distribute (disclaiming a live LGPL/attribution obligation — the dangerous direction for an R-7 claims-gate error), and the chunk-isolation rule below was recorded as satisfied when it was not implemented at all. Both are fixed; the pinned notice entry is now `status: "active"`.
- **Known open finding (2026-07-28, not yet resolved): `@img/sharp-libvips-*` (LGPL-3.0-or-later)**, a transitive optional dependency of `sharp` (itself pulled in by the root `@huggingface/transformers` dependency), is present in `package-lock.json` TODAY and is newly caught by the fixed regex. It has NO allowlist entry — `npm run security:license-denylist` fails on `main` until Carson/counsel triages it (allowlist with a reason, or resolve the `sharp` dependency chain). Do not allowlist it without that review.

## Engineering rule: `vendor-heic` chunk isolation (counsel LGPL review, 2026-07-28)
Any module belonging to `heic-decode` or its dependency `libheif-js` (LGPL-3.0) MUST resolve to its own isolated, lazily-loaded Vite chunk (conventionally `vendor-heic`) in `vite.config.ts`'s `manualChunks` — never folded into a shared vendor chunk that also ships in the initial bundle. The LGPL-3.0 compliance position recorded in `license-denylist.allowlist.json` and disclosed at `/legal/third-party-notices` depends on this holding: it's what lets us ship an unmodified wasm bundle without triggering LGPL's main-program relinking obligation. `vite.config.ts` implements this as a live `manualChunks` branch, placed BEFORE the broader vendor branches so a heic module cannot be captured by one of them first:

```ts
if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-heic';
```

**The branch was missing until 2026-08-01** — `vite.config.ts` carried only a comment telling a future author to add it, so the compliance position recorded in `license-denylist.allowlist.json` and disclosed publicly rested on a bundling fact that was not true.

`vendor-heic-chunk-isolation.test.ts` statically asserts `vite.config.ts` honors the rule. **That guard used to be unfalsifiable:** it parsed only `vite.config.ts`, so "no heic branch" was interpreted as "dependency not in the tree yet — vacuously satisfied" and returned GREEN, which is precisely the violating state. `assertHeicChunkIsolated` now takes a `dependencyInstalled` flag (from `isHeicDependencyInstalled()`, which reads `package.json` + `package-lock.json`) and FAILS when the dependency ships without an isolation branch. The real-config test asserts `installed === true` first, so if the dependency is ever dropped the suite says so loudly instead of silently going vacuous again.
