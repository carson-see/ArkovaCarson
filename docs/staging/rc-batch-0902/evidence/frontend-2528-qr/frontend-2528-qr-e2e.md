# PR #2528: certificate QR, end-to-end evidence

**Verdict: QR works end-to-end: YES.** The QR the PR prints on the audit certificate decodes, with an independent decoder and through two independent PDF renderers, to exactly `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ`; that URL, taken from the decoder's output rather than typed, returns 200 from production with no redirect and renders the record's verification result (Secured, Verified on Aug 9, 2026, 1:32 PM UTC, Verification ID ARK-DOC-9G5HQZ) at 1280x800, at 375x812, and under an iOS Safari user agent; a non-existent id fails honestly on the page ("Verification Failed / Record not found") with no 500 and no console errors.

| | |
|---|---|
| PR | #2528 `fix/published-verification-pointers`, "fix(proof): make published verification pointers work, and put a QR on the certificate" |
| Head under test | `7781bf0eb67df38d576e28f038003d7e3210dbd3` (checked out detached in an isolated worktree; nothing committed, pushed, or edited on the PR; no Supabase project or Cloud Run service touched; production accessed read-only over HTTPS) |
| Run date | 2026-09-02, 20:13Z to 20:19Z |
| Evidence directory | `/private/tmp/claude-502/-Volumes-Extreme-Arkova--legacy-home-Arkova-2026-05-15-arkova-mvpcopy-main/8fbf42c9-9710-4f41-a2f7-356a3b6a14d9/scratchpad/evidence-2528-qr/` (all paths below are relative to it) |
| Toolchain | node v25.6.1; repo-pinned qrcode-generator 2.0.4, jspdf 4.2.1, tsx 4.23.12, vitest 4.1.11, Playwright 1.62.1; decoder jsQR 1.4.0; renderers pdfjs-dist 6.2.108 on @napi-rs/canvas 1.0.8 and macOS QuickLook (`/usr/bin/qlmanage`); browser Google Chrome 152.0.7977.75 headless via Playwright's `chrome` channel; curl 8.7.1 |

## 1. What the QR encodes, and where the string is built

The certificate QR encodes `canonicalVerifyUrl(publicId)` and nothing else. The chain, in the PR head:

| Step | File | Code |
|---|---|---|
| Origin constant | `src/lib/routes.ts` | `export const CANONICAL_APP_ORIGIN = 'https://app.arkova.ai';` (not env-driven) |
| Path | `src/lib/routes.ts` | `verifyPath(publicId)` returns `` `/verify/${publicId}` `` |
| URL | `src/lib/routes.ts` | `canonicalVerifyUrl(publicId)` returns `` `${CANONICAL_APP_ORIGIN}${verifyPath(publicId)}` ``; reads no environment (unlike `verifyUrl()`, which follows `VITE_APP_URL` and is used only by the on-screen share QR) |
| Selection | `src/lib/generateAuditReport.ts` lines 444-445 | `const verificationUrl = data.publicId ? canonicalVerifyUrl(data.publicId) : null; const qr = verificationUrl ? buildQrMatrix(verificationUrl) : null;` |
| Encoding | `src/lib/certificateQr.ts` `buildQrMatrix(value)` | qrcode-generator, auto version, error-correction level M, byte mode; printable ASCII only; returns `null` (never throws) on empty, non-ASCII, or over-capacity input; output is run-length packed per row |
| Painting | `src/lib/generateAuditReport.ts` `drawQrMatrix` | one filled `doc.rect(..., 'F')` per horizontal run; `QR_SIDE_MM = 26`, `QR_QUIET_MODULES = 4`; the same URL is printed in Courier beside the code, and `buildAuditReport` returns `verificationUrl` and `qr` |
| Copy | `src/lib/copy.ts` `CERTIFICATE_COPY` | `SECTION_VERIFY_ONLINE: 'Verify Online'`; `VERIFY_ONLINE_INTRO: 'Scan this code, or open the link below, to check this record against Arkova's live verification page.'`; `VERIFY_ONLINE_INDEPENDENCE_NOTE: 'This link is a convenience, not the evidence. ...'`; `OFFLINE_VERIFY_TOOL` now names `https://app.arkova.ai/verify/independent` |

For `public_id = ARK-DOC-9G5HQZ` the expected payload is therefore:

```
https://app.arkova.ai/verify/ARK-DOC-9G5HQZ
```

43 bytes, all ASCII; UTF-8 hex `68747470733a2f2f6170702e61726b6f76612e61692f7665726966792f41524b2d444f432d39473548515a`.

Doc-comment nit (no behaviour impact): the comment above `SECTION_VERIFY_ONLINE` in `copy.ts` (line 1010) says "The QR encodes `verifyUrl(publicId)`"; the code encodes `canonicalVerifyUrl(publicId)`, which is the correct behaviour and what the tests pin.

## 2. Generate with the PR's code, decode independently

### 2a. Generation (`gen-qr.mts`, run with `npx tsx` from the worktree, so the repo's own qrcode-generator 2.0.4 and jspdf 4.2.1 do the work)

| | ARK-DOC-9G5HQZ (positive) | ARK-DOC-ZZZZZZ (negative control) |
|---|---|---|
| `canonicalVerifyUrl(id)` | `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ` | `https://app.arkova.ai/verify/ARK-DOC-ZZZZZZ` |
| Matrix | 33 x 33 modules (version 4, EC level M) | 33 x 33 |
| Runs (= painted rect ops) | 290 | 287 |
| Dark modules | 559 | 527 |
| Matrix sha256 (test's serialisation) | `f2f5328eb164a9b255264fac39da86f8518fce36038561691406d29edc793335` | `ac8f1c53614d5549c52a780b90e66ed823fa5732422882ba642e205f5806cddb` |
| `buildAuditReport(...).verificationUrl` equals the URL | yes | yes |
| `buildAuditReport(...).qr` deep-equals `buildQrMatrix(url)` | yes | yes |
| URL printed as text in the PDF | yes | yes |
| Certificate PDF | `certificate-ARK-DOC-9G5HQZ.pdf`, 24,752 B, 2 pages, sha256 `047f127fd1e91a1b3a815b10f014ca98d279f66fa675cbfad41df2b00e8711b5` | `certificate-ARK-DOC-ZZZZZZ.pdf`, 24,607 B, 2 pages, sha256 `c28538c38137fdec0b5500f28fd6c913ec5db610355dfdd2e120190cc208feb2` |

Golden cross-check: this environment's `buildQrMatrix('https://app.arkova.ai/verify/ARK-2026-001')` hashes to `b9dfb20052442ba90704109c228aac18b03117a87293b1413969c0b902914f6e`, the value `certificateQr.test.ts` pins for the matrix the PR author decoded out of band, so the encoder here is the encoder the PR was validated with. Fixture note: the certificate data is a synthetic SECURED record in the shape the PR's tests use; the QR depends on `publicId` only.

Outputs: `qr-matrix-<id>.json` (runs, dense grid, digest), `certificate-<id>.pdf`, `gen-summary.json`, `gen-qr.log`.

### 2b. Matrix decode (`decode-matrix.mjs`, jsQR 1.4.0, 4-module quiet zone)

The module grid captured from `buildQrMatrix` was rasterised to RGBA at three module sizes and decoded. jsQR shares no code with qrcode-generator.

| Scale | Image | Decoded text | Text equal | Bytes equal (`Buffer.compare` vs UTF-8 of expected) |
|---|---|---|---|---|
| 3 px/module | 123 x 123 | `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ` | yes | yes |
| 8 px/module | 328 x 328 | `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ` | yes | yes |
| 12 px/module | 492 x 492 | `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ` | yes | yes |

jsQR reports version 4 and a single byte-mode chunk; decoded length 43 = expected length 43. ARK-DOC-ZZZZZZ: 3 of 3 scales decode to `https://app.arkova.ai/verify/ARK-DOC-ZZZZZZ`, text and bytes equal. Failures: 0. Raster: `qr-ARK-DOC-9G5HQZ-scale8.png` (328 x 328, sha256 `4f166675eadc13f79c6559f7930424202f1055d27558262501005abcd5c9102e`). Results: `decode-matrix-results.json`, `decode-matrix.log`.

### 2c. Decode of the QR as embedded in the PDF (`decode-pdf.mjs`)

The QR is not an image XObject; it is 290 `x y w h re` fill operators in page 1's content stream, so the page was rasterised and the pixels decoded. Geometry read back from the content stream (page A4, 595.28 x 841.89 pt): module 0.7879 mm, code exactly 26.000 mm square, quiet zone 3.152 mm, modules starting 27.152 mm from the left and 237.152 mm from the top of page 1 (the "Verify Online" section, bottom-left; page 2 carries the offline-verify block and machine-readable proof). The PR's content-stream test pins 0.897 mm modules for its 29-module `ARK-2026-001` fixture; a 14-character id needs version 4, hence 33 modules and smaller modules at the same 26 mm.

Renderer 1, pdf.js 6.2.108 (legacy build) on @napi-rs/canvas:

| Render | Bitmap | Whole-page decode |
|---|---|---|
| 2x (144 dpi), page 1 | 1191 x 1684 | `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ`, equal |
| 3x (216 dpi), page 1 | 1786 x 2526 | `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ`, equal |
| 4x (288 dpi), page 1 | 2382 x 3368 | `null`: jsQR's finder-pattern locator did not find the code in the 8-megapixel, text-dense bitmap; a decoder limit, since the crop of this same bitmap below decodes |
| any scale, page 2 | | `null`, as expected (no QR on page 2) |
| 4x, crop = content-stream bounding box + quiet zone (367 x 367 px at x=272, y=2653) | `certificate-ARK-DOC-9G5HQZ-qr-crop.png` | `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ`, text and bytes equal, version 4 |

Renderer 2, macOS QuickLook (`qlmanage -t -s 2400`, Apple CoreGraphics; independent of pdf.js): page 1 at 1696 x 2400 (2.85 px/pt, about 205 dpi), `quicklook/certificate-ARK-DOC-9G5HQZ.pdf.png`. Whole-page decode: `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ`, text and bytes equal. Crop (262 x 262 px at x=193, y=1890, `certificate-ARK-DOC-9G5HQZ-quicklook-crop.png`): equal.

The negative-control certificate behaves identically and decodes to `https://app.arkova.ai/verify/ARK-DOC-ZZZZZZ` in every path. Failures: 0. Page rasters: `certificate-<id>-page-1.png`, `certificate-<id>-page-2.png` (2382 x 3368). Results: `decode-pdf-results.json`, `decode-pdf.log`.

## 3. The decoded URL against production

### 3a. HTTP layer (`curl-checks.sh`, output `curl-prod-results.txt`, 2026-09-02T20:16:27Z)

| Probe | User agent | Status | Redirects | Final URL | Content-Type | Bytes |
|---|---|---|---|---|---|---|
| `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ` | curl default | 200 | 0 | unchanged | `text/html; charset=utf-8` | 9,135 |
| `https://app.arkova.ai/verify/ARK-DOC-ZZZZZZ` | curl default | 200 | 0 | unchanged | `text/html; charset=utf-8` | 9,135 |
| `https://app.arkova.ai/verify/independent` (the certificate's reference-verifier pointer) | curl default | 200 | 0 | unchanged | `text/html; charset=utf-8` | 9,135 |
| `https://app.arkova.ai/verify/ARK-DOC-9G5HQZ` | iOS 17.5 Mobile Safari | 200 | 0 | unchanged | `text/html; charset=utf-8` | 9,135 |
| `https://app.arkova.ai/verify/ARK-DOC-ZZZZZZ` | iOS 17.5 Mobile Safari | 200 | 0 | unchanged | `text/html; charset=utf-8` | 9,135 |

Response headers (positive control, both user agents): `HTTP/2 200`, `server: Vercel`, `content-disposition: inline; filename="index.html"`, identical `etag: "4b3740b8ac93df9b72971e6aa5a13bc2"`, CSP and HSTS present, no `Location`, no `Set-Cookie`. Vercel serves the SPA shell for every `/verify/*` path, so the HTTP status cannot distinguish a found record from a missing one; the rendered DOM in 3b is the evidence for that. No user-agent-dependent redirect and no authentication wall exist at this layer.

### 3b. Browser (`playwright-verify.mjs`; Playwright 1.62.1 driving Google Chrome 152.0.7977.75 headless via `channel: 'chrome'`)

Chain of custody: the script reads the URL from `decode-matrix-results.json` (the scale-8 jsQR decode) rather than constructing it. Playwright's bundled Chromium build r1234 is not installed on this machine; the locally installed Google Chrome was used and nothing was downloaded. Each case waited for `load`, then `networkidle`, then polled the DOM until it settled.

| Case | Viewport | User agent | Document status | Content-Type | Final URL | networkidle | Settle | Console errors | Failed requests | 4xx/5xx responses |
|---|---|---|---|---|---|---|---|---|---|---|
| positive-desktop-1280x800 | 1280 x 800 | HeadlessChrome/152 (default) | 200 | `text/html; charset=utf-8` | unchanged | reached | 6.1 s | 0 | 0 | 0 |
| positive-mobile-375x812 | 375 x 812 @3x, mobile + touch | HeadlessChrome/152 (default) | 200 | `text/html; charset=utf-8` | unchanged | reached | 5.0 s | 0 | 0 | 0 |
| positive-ios-safari-ua-375x812 | 375 x 812 @3x, mobile + touch | `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1` | 200 | `text/html; charset=utf-8` | unchanged | reached | 5.5 s | 0 | 0 | 0 |
| negative-desktop-1280x800 | 1280 x 800 | HeadlessChrome/152 (default) | 200 | `text/html; charset=utf-8` | unchanged | reached | 4.4 s | 0 | 0 | 0 |
| negative-mobile-375x812 | 375 x 812 @3x | HeadlessChrome/152 (default) | 200 | `text/html; charset=utf-8` | unchanged | reached | 4.9 s | 0 | 0 | 0 |

What the positive page showed (the rendered `innerText` is byte-identical across the three positive runs, 1,905 characters, saved as `positive-*.txt`): the "Verify a Document" page with a green check, the **Secured** badge, **"Verified on Aug 9, 2026, 1:32 PM UTC"**, "This record's fingerprint is permanently anchored.", the DOCUMENT RECORD card "Contract, Signed" (Secured), ISSUED BY Arkova with source `docusign:7ec7d52a-f473-87c6-813e-b68cad4484f6`, DOCUMENT FINGERPRINT `1c4494567a8db96ba1837e432636519d623f9d13ae5d728a9867ef35b3395860`, Compliance Controls (7 controls across 4 frameworks), the CRYPTOGRAPHIC PROOF block (Network Receipt `81989ad5ba14c29649d506fad547e26b2e533fbd7c1f6591cb6b9f0d7f62792c`, Network Record #961,733, Observed Time Aug 9, 2026, 1:32 PM UTC), LIFECYCLE (Created Aug 7, 2026; Secured Aug 9, 2026), Provenance Timeline, DOWNLOAD PROOF, the does-not-assert block, and **"Verification ID: ARK-DOC-9G5HQZ"** with "Secured by Arkova". Keyword counts: verified 1, secured 5, anchored 1, not found 0, error 0, loading 0. The single "Sign in" hit is the header navigation link; there was no login redirect, no spinner left on screen, and no error state.

Screenshots (viewport captures are exactly the requested sizes; full-page captures extend below the fold):

| File | Pixels | Content |
|---|---|---|
| `positive-desktop-1280x800-viewport.png` | 1280 x 800 | Secured badge, "Verified on Aug 9, 2026, 1:32 PM UTC", Contract record, fingerprint |
| `positive-desktop-1280x800.png` | 1280 x 2409 | full page, ends with "Verification ID: ARK-DOC-9G5HQZ" (sha256 `10bdd5fe2e3ec08a2123eeb660375f5cb7503c3461e9a1963168ec6051f88b40`) |
| `positive-mobile-375x812-viewport.png` | 1125 x 2436 (375 x 812 @3x) | same result in the single-column mobile layout |
| `positive-mobile-375x812.png` | 1125 x 9066 | full page (sha256 `1f277205be6a0e9d703f952a8a16166555939f7f21266627a01d71851452ed0f`) |
| `positive-ios-safari-ua-375x812-viewport.png` | 1125 x 2436 | iOS Safari UA, same result |
| `positive-ios-safari-ua-375x812.png` | 1125 x 9066 | full page (sha256 `e123ab55756f19ba4c95bac37db8de1aa8483ef2b24dc5f40ef177f5a5a3f21f`) |
| `negative-desktop-1280x800.png` | 1280 x 800 | "Verification Failed / Record not found" (sha256 `acebfb41ea30aba612245fb3d354b5255836c4e0e709208abfb0c043660d8f49`) |
| `negative-mobile-375x812.png` | 1125 x 2436 | same failure state on mobile (sha256 `d828a4dc4aa77d0e653250d1f6cdc17845b963b6e3ee8782c4ae79b2f25640f2`) |

Mobile Safari (phone-camera realism): with the iOS 17.5 Mobile Safari user agent at 375 x 812 the document response was 200 `text/html`, the final URL was unchanged, the DOM was identical to the desktop run, the Verification ID was visible, and there was no block, challenge, or redirect to login. Per-case detail: `playwright-results.json`, `playwright-run.log`.

## 4. Negative control: a public id that does not exist

`ARK-DOC-ZZZZZZ` went through the same path: generated by the PR's code (33-module matrix, certificate PDF), decoded by jsQR from the matrix (3/3 scales) and from both PDF renderers to exactly `https://app.arkova.ai/verify/ARK-DOC-ZZZZZZ`, then loaded in production. HTTP: 200 SPA shell (see 3a). Rendered page (210-character `innerText`, `negative-desktop-1280x800.txt`): "Verify a Document", a red cross icon, **"Verification Failed"**, **"Record not found"**, "The document you are looking for may not exist or has not been verified yet." (`PUBLIC_VERIFICATION_LABELS.VERIFICATION_FAILED` / `NOT_FOUND_DESC`). No 500, no stack trace, no console errors, no failed requests, no 4xx/5xx sub-requests, identical at 1280 x 800 and 375 x 812. The QR path fails honestly.

## 5. The PR's own tests

```
npx vitest run src/lib/certificateQr.test.ts src/lib/generateAuditReport.test.ts
```

| File | Passed | Failed | Skipped |
|---|---|---|---|
| `src/lib/certificateQr.test.ts` | 10 | 0 | 0 |
| `src/lib/generateAuditReport.test.ts` | 28 | 0 | 0 |
| Total | **38** | **0** | **0** |

Test Files 2 passed (2); Tests 38 passed (38); duration 1.87 s; vitest 4.1.11, jsdom environment. Logs: `vitest-run.log`, `vitest-run-verbose.log` (every test name).

## 6. Verdict and residual risk

**QR works end-to-end: YES.** At head `7781bf0eb`, the certificate QR encodes exactly `https://app.arkova.ai/verify/<publicId>`, built by `canonicalVerifyUrl` in `routes.ts` with no environment input; an independent decoder reads that string back byte-for-byte from the module matrix and from the PDF as painted, through two unrelated renderers; production serves that URL with 200 and no redirect for desktop and mobile Safari agents, and the live page renders the record's verification result and its Verification ID at both viewports with zero console errors and zero failed requests; a fabricated id reaches a clear "Record not found" state rather than a 500. Residual risk: (1) no physical print-and-camera scan was performed; the smallest-resolution decode that succeeded is the 144 dpi pdf.js render (about 4.5 px per 0.79 mm module), so a clean office print should scan, but that remains an inference rather than a measurement. (2) The evidence binds to this exact head; any later commit touching `certificateQr.ts`, `generateAuditReport.ts`, `routes.ts`, or `copy.ts` needs a re-run of `gen-qr.mts` and the decoders. (3) The on-screen share QR (`qrcode.react`, `verifyUrl()`, `VITE_APP_URL`-driven) is out of scope; it equals the canonical URL only if the production build's `VITE_APP_URL` is `https://app.arkova.ai` or unset, which was not verified here. (4) Vercel answers 200 for any `/verify/*` path, so a machine consumer following the QR cannot use the status code to detect a missing record; the page is honest, the status is not informative.

## 7. Out-of-scope finding (not QR-related, pre-existing)

In both renderers the certificate's field labels of about 13 characters or more run into their values: "Document TypeDOCUMENT", "Verification Path2 step(s)", "Record Position#3", "Tree Leaf Count8", "Network Record#850,123", "Proof Schema Version1", "Network Observed TimeJun 2, 2026, 3:00 AM UTC" (visible in `certificate-ARK-DOC-9G5HQZ-page-1.png` and `quicklook/certificate-ARK-DOC-9G5HQZ.pdf.png`; short labels such as Filename, File Size, Organization, Issued are fine). `addField` in `generateAuditReport.ts` positions the value at `margin + 4 + doc.getTextWidth(label + '  ')` measured in Helvetica bold 9 pt, and the measured width falls short of the painted width by an amount that grows with label length. `git diff origin/main...HEAD` shows no change to `addField`; the code dates from PR #761 (2026-05-11). Cosmetic, unrelated to this PR, and worth a bug-tracker entry.

## 8. Artifacts and reproduction

Scripts (all in the evidence directory): `gen-qr.mts` (generate with the PR's exports; run `npx tsx <path>` from the worktree root), `decode-matrix.mjs`, `decode-pdf.mjs`, `playwright-verify.mjs` (run with `node` from the evidence directory), `curl-checks.sh`. Data: `gen-summary.json`, `qr-matrix-*.json`, `decode-matrix-results.json`, `decode-pdf-results.json`, `playwright-results.json`, `curl-prod-results.txt`, `*.log`, `vitest-run*.log`. Images: listed in sections 2 and 3.

Method notes. The worktree had no `node_modules`, so `npm ci --no-audit --no-fund --ignore-scripts` was run in it (gitignored; log `npm-ci-worktree.log`); the decoder and renderer packages (jsqr 1.4.0, pngjs 7.0.0, @napi-rs/canvas 1.0.8, pdfjs-dist 6.2.108) were installed only in the evidence directory. The harness blocks direct writes outside the repository, so the scripts and this report were authored in the worktree's gitignored `node_modules/.evidence-2528-qr/` and moved here; that directory was removed and `git status --porcelain` in the worktree is empty. No secrets were used or printed.
