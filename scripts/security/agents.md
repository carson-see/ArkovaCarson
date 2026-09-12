# scripts/security/agents.md

Security scanning scripts for dependency and license compliance.

## 2026-09-12 — PR #2839 moved the `@img/sharp-*` band to 1.3.3 / 0.35.4 (SCRUM-4988)

The root `sharp: 0.35.4` override (Trivy CVE bump, Sekura Phase 2) pulled `@img/sharp-libvips-*@1.3.3`
and `@img/sharp-{wasm32,win32-*}@0.35.4` into the production band and, because npm dedupes wrangler's
nested copy onto the override, deleted the miniflare-only 1.3.1 / 0.35.2 band entirely. Both exact-match
gates went red on the PR (`security:license-denylist` inside the `sonatype-sca` job, and
`notices-freshness`). Resolution, in the order the gate design requires: allowlist entries re-versioned
1.2.4→1.3.3 / 0.34.5→0.35.4 with the NOT-DISTRIBUTED rationale unchanged and the 1.3.1/0.35.2 entries
removed (no lockfile row references them); the 14 pinned notices re-versioned the same way; THEN
`npm run license:notices:generate`. Regenerating first would have exited 0 while silently dropping the
new LGPL versions from the copyleft block — the generator prints a "Skipped copyleft dependencies with
no allowlist entry" warning, it does not fail. A `sharp` bump is an allowlist+pinned change, not a
lockfile change.

## 2026-08-31 — `thirdPartyNotices.generated.json` carries ONE hand-inserted entry, because the generator cannot run

Historical incident: the following failure and manual insertion describe the pre-fix state. The resolved coverage and required freshness check under Files and Conventions describe current behavior; successful generation now reproduces the QR dependency entry. Preserve the incident evidence, but do not follow its obsolete manual-edit guidance.

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
- **`generate-third-party-notices.ts`** — generates `src/data/thirdPartyNotices.generated.json`, the data source for the shipped `/legal/third-party-notices` page. Run via `npm run license:notices:generate`. Merges a real `license-checker` scan of the root (frontend) production dependency tree with hand-curated entries in `third-party-notices.pinned.json`. Any dependency whose license matches `GPL_DENYLIST` is EXCLUDED from the general list unless it has a `license-denylist.allowlist.json` entry — fail-safe, so the notices page can't silently drift ahead of or behind the compliance gate. **CI-gated since 2026-08-30:** `scripts/ci/check-third-party-notices-fresh.ts` re-runs the composition on every PR and fails when the committed file no longer matches the dependency set — before that nothing invoked this generator in CI at all, and the file drifted for over a month unnoticed (see that script and `scripts/ci/agents.md`). The composition is exported as `buildNotices()` so the gate reuses this exact code path instead of re-deriving it; `main()` is a thin wrapper over it and CLI behaviour is unchanged. `buildNotices()` RETURNS `missingNotice` rather than throwing, so the freshness question stays answerable while a pinned-notice FATAL is outstanding. Since SCRUM-3559 each entry also carries `copyright` + verbatim `licenseText` from the package's published license file (license-checker `customFormat` for copyright; the text is re-read from `licenseFile` because the programmatic `licenseText` value is newline-flattened). `attachVerbatimLicenseTexts` is AUTHORITATIVE: license-checker's licenseFile detection falls back to package READMEs, and a README must never ship as "license text", so rows without a real license/COPYING/NOTICE file get both fields stripped (`licenseFileLooksLikeLicense`). Pinned entries are enriched the same way when the package is installed; the `@img/sharp-*` platform binaries publish no license file (verified against the published `linux-x64` / `linuxmusl-x64` / `darwin-arm64` tarballs), so they stay links-only — which is also what keeps the enriched `copyleftDependencies` block byte-identical across a darwin laptop and an ubuntu runner, as the freshness gate's exact-string comparison of that block requires.
- **`generate-third-party-notices.test.ts`** — colocated tests: classification (`classifyEntries`), the README-fallback guard (`licenseFileLooksLikeLicense` / `attachVerbatimLicenseTexts`), and a lockfile-driven coverage test that fails when any allowlisted, production-reachable copyleft dep lacks a pinned notice (SCRUM-3553 regression class — platform-independent, unlike the generator's own FATAL which only sees the packages installed on the machine running it).
- **`third-party-notices.pinned.json`** — hand-curated notice entries that need to ship before (or with more detail than) an automated scan of the currently-installed tree can produce on its own. Currently: `libheif-js`, `jszip`, and the 14 production-band `@img/sharp-*`/`@img/sharp-libvips-*` platform binaries (inert, NOT distributed — disclosed for transparency; their statusNotes carry the CTO-review rationale).
- **`vendor-heic-chunk-isolation.ts`** / **`.test.ts`** — static guard for the `vite.config.ts` `manualChunks` engineering rule below.

## Conventions
- Denylist regex: `/\b(?:AGPL|LGPL|GPL|SSPL)(?:[-\s]?(?:v?\d+...)?)?\b/i`. **2026-07-28 fix:** the pre-fix pattern was `/\b(?:AGPL|GPL|SSPL).../` — `\b` requires a word boundary immediately before the match, and "LGPL-3.0" has "L" (a word char) right before "GPL", so no boundary exists there and the whole license string went undetected. `libheif-js@1.19.8` (LGPL-3.0) is what surfaced this (engineering-counsel review). Regression-covered in `license-denylist.test.ts`.
- Allowlisted packages must include a `reason` field explaining why they are safe.
- Run as a CI gate (`npm run security:license-denylist`) to block PRs introducing copyleft dependencies.
- **A copyleft dependency can be pre-cleared before it's actually installed** — but `libheif-js` is NOT such a case. **Correction (2026-08-01):** this bullet previously read "`libheif-js@1.19.8` is allowlisted even though it isn't in `main`'s lockfile yet ... ships via the in-development decode path (PR #1740, not yet merged)". That was false. `heic-decode@2.1.0` is a **production dependency** in the root `package.json`, `libheif-js@1.19.8` is in `package-lock.json`, and `src/lib/ocrWorker.ts` dynamically imports it (`loadHeicDecode`) from the live OCR path. **It ships today.** The consequences were real, not cosmetic: the `/legal/third-party-notices` page rendered an "In development — not yet shipped" badge for a component we actually distribute (disclaiming a live LGPL/attribution obligation — the dangerous direction for an R-7 claims-gate error), and the chunk-isolation rule below was recorded as satisfied when it was not implemented at all. Both are fixed; the pinned notice entry is now `status: "active"`.
- **RESOLVED (2026-08-30, was the 2026-07-28 "known open finding"): `@img/sharp-*` / `@img/sharp-libvips-*` (LGPL-3.0-or-later family)** — the transitive `sharp` platform binaries pulled in by `@huggingface/transformers`. Both halves are now closed: (1) allowlist entries with full NOT-DISTRIBUTED rationale landed via CTO review 2026-08-11 (see `license-denylist.allowlist.json` — the shipped browser build stubs `sharp` out; verified by build-and-grep of the emitted artifact), so `npm run security:license-denylist` is green; (2) every allowlist-cleared, production-reachable `@img/*` package@version now has a pinned notice entry in `third-party-notices.pinned.json` (SCRUM-3553), so `npm run license:notices:generate` no longer FATALs on the jszip-class regression guard. The 1.3.1/0.35.2 band in the lockfile was dev-only (via miniflare) — `license-checker --production` never saw it, so it was deliberately NOT pinned; **superseded 2026-09-12 (SCRUM-4988): that band no longer exists — npm deduped miniflare's nested copy onto the root `sharp: 0.35.4` override, so the whole tree is 1.3.3 / 0.35.4 and the allowlist/pinned files name only those.** the coverage test in `generate-third-party-notices.test.ts` reconstructs the production lockfile set and fails if a new allowlisted copyleft dep lands unpinned on ANY platform. The FATAL itself is correct behaviour — fix a future recurrence by ADDING pinned entries, never by weakening the check.
  **Open design tension, recorded rather than papered over.** The `missingNotice` FATAL exists because an allowlist-cleared copyleft dep excluded from the general list would otherwise get NO attribution anywhere (the `jszip` bug). But the allowlist rationale for the `@img/sharp-*` binaries is that we do not distribute them at all, and no attribution is owed for code we do not ship — so a pinned notice for a non-distributed binary asserts a disclosure in the opposite direction. SCRUM-3553 resolved the FATAL the safe way, by disclosing them for transparency with the NOT-DISTRIBUTED rationale in each `statusNote`. A cleaner long-term model is a third state (allowlist-cleared AND no notice owed, recorded explicitly) rather than a hand-written notice; that remains a counsel/CTO call. Do not resolve it by editing the allowlist without that review, and never by weakening the FATAL.
- **Drift baseline is retired (2026-09-02).** `scripts/ci/snapshots/third-party-notices-drift-baseline.json` now carries empty `driftingNames` and `blockedPinnedNotices`, so the freshness gate is an exact assertion. Do not repopulate it to get a PR green — regenerate the notices file, or add the missing pinned notice.

## Engineering rule: `vendor-heic` chunk isolation (counsel LGPL review, 2026-07-28)
Any module belonging to `heic-decode` or its dependency `libheif-js` (LGPL-3.0) MUST resolve to its own isolated, lazily-loaded Vite chunk (conventionally `vendor-heic`) in `vite.config.ts`'s `manualChunks` — never folded into a shared vendor chunk that also ships in the initial bundle. The LGPL-3.0 compliance position recorded in `license-denylist.allowlist.json` and disclosed at `/legal/third-party-notices` depends on this holding: it's what lets us ship an unmodified wasm bundle without triggering LGPL's main-program relinking obligation. `vite.config.ts` implements this as a live `manualChunks` branch, placed BEFORE the broader vendor branches so a heic module cannot be captured by one of them first:

```ts
if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-heic';
```

**The branch was missing until 2026-08-01** — `vite.config.ts` carried only a comment telling a future author to add it, so the compliance position recorded in `license-denylist.allowlist.json` and disclosed publicly rested on a bundling fact that was not true.

`vendor-heic-chunk-isolation.test.ts` statically asserts `vite.config.ts` honors the rule. **That guard used to be unfalsifiable:** it parsed only `vite.config.ts`, so "no heic branch" was interpreted as "dependency not in the tree yet — vacuously satisfied" and returned GREEN, which is precisely the violating state. `assertHeicChunkIsolated` now takes a `dependencyInstalled` flag (from `isHeicDependencyInstalled()`, which reads `package.json` + `package-lock.json`) and FAILS when the dependency ships without an isolation branch. The real-config test asserts `installed === true` first, so if the dependency is ever dropped the suite says so loudly instead of silently going vacuous again.

## Historical finding preserved for append-only continuity

The following two paragraphs record the pre-fix state on 2026-08-30. The resolved finding above describes this candidate; these historical paragraphs are retained verbatim so the merge batch preserves the original review context.

- **Known open finding, RESTATED 2026-08-30: `@img/sharp-libvips-*` (LGPL-3.0-or-later)** — a transitive optional dependency of `sharp` (itself pulled in by the root `@huggingface/transformers` dependency), present in `package-lock.json` today and caught by the fixed regex. **The 2026-07-28 wording of this bullet is now false and is corrected here:** it said the package "has NO allowlist entry" and that `npm run security:license-denylist` "fails on `main` until Carson/counsel triages it". Both were overtaken by the 2026-08-11 CTO review, which allowlisted every `@img/sharp-libvips-*` / `@img/sharp-win32-*` / `@img/sharp-wasm32` platform variant at both 1.2.4 and 1.3.1 with a NOT-DISTRIBUTED rationale proven by building the artifact. The denylist gate passes.
  **What actually failed at the time was the notices GENERATOR** (resolved 2026-09-02 by SCRUM-3553/3559 — the generator writes again; kept below as incident evidence, not current state), and it is a different failure with a different fix: an allowlist-cleared copyleft dep whose notice text is missing from `third-party-notices.pinned.json` trips the `missingNotice` FATAL, so `npm run license:notices:generate` exits 1 and writes NOTHING (verified 2026-08-30 on darwin: `@img/sharp-libvips-darwin-arm64@1.2.4`; an ubuntu runner reports `@img/sharp-libvips-linux-x64@1.2.4`, the same gap under a different platform name). Note the tension to resolve rather than paper over: the FATAL exists because an allowlisted copyleft dep excluded from the general list would otherwise get NO attribution anywhere (the `jszip` bug), but the allowlist rationale for these particular packages is that we do not distribute them at all — and no attribution is owed for code we do not ship. Adding a pinned notice for a non-distributed binary asserts a disclosure in the opposite direction. The likely correct fix is a third state (allowlist-cleared AND no notice owed, recorded explicitly), not a hand-written notice; that is a counsel/CTO call, tracked by the "Regenerate third-party notices (blocked by sharp)" task. Do not resolve it by editing the allowlist without that review.
