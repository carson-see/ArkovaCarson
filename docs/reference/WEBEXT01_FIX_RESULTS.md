# WEBEXT-01-FIX — F-1/F-2 browser-real proof (gate #13 success half)

_Sprint 3 / S3-E, Lane 1. Captured 2026-07-06 on branch `lane1/s3-webext01-fix-vendor-esm` (base: `origin/main` @ `f927494e`). Fixes the two bugs the re-gate evidence PR #1409 (`docs/reference/WEBEXT01_REGATE_EVIDENCE.md` on `lane1/s3-webext01-regate-evidence`) proved: F-1 (bare-specifier vendored bundle — NER dead-on-arrival in every browser) and F-2 (ort `wasmPaths` jsdelivr default — CSP-blocked WASM fetch). Internal engineering notes; the auditable record is the Confluence story page._

**Evidence-tag legend** (same as PR #1409): `VERIFIED(test-run)` = executed in this session, output quoted; `VERIFIED(browser-real)` = observed in real headless Chromium (Playwright 1.61.1, this session); `NOT RUN(reason)` = stated honestly.

---

## 0. The fix

| Bug | Root cause | Fix |
|---|---|---|
| **F-1** (P1, was live in prod) | `public/vendor/transformers.web.min.js` (= the package's `.web.` build) contains TOP-LEVEL BARE SPECIFIERS `onnxruntime-web/webgpu` + `onnxruntime-common`; production loads it via native `import('/vendor/…')` with no import map → module LINKING throws `TypeError: Failed to resolve module specifier` on every load | **Approach (a)** — `@huggingface/transformers@4.2.0` ships a genuinely SELF-CONTAINED browser build: `dist/transformers.min.js` (onnxruntime inlined, ZERO bare static specifiers — verified by the new scanner). Vendored byte-for-byte as `public/vendor/transformers.bundle.min.js` (committed, 558,373 B, SHA-256-locked in `scripts/ner-runtime.lock.json`). The `.web.` bundle is deleted. No esbuild rebuild needed (approach (b) not required); no import map touched. |
| **F-2** (latent) | With `wasmPaths` unset, onnxruntime-web defaults to `https://cdn.jsdelivr.net/npm/onnxruntime-web@<ver>/dist/` — blocked by deployed CSP `connect-src 'self'` | ort WASM artifacts vendored same-origin under `public/vendor/ort/` (git-ignored; copied at build time from the exact npm-pinned `onnxruntime-web@1.26.0-dev.20260416-b7804b056c` by `scripts/vendor-ner-runtime.ts`, hash-locked): `ort-wasm-simd-threaded.asyncify.wasm` (23,567,050 B) + `.asyncify.mjs` (47,389 B) — the flavor the pinned 4.2.0 bundle requests. `src/lib/nerPiiDetector.ts` pins `env.backends.onnx.wasm.wasmPaths = ORT_WASM_VENDOR_PATH ('/vendor/ort/')` BEFORE `pipeline(...)`, and fails CLOSED (typed, pipeline never invoked) if the runtime exposes no ort wasm env to pin. |
| **F-3** (NEW — found by this fix's browser-real probe) | The 4.2.0 browser pipeline emits `{entity, score, index, word}` — **no start/end character offsets**. `mergeEntities` copied `undefined` through; `redactNEREntities` then sliced with `undefined` → text duplicated 2^n times **with all PII still present**. Invisible on main (F-1 blocked NER before inference could ever run); would have gone LIVE the moment F-1/F-2 merged | `mergeEntities` now COMPUTES spans against the input text (exact-match with advancing cursor, then token-by-token walk; pipeline-provided offsets still honored when structurally valid). `redactNEREntities`: positional redaction for valid spans; literal-text redaction fallback; **THROWS (fail closed, no PII in the message) when a detected entity cannot be located at all** — never silently returns text containing PII the model found. |

Guard updates: `scripts/ci/check-csp-runtime-deps.ts` now (1) scans `VENDORED_RUNTIME_ESM` for static bare specifiers / off-origin URL imports (dynamic Node-builtin imports behind env guards — the emscripten pattern — are allowed) and fails on a MISSING bundle; (2) `checkOrtWasmPathsPinned` asserts the loader pins `wasmPaths` same-origin. `scripts/vendor-ner-runtime.ts` refuses at VENDORING time to copy or lock any ESM artifact with bare specifiers. `scripts/vendor-transformers-version.test.ts` re-pointed at the new bundle; extractor hardened. Loader contract untouched: `allowRemoteModels=false`, `allowLocalModels=true`, `localModelPath='/models/'`, pinned revision `24c7e5ab…`, `dtype q8`, typed `NERModelLoadError`, regex-only ONLY on explicit `enableNER:false`.

## 1. Browser-real probe — method

Appendix-A harness from PR #1409 reproduced (untracked `probe-evidence/`: `probe-entry.ts` bundling the UNCHANGED-API real `src/lib/{enhancedPiiStripper,nerPiiDetector,ocrFailClosed}` modules with the `/vendor/…` import kept external/native exactly as the built `dist/assets/fraudDetection-*.js` chunk; `serve.mjs` serving the production `dist/` + probe page with the **byte-exact deployed CSP read live from `vercel.json`**; `drive.ts` Playwright driver). Deltas vs #1409: bundle path `/vendor/transformers.bundle.min.js`; the driver additionally records entity spans (`spanMatchesText`), the consumer `strippedText`, and load/cold/warm latency; phase order runs `detectPIIWithNER` twice then `stripPIIEnhanced(sample, { forceBackend:'wasm', enableNER:true })`.

Sample (synthetic, no real PII): `John Smith received his engineering credential from Microsoft in Seattle. Maria Garcia, who lives in Barcelona, verified the document for Acme Corporation.`

## 2. Browser-real results — VERIFIED(browser-real), 2026-07-06, headless Chromium (Playwright 1.61.1)

Raw JSON: [`webext01-fix-evidence/evidence-results.json`](./webext01-fix-evidence/evidence-results.json). Screenshots: [`control`](./webext01-fix-evidence/control_noCsp_weightsPresent.png) · [`phase A`](./webext01-fix-evidence/phaseA_deployedCsp_weightsPresent.png) · [`phase B`](./webext01-fix-evidence/phaseB_deployedCsp_weightsAbsent.png).

| Phase | Setup | Outcome |
|---|---|---|
| CONTROL | no CSP, weights present | **LOADS + INFERS** — 6 entities, load 872 ms, cold 172 ms, warm 115 ms |
| A | **deployed CSP**, weights present | **LOADS + INFERS** — load 494 ms, cold 145 ms, warm 116 ms; **0 CSP violations**; **0 off-origin requests**; 6/6 entities with `spanMatchesText: true`; consumer `strippedText` fully redacted; `nerUsed: true`, `redactionCount: 6`; same-origin `/models/...` fetch 200 |
| B | deployed CSP, weights ABSENT (`/models/*` → 404) | typed `NERModelLoadError`; `isPiiStripFailClosedError=true`, `isNerModelLoadError=true`; cause = `` `local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at "/models/Xenova/bert-base-NER/config.json" `` — **DISTINCT from F-1's link error** (`Failed to resolve module specifier`); 0 CSP violations; 0 off-origin |

Gate-#13 success criteria, each: **(i) zero CSP violations — VERIFIED** (all 3 phases, `securitypolicyviolation` collector); **(ii) model LOADS — VERIFIED** (phases CONTROL+A); **(iii) inference RETURNS entity spans — VERIFIED** (phase A: `John Smith` PER 0.999 [0,10], `Microsoft` ORG 0.999 [52,61], `Seattle` LOC 0.999 [65,72], `Maria Garcia` PER 1.0 [74,86], `Barcelona` LOC 0.999 [101,110], `Acme Corporation` ORG 0.807 [138,154] — subword-merged, spans verified against the source text); **(iv) zero off-origin network requests — VERIFIED** (every request across all phases hit only the probe origin; phase-A request list: probe page/bundle, `/vendor/transformers.bundle.min.js`, `/models/...` ×5, `/vendor/ort/ort-wasm-simd-threaded.asyncify.mjs`, `/vendor/ort/ort-wasm-simd-threaded.asyncify.wasm` — both ort artifacts fetched SAME-ORIGIN, proving the F-2 pin drives the real fetch path); **(v) weights-absent still yields the typed fail-closed error, distinct from the link error — VERIFIED** (phase B). Zero `/api/v1/ai/extract` requests in every phase (no metadata egress).

Phase A stripped output (consumer path, production modules): `[PERSON_REDACTED] received his engineering credential from [ORG_REDACTED] in [LOCATION_REDACTED]. [PERSON_REDACTED], who lives in [LOCATION_REDACTED], verified the document for [ORG_REDACTED].`

**F-3 pre-fix capture (browser-real, this session):** with only F-1/F-2 fixed, the same probe returned entities with `start/end` ABSENT and `strippedText` = the sample duplicated ~64× with every name/org/location intact — the §1.6 leak shape that motivated the in-lane F-3 fix. Post-fix output is the fully-redacted line above.

## 3. Latency

| Environment | Load | Cold inference | Warm inference | Tag |
|---|---|---|---|---|
| Browser (headless Chromium, wasm, deployed CSP — phase A) | 494 ms | 145 ms | 116 ms | VERIFIED(browser-real) |
| Browser (control, no CSP) | 872 ms | 172 ms | 115 ms | VERIFIED(browser-real) |
| Node (onnxruntime-node, same pinned weights, this session) | 318 ms | 14 ms | 8 ms | VERIFIED(test-run) |
| Node (evidence doc #1409 §7, for comparison) | 721 ms | 52 ms | 15 ms | (prior session) |

## 4. Test / build state — VERIFIED(test-run), 2026-07-06

- §1.6 cluster (10 files: `piiStripper`, `piiStripper.adversarial`, `ocrWorker`, `nerPiiDetector`, `enhancedPiiStripper`, `ocrFailClosed`, `check-csp-runtime-deps`, `fetch-ner-model`, `vendor-transformers-version`, **new `vendor-ner-runtime`**): see PR body for the verbatim final counts (re-run at head).
- `e2e/extraction-csp-fail-closed.spec.ts`: **3/3 passed** in real Chromium under the byte-exact deployed CSP (scratch config dropping only the authed `setup` dependency, as in #1409 §5a).
- `npm run build` exit 0. Asset budget: the runtime stays OUT of the homepage chunk — the native `import('/vendor/transformers.bundle.min.js')` lives only in the lazy `dist/assets/fraudDetection-*.js` chunk (24,601 B); `dist/assets/index-*.js` (166,032 B) has 0 references. Vendored sizes: bundle 558,373 B (committed; replaces the broken 431,652 B `.web.` file), ort wasm 23,567,050 B + mjs 47,389 B (git-ignored, prebuild-vendored, lazy-fetched only when NER runs).

## 5. Remaining gaps (honest)

- Prod is fixed only when THIS PR deploys; the live site still serves the F-1 bundle until then.
- Browser latency above is headless Chromium on a dev machine, single-threaded wasm (no `crossOriginIsolated`); real-user numbers will vary.
- F1-vs-eval-set metric still NOT CAPTURED — no labeled §1.6 PII corpus exists in-repo (unchanged from #1409 §7).
- The authed drag-drop upload UI path under prod CSP remains untested (needs an authed staging/preview environment — #1409 §8); the probe exercises the production modules directly.

_Last refreshed: 2026-07-06 by Lane 1 S3-E fix session — claims verified against in-session vitest/build/Playwright output quoted above; no prod/staging state asserted._
