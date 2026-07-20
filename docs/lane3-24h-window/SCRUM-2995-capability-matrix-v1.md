# SCRUM-2995 — Arkova Capability Matrix v1 (draft)

**Lane 3, 2026-07-20.** Human-readable companion to `SCRUM-2995-capability-matrix-v1.json` (the machine-readable source of truth). Every partner document (CE applications, xTRA response) must source capability claims from this matrix and preserve the measured / asserted / **not-asserted** labels (§1.5).

| Capability | Status | Claim label | One-line honest statement |
|---|---|---|---|
| **Anchoring** (timestamp + SHA-256 integrity) | Working, format-agnostic | measured | "Anchors any file — PDF, DOCX, images (incl. HEIC/TIFF), audio, video, binary." |
| **Content extraction** (on-device OCR/text) | PDF, DOCX, common web images | measured | "Extracts content from PDF, DOCX, and PNG/JPG/WEBP/GIF images." |
| — HEIC/TIFF extraction | Unsupported (soft-fail) | measured | Anchors, but not OCR-read. Do **not** claim. |
| — Audio/video extraction | **No path** | not_asserted | **Never claim audio/video *content* extraction.** Audio anchors; content is not read. |
| **AI template reconstruction** | Degraded (SCRUM-2999) | asserted | Do not claim current richness parity with early-2026 records until the model-SKU fix lands. |
| **CTDL import/parse** | Built (Draft PR #1603) | measured | "CTDL JSON-LD import implemented and unit-tested." Not yet merged/prod. |
| **CE registry consume (read)** | Endpoint reachable | measured | Sandbox GET-by-CTID works; no real envelope consumed yet (needs Jeff's sandbox resource). |
| **"Natively CTDL-compliant"** | Not verified | **not_asserted** | **Do not assert** — SCRUM-2998 owns this validation. |
| **Fraud detection (UI)** | Removed | measured | Not a user-facing capability; do not reference. |

**Load-bearing don'ts for partner comms:** (1) no audio/video content-extraction claim; (2) no "natively CTDL-compliant" until SCRUM-2998; (3) no template-richness claim while SCRUM-2999 is open; (4) English-only OCR limitation must be disclosed (Mercy letter).
