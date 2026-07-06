# WEBEXT-01 — §1.6 NER self-host re-gate evidence (gate #13 self-host slice)

_Sprint 3 / S3-E, Lane 1. Captured 2026-07-06 on branch `lane1/s3-webext01-regate-evidence` (base: `origin/main` @ `f927494ed7c92abd4d3b6ceeb1c6ff5a3869a75e`). Internal engineering notes per CLAUDE.md §0.4 — the auditable record is the Confluence story page._

**Evidence-tag legend** — every claim below is tagged one of:

- `VERIFIED(code-cite)` — read directly from the source at the cited file:line on this branch (== origin/main; the stale co-merge comment fix originally carried here was moved to fix PR #1416 so this PR is docs/evidence-only).
- `VERIFIED(test-run)` — a test/build/tool execution performed in this session, output quoted.
- `VERIFIED(browser-real)` — observed in a real headless Chromium (Playwright 1.61.1) in this session.
- `VERIFIED(prod-read)` — read-only GET/HEAD against the live `app.arkova.ai` origin (no writes, no deploy actions).
- `NOT CAPTURED(reason)` — could not be captured in this environment; the exact gap and what is needed are stated.

---

## 0. Executive verdict

| # | Claim | Verdict |
|---|---|---|
| 1 | Loader self-hosts: `allowRemoteModels=false`, `localModelPath='/models/'`, pinned model+revision, pinned transformers.js, vendored bundle | **VERIFIED**(code-cite) |
| 2 | Consumer fail-closed: `enhancedPiiStripper` THROWS typed error, no silent regex fallback except explicit `enableNER:false` | **VERIFIED**(code-cite + test-run) |
| 3 | Deployed CSP contains no HF/jsdelivr/unpkg host; permits `'self'` + `'wasm-unsafe-eval'` | **VERIFIED**(code-cite + prod-read + browser-real) |
| 4 | Prebuild weight fetch + SHA-256 integrity gate works; `public/models/` populated (105 MB); production build succeeds | **VERIFIED**(test-run) |
| 5 | Unit suites green — 169/169 across the 9 NER/PII/OCR/CSP-guard files | **VERIFIED**(test-run) |
| 6 | Repo e2e `extraction-csp-fail-closed.spec.ts` — 3/3 pass in real Chromium (CDN fetches blocked under the byte-exact deployed CSP) | **VERIFIED**(browser-real) |
| 7 | Typed fail-closed hard-block observed with the REAL production modules under the deployed CSP (zero egress, zero off-origin requests) | **VERIFIED**(browser-real) |
| 8 | **Browser model load + inference under deployed CSP (gate step i–ii)** | **NOT CAPTURED — BLOCKED BY NEW FINDING F-1** (see §6: the vendored bundle cannot initialize in ANY browser page today) |
| 9 | Inference latency | **VERIFIED**(test-run, **Node-side only** — browser impossible per F-1) |
| 10 | F1 vs a §1.6 PII eval set | **NOT CAPTURED** (no labeled PII eval corpus exists in-repo) |
| 11 | Worker never imports `generateFingerprint` | **VERIFIED**(test-run grep) |

**Bottom line:** the §1.6 privacy posture (fail-CLOSED, zero egress) is real and held in every browser-real scenario tested. But the re-gate surfaced a previously unknown **P1 functional break (F-1)**: the self-hosted NER runtime cannot initialize in a real browser at all — so the "model loads + infers under CSP" half of gate #13 is not just un-evidenced, it is currently **false in production**. A second latent break (F-2) is queued behind it. Details in §6.

---

## 1. Code verification (VERIFIED: code-cite)

All citations from `src/lib/nerPiiDetector.ts` unless noted. Line numbers are per origin/main `f927494e` — this PR no longer changes any source file (the stale co-merge comment fix originally captured alongside this evidence was moved to fix PR #1416, whose branch reworks the same file with tests).

| Contract | Citation |
|---|---|
| `env.allowRemoteModels = false` | `nerPiiDetector.ts:295` |
| `env.allowLocalModels = true` (pinned explicitly) | `nerPiiDetector.ts:296` |
| `env.localModelPath = NER_LOCAL_MODEL_PATH` (`'/models/'`) | `nerPiiDetector.ts:297`, const at `:144` |
| `NER_MODEL_ID = 'Xenova/bert-base-NER'` | `nerPiiDetector.ts:92` |
| Pinned revision `24c7e5aba9ae350923357a6f0b92571be34037ec` (40-char SHA, not `main`) | `nerPiiDetector.ts:107`; passed to `pipeline(...)` at `:316` |
| `dtype: 'q8'` | `nerPiiDetector.ts:311` |
| `TRANSFORMERS_JS_VERSION = '4.2.0'` + runtime version-skew guard (throws typed error on mismatch) | `nerPiiDetector.ts:126`, guard `:281-287` |
| Vendored bundle load — `import('/vendor/transformers.web.min.js')`, no HF/jsdelivr/unpkg at runtime in our code | `nerPiiDetector.ts:130` (const), `:208-211` (dynamic import, `@vite-ignore`) |
| Typed `NERModelLoadError` (never silently null; failed loads not cached; concurrent racers get the same typed error) | `nerPiiDetector.ts:159-174` (class), `:257-264` (race note), `:329-346` (mapping + singleton clear) |
| Consumer THROWS `NerPiiFailClosedError` / re-throws typed fail-closed; regex-only ONLY on explicit `enableNER:false` | `src/lib/enhancedPiiStripper.ts:60` + `:67-74` (opt-out path), `:116-132` (throw path, no message interpolation of document text) |
| Structural recognition of `NERModelLoadError` by name (cross-bundle safe) | `src/lib/ocrFailClosed.ts:100-107` (`isNerModelLoadError`), `:116-122` (`isPiiStripFailClosedError`) |
| Prebuild wiring | root `package.json` → `"prebuild": "tsx scripts/fetch-ner-model.ts"` |
| Integrity lock: per-file SHA-256 + byte length, `required` flag, pinned-revision regex (rejects floating refs) | `scripts/ner-weights.lock.json` (5 files; `onnx/model_quantized.onnx` = 108,952,255 B); `scripts/fetch-ner-model.ts:70-84` (`readLock` 40-hex enforcement), `:111-113` (hash compare), `:278-281` (non-zero exit) |
| CSP↔runtime-deps CI guard: forbidden-host list incl. `huggingface.co`/`jsdelivr`/`unpkg`; asserts `'self'`+`'wasm-unsafe-eval'`/worker/connect against the DEPLOYED `vercel.json` CSP | `scripts/ci/check-csp-runtime-deps.ts:47-58` (`FORBIDDEN_CDN_PATTERNS`), `:64-69` (`RUNTIME_DEP_SOURCES` — scans 4 src files; **does NOT scan the vendored bundle itself — see F-1/F-2**) |
| Worker never imports `generateFingerprint` | `grep -rn generateFingerprint services/worker/` → only prohibition comments in `agents.md`s and chain file headers (`base.ts:19`, `signet.ts:17`); zero import statements. Also zero worker imports of `fileHasher`/`piiStripper`/`mlRuntime`/`ocrWorker` |

## 2. The exact CSP tested (VERIFIED: code-cite + prod-read)

`vercel.json` (`Content-Security-Policy`, applied to `/(.*)`):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://*.stripe.com https://arkova-worker-270018525501.us-central1.run.app https://app.arkova.ai https://arkova.ai https://edge.arkova.ai https://search.arkova.ai; frame-src 'self' https://*.stripe.com https://accounts.google.com; frame-ancestors 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; upgrade-insecure-requests
```

- No `huggingface.co`, `jsdelivr`, `unpkg`, `cdnjs`, or `tessdata` host anywhere in the policy. `script-src` = `'self' 'wasm-unsafe-eval'` (no `unsafe-inline`/`unsafe-eval`); `connect-src` includes `'self'`.
- **Live prod match** (read-only `curl -sI https://app.arkova.ai/` 2026-07-06): the served `content-security-policy` header is **byte-identical** to the `vercel.json` value above. The same header is also served on the static asset paths.
- Every browser-real phase in §5 was served with this exact string (read live from `vercel.json` by the harness, not hand-copied).

## 3. Unit-suite evidence (VERIFIED: test-run — these are UNIT results, not browser evidence)

`npx vitest run` on the 9 relevant files — **169/169 passed, 0 failed** (Vitest 4.1.9, Node v25.6.1, 2026-07-06):

| Suite | Passed |
|---|---|
| `src/lib/piiStripper.test.ts` | 47/47 |
| `src/lib/piiStripper.adversarial.test.ts` | 36/36 |
| `src/lib/ocrWorker.test.ts` | 18/18 |
| `src/lib/nerPiiDetector.test.ts` | 16/16 |
| `src/lib/enhancedPiiStripper.test.ts` | 13/13 |
| `src/lib/ocrFailClosed.test.ts` | 12/12 |
| `scripts/ci/check-csp-runtime-deps.test.ts` | 12/12 |
| `scripts/fetch-ner-model.test.ts` | 11/11 |
| `scripts/vendor-transformers-version.test.ts` | 4/4 |

Note the unit suites inject a **fake transformers loader** (`__setTransformersLoaderForTesting`) — by design they cannot see F-1 (§6). That is exactly why this re-gate demanded browser-real evidence.

Also green in this session: `npm run typecheck` (0 errors), `npm run lint` (0 errors; 2 pre-existing warnings in unrelated `issuer-partnerships` files), `npm run lint:copy` (compliant). (That run's tree included a comment-only docstring fix in `nerPiiDetector.ts` since moved to fix PR #1416 — a comment cannot alter these outputs.)

## 4. Build + vendoring evidence (VERIFIED: test-run)

- `npm run build` (2026-07-06, exit 0): `prebuild` ran `scripts/fetch-ner-model.ts`, downloading from HF **at build time** (permitted — runtime CDN is what is banned) at the pinned revision.
- `public/models/` populated: **105 MB** total — `config.json` (999 B), `tokenizer.json` (668,923 B), `tokenizer_config.json` (385 B), `special_tokens_map.json` (125 B), `onnx/model_quantized.onnx` (**108,952,255 B** — byte-exact vs lockfile).
- Explicit integrity re-verification: `npx tsx scripts/fetch-ner-model.ts --check` → all 5 files "hash verified", `All required model files present + hash-verified (Xenova/bert-base-NER@24c7e5ab…)`, exit 0.
- Vite copied both `models/` and `vendor/` into `dist/` (137 MB) — the weights ship same-origin with the app bundle.
- Prod actually serves the vendored artifacts (read-only HEAD, 2026-07-06): `https://app.arkova.ai/vendor/transformers.web.min.js` → **200**; `https://app.arkova.ai/models/Xenova/bert-base-NER/config.json` → **200**. VERIFIED(prod-read).
- The prod-served bundle is **byte-identical** to the local vendored bundle: SHA-256 `0a96dcf4c48981b7d05f53827e6975ec239132606ad0d526bbc2db0fcdbc4ded` for prod-download, `public/vendor/`, and `dist/vendor/` copies. VERIFIED(prod-read + test-run).

## 5. Browser-real evidence (VERIFIED: browser-real)

### 5a. Repo e2e spec under the deployed CSP — 3/3 passed

`e2e/extraction-csp-fail-closed.spec.ts` run unchanged in headless Chromium (Playwright 1.61.1; scratch config that only drops the repo config's authed-`setup` project dependency — the spec itself is auth-free and reads the CSP live from `vercel.json`):

1. ✓ policy string forbids Tesseract+NER CDNs and permits the self-host directives (1.1s)
2. ✓ **the browser BLOCKS real off-origin fetches** to `cdn.jsdelivr.net` (Tesseract core) and `huggingface.co/Xenova/bert-base-NER` under the deployed CSP (346ms)
3. ✓ fail-closed zero-egress contract (76ms) — NOTE: this third test **models** the contract with an in-page reimplementation; it is labeled here as contract-shaped browser evidence, NOT production-module evidence. Production-module evidence is §5b.

### 5b. Real production modules under the deployed CSP (probe harness)

Method: the unchanged `src/lib/{enhancedPiiStripper,nerPiiDetector,ocrFailClosed}` modules were bundled (vite lib build; the `/vendor/transformers.web.min.js` dynamic import kept external/native exactly as in the prod chunk — confirmed the built app chunk `dist/assets/fraudDetection-*.js` carries the same `'/vendor/transformers.web.min.js'` native `import()`), served with the **production `dist/`** and the **byte-exact deployed CSP header** by a local static server, and driven by headless Chromium. `securitypolicyviolation` events, console, and every network request were recorded. Full harness source: Appendix A; raw JSON: Appendix B; screenshots: `docs/reference/webext01-regate-evidence/*.png`.

Three phases (`stripPIIEnhanced(sample, { forceBackend: 'wasm', enableNER: true })` on a PII-bearing sample):

| Phase | Setup | Outcome |
|---|---|---|
| CONTROL | **no CSP header**, weights present | `NERModelLoadError` — cause `TypeError: Failed to resolve module specifier "onnxruntime-web/webgpu"` (43ms) |
| A | **deployed CSP**, weights present | identical typed failure (19ms); **zero CSP violations**; `/models/Xenova/bert-base-NER/config.json` fetch from the page → **200 under `connect-src 'self'`** |
| B | **deployed CSP**, weights ABSENT (`/models/*` → 404) | identical typed failure; direct `/models/` fetch → 404 as expected |

Invariants observed in **all three** phases (browser-real, production modules):

- The thrown error is the **typed** `NERModelLoadError`; `isPiiStripFailClosedError(err) === true`; `isNerModelLoadError(err) === true` — the §1.6 egress gate recognizes it.
- **Zero off-origin requests** — the page never contacted any non-localhost origin (no HF, no jsdelivr, nothing).
- **Zero requests to `/api/v1/ai/extract`** — no metadata egress on the failure path.
- The CONTROL phase proves the failure is **NOT CSP-related** (§6).

**Fail-closed under the deployed CSP: VERIFIED(browser-real).** The weights-absent hard-block (task step iii) is captured — with the caveat that today the load fails at bundle-link (F-1) *before* the weights lookup, so phases A and B are indistinguishable; the weights-absent-specific path (`allowRemoteModels=false` → missing local file → typed throw) is covered at unit level (`nerPiiDetector.test.ts`, 16/16).

**Model load + inference under the deployed CSP (task steps i–ii): NOT CAPTURED — and currently impossible in any environment, including prod.** See F-1.

## 6. NEW FINDINGS (the re-gate's real output)

### F-1 (P1, functional): the vendored transformers.js bundle cannot initialize in a browser — NER is dead-on-arrival at runtime

- `public/vendor/transformers.web.min.js` (`@huggingface/transformers@4.2.0` `dist/transformers.web.min.js`, byte-for-byte) is an ESM file containing **top-level bare-specifier imports**: `import * as … from "onnxruntime-web/webgpu"` and `from "onnxruntime-common"` (visible in the minified source).
- Production loads this file via **native browser dynamic import** (`nerPiiDetector.ts:208-211`, `@vite-ignore`, unbundled — confirmed in the built chunk). A browser cannot resolve bare specifiers without an **import map**, and `index.html`/`dist/index.html` contain none (grep: 0 matches).
- Empirically (this session, §5b): module link fails with `TypeError: Failed to resolve module specifier "onnxruntime-web/webgpu"` → `getNERPipeline` throws `NERModelLoadError` on **every** load — weights present or not, CSP or no CSP.
- **Prod transferability is not speculative:** the prod-served bundle is SHA-256-identical to the one that failed locally (§4), prod serves it from the same path, and prod has no import map. The identical native-import → identical link failure.
- Consequence: with `ENABLE_AI_EXTRACTION` default **true in production** (§1.6) and NER on by default in `stripPIIEnhanced`, the extraction path will **hard-block fail-closed for every user** (privacy holds — no PII egress — but the launch-required AI-extraction feature cannot function). The 2026-06-24 preview verification recorded in HANDOFF (bundle + weights served 200 same-origin) verified asset **availability**, not runtime **execution** — this slipped through precisely because no browser-real execution evidence was ever captured. Unit tests inject a fake loader (§3) and the e2e models the contract (§5a #3), so CI is green while the feature is broken.
- Why the CSP CI guard missed it: `check-csp-runtime-deps.ts` scans only the 4 first-party `RUNTIME_DEP_SOURCES` files for forbidden hosts; the vendored bundle itself is not scanned, and a bare-specifier link failure is not a host reference at all.
- Fix directions (NOT attempted here — out of scope for an evidence-only PR): (a) vendor a browser-self-contained build of transformers.js (no bare imports), or (b) add an import map + vendor `onnxruntime-web`/`onnxruntime-common` ESM files same-origin, or (c) stop externalizing — let Vite bundle `@huggingface/transformers` so specifiers resolve at build time (bundle-size/lazy-load tradeoffs apply). Any fix must re-run THIS evidence harness to prove real in-browser load + inference under the deployed CSP before gate #13 can claim the self-host slice.

### F-2 (latent, blocks the fix for F-1): onnxruntime WASM paths default to jsdelivr

Once F-1 is fixed, the bundle's ONNX runtime defaults `wasmPaths` to `https://cdn.jsdelivr.net/npm/onnxruntime-web@<ver>/dist/` **when not explicitly set** (visible in the vendored source: `if (…versions?.web && !Ce.wasm.wasmPaths) { … cdn.jsdelivr.net … }`). Nothing in `src/` sets `env.backends.onnx.wasm.wasmPaths` (grep: 0 matches). The deployed CSP will block that fetch → the load would *still* fail (fail-closed, but still broken) until the ort WASM artifacts are vendored same-origin and `wasmPaths` is pinned to `/vendor/...` — the same treatment Tesseract already got in WEBEXT-02.

### Required follow-ups (not done in this PR — evidence-only)

1. File F-1 (+F-2) in the canonical Confluence bug tracker (88768514) and as a Jira story on the WEBEXT/§1.6 epic — **this session had no MCP write access**; the parent session/RTE must log it.
2. Fix per §6 F-1 directions + vendor ort WASM (F-2) + extend `check-csp-runtime-deps.ts` (or a sibling gate) to catch bare-specifier imports in vendored runtime ESM.
3. Re-run this harness (Appendix A) for the green half of gate #13: model load + inference + zero CSP violations, browser-real.

## 7. Latency / F1

- **Browser latency: NOT CAPTURED** — impossible until F-1 is fixed (no in-browser model initialization).
- **Node-side latency (VERIFIED: test-run — explicitly NOT browser evidence):** the exact pinned, hash-verified weights + pinned `@huggingface/transformers@4.2.0` (onnxruntime-node), Apple-silicon dev machine, Node v25.6.1: model load **721 ms**, first inference **52 ms**, warm inference **15 ms** on a 217-char sample. Detections correct: `John Smith` (PER), `Microsoft` (ORG), `Seattle` (LOC), `Maria Garcia` (PER), `Barcelona` (LOC), `Acme Corporation` (ORG, subword-merged), scores 0.983–1.0. This validates the vendored **artifact**; it says nothing about browser performance.
- **F1: NOT CAPTURED.** No labeled §1.6 PII eval corpus exists in-repo (`docs/eval/` is Gemini extraction evals; `piiStripper.adversarial.test.ts` is assertion-based, not a scored corpus). Needed: a labeled PII entity dataset (e.g. held-out CoNLL-style or synthetic credential-document set with PER/LOC/ORG spans), run through `detectPIIWithNER` post-F-1-fix, scored per-entity-type. Until then any F1 number would be fabricated.

## 8. Remaining gate-#13 evidence gaps (after this PR)

| Gap | Blocker |
|---|---|
| Browser-real model load + inference, zero CSP violations (steps i–ii) | **F-1 fix required first** (then re-run Appendix A harness) |
| Browser-real weights-absent typed error distinct from bundle-link error | F-1 fix required (today both fail identically at link) |
| ort WASM same-origin under `script-src 'self' 'wasm-unsafe-eval'` | F-2 vendoring required |
| F1 on a §1.6 eval set | corpus does not exist; create + label, then measure |
| Browser latency numbers | F-1 fix required |
| Full authed upload-UI path (real drag-drop → extraction under prod CSP) | needs an authed environment (staging rig or Vercel preview with seed users); this session's probe exercised the modules directly, not the React upload flow |

---

## Appendix A — reproduction harness (run in-session; NOT committed as executable files)

Untracked under `probe-evidence/` in the working tree. Reproduce: create the three files below, `npx vite build --config probe-evidence/vite.probe.config.ts`, then `npx tsx probe-evidence/drive.ts` after `npm run build`.

<details><summary>probe-entry.ts (bundles the REAL src/lib modules, exposes on window)</summary>

```ts
import { stripPIIEnhanced } from '../src/lib/enhancedPiiStripper';
import {
  detectPIIWithNER, NERModelLoadError,
  NER_MODEL_ID, NER_MODEL_REVISION, TRANSFORMERS_JS_VERSION,
} from '../src/lib/nerPiiDetector';
import { isPiiStripFailClosedError, isNerModelLoadError } from '../src/lib/ocrFailClosed';
window.__probe = { stripPIIEnhanced, detectPIIWithNER, isPiiStripFailClosedError, isNerModelLoadError, NERModelLoadError,
  constants: { NER_MODEL_ID, NER_MODEL_REVISION, TRANSFORMERS_JS_VERSION } };
window.__probeReady = true;
```

vite config: `build.lib` entry above, `formats:['es']`, `rollupOptions.external:['/vendor/transformers.web.min.js']` (keeps the vendored bundle a native runtime import, exactly as prod).
</details>

<details><summary>serve.mjs (serves dist/ + probe with the EXACT vercel.json CSP; HIDE_MODELS=1 → /models/* 404; NO_CSP=1 → control)</summary>

Static node:http server; reads the `Content-Security-Policy` value live from `vercel.json` and sets it on every response (unless `NO_CSP=1`); serves `dist/` (production build incl. `models/` + `vendor/`), a probe HTML page (external same-origin `<script type="module">` only — CSP has no `unsafe-inline`), and the probe bundle.
</details>

<details><summary>drive.ts (Playwright chromium driver, 3 phases, captures violations/console/requests/screenshots)</summary>

Per phase: `addInitScript` registers a `securitypolicyviolation` collector; records every request; loads the probe page; runs `stripPIIEnhanced(sample, { forceBackend:'wasm', enableNER:true })` and captures success-or-typed-failure, then a direct same-origin `/models/.../config.json` fetch probe; renders results into the DOM and screenshots.
</details>

## Appendix B — raw probe results (evidence-results.json, 2026-07-06)

```json
{
  "control_noCsp_weightsPresent": {
    "outcome": { "loaded": false, "elapsedMs": 43, "errorName": "NERModelLoadError",
      "isPiiStripFailClosedError": true, "isNerModelLoadError": true, "causeName": "TypeError",
      "causeMessage": "Failed to resolve module specifier \"onnxruntime-web/webgpu\". Relative references must start with either \"/\", \"./\", or \"../\"." },
    "cspViolations": [], "offOriginRequests": [],
    "requestPathsSample": ["/__probe__.html", "/__probe__/probe.js", "/vendor/transformers.web.min.js", "/models/Xenova/bert-base-NER/config.json"],
    "extractEgressAttempted": false, "modelsFetchProbe": { "status": 200, "ok": true }
  },
  "phaseA_deployedCsp_weightsPresent": {
    "outcome": { "loaded": false, "elapsedMs": 19, "errorName": "NERModelLoadError",
      "isPiiStripFailClosedError": true, "isNerModelLoadError": true, "causeName": "TypeError",
      "causeMessage": "Failed to resolve module specifier \"onnxruntime-web/webgpu\". Relative references must start with either \"/\", \"./\", or \"../\"." },
    "cspViolations": [], "offOriginRequests": [],
    "extractEgressAttempted": false, "modelsFetchProbe": { "status": 200, "ok": true }
  },
  "phaseB_deployedCsp_weightsAbsent": {
    "outcome": { "loaded": false, "elapsedMs": 34, "errorName": "NERModelLoadError",
      "isPiiStripFailClosedError": true, "isNerModelLoadError": true, "causeName": "TypeError",
      "causeMessage": "Failed to resolve module specifier \"onnxruntime-web/webgpu\". Relative references must start with either \"/\", \"./\", or \"../\"." },
    "cspViolations": [], "offOriginRequests": [],
    "extractEgressAttempted": false, "modelsFetchProbe": { "status": 404, "ok": false }
  }
}
```

Screenshots: [`control-no-csp.png`](./webext01-regate-evidence/control-no-csp.png) · [`phaseA-deployed-csp.png`](./webext01-regate-evidence/phaseA-deployed-csp.png) · [`phaseB-weights-absent.png`](./webext01-regate-evidence/phaseB-weights-absent.png)

_Last refreshed: 2026-07-06 by Lane 1 S3-E session — claims verified against in-session vitest/build/Playwright output and read-only app.arkova.ai header/asset checks quoted above._
