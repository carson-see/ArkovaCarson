# SCRUM-2994 — Audio / Image Claim Verification (local-dev leg)

**Lane 3, 24-hour window — 2026-07-20**
**Method:** code-path (static) verification of the two distinct pipelines every uploaded file passes through — (1) **fingerprint/anchor** (`src/lib/fileHasher.ts`) and (2) **content extraction** (`src/lib/ocrWorker.ts`). Per §1.5 every verdict is labeled by what is *measured* here.
**Scope note / honesty flag:** this is a **static code-path verification**, not a live browser run of each format, and **Exhibit-A's exact format list was not accessible this session** — the standard audio/image set is used below. A runtime pass through the live upload dialog and **prod anchor confirmation are deferred post-train** (W4: prod writes forbidden this window). Any partner claim must cite this as static-until-runtime-confirmed.

## Two pipelines, two different answers

- **Fingerprint / anchor** — `generateFingerprint(file)` reads `file.arrayBuffer()` and `crypto.subtle.digest('SHA-256', buffer)`. It is **format-agnostic**: it hashes raw bytes and never inspects MIME/extension. **Any** file — audio, image, video, binary — produces a valid fingerprint and can be anchored.
- **Content extraction** — `extractText(file)` (`ocrWorker.ts:258-277`) branches: `application/pdf` → PDF.js; `.docx` → mammoth.js; `file.type.startsWith('image/')` → Tesseract OCR; **everything else → `throw UNSUPPORTED_FILE_TYPE`**. HEIC/TIFF enter the `image/*` branch but are **browser-undecodable** → fail (this is exactly what SCRUM-2911 / PR #1605 soft-fails so they stop showing the false privacy screen).

## Verdict table (PASS = works today; static code-path)

| Format | Anchor (fingerprint) | Content extraction | Notes |
|---|---|---|---|
| Image PNG / JPG / WEBP / GIF | **PASS** | **PASS** | browser-decodable → Tesseract OCR |
| Image **HEIC / HEIF** | **PASS** | **FAIL** | browser cannot decode; SCRUM-2911 soft-fails to benign "unsupported format" |
| Image **TIFF** | **PASS** | **FAIL** | same as HEIC |
| Audio **MP3 / WAV / M4A / FLAC** | **PASS** | **FAIL (no path)** | `ocrWorker` has **no audio branch** → `UNSUPPORTED_FILE_TYPE`. No transcription / no content extraction exists. |

## FAIL findings that require a founder correction if claimed

1. **"Arkova extracts / understands audio content"** — **FALSE.** There is no audio transcription or content-extraction path. Audio files can be **fingerprinted and anchored** (integrity/timestamp), but no content intelligence is produced. → **correction memo needed** if any partner-facing claim implies audio *content* extraction.
2. **"Arkova reads any image format"** — **PARTIALLY FALSE.** Browser-decodable images extract; **HEIC/TIFF do not**. Anchoring still works for all. → soften to "common web image formats (PNG/JPG/WEBP); HEIC/TIFF anchor but are not OCR-read."

## TRUE claims (safe to make, static-until-runtime-confirmed)
- **"Arkova can anchor (timestamp + integrity-verify) audio and image files of any format."** TRUE — fingerprint is byte-level and format-agnostic. **Two caveats before partner use:** (a) client-side hashing ceiling — `fileHasher.ts` loads the whole file into browser memory with a 30s timeout, so very large media (multi-GB video / hi-res audio) may fail; do not claim "any size". (b) Byte-for-byte only, not perceptual — a re-encoded, recompressed, or re-saved copy of the same audio/image yields a **different** fingerprint and will not match the original.
- **"Arkova extracts content from PDF, DOCX, and common web images."** TRUE.
- **What an anchor proves:** these exact bytes existed at the network-observed time. It does **NOT** assert content authenticity, that the document is genuine, or legal validity (per §1.5 / `confirmation-proof.ts`).

## Remaining confirmation (post-train)
- Runtime pass of each Exhibit-A format through the live upload dialog on local dev, capturing the actual dialog outcome per format.
- Prod anchor confirmation for one audio + one image file (deferred — W4).
