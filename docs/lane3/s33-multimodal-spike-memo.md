# L3-S6 — Multimodal Spike Memo: Image/Audio Extraction Feasibility (Sprint 3.3)

> **Status:** L3-S6 deliverable (2026-07-10). SPIKE-ONLY per CTO R4 — build lands in 3.5. Internal engineering notes; audited spec in Confluence (96894977).
> **Ground rules honored:** no image/audio bytes touched Arkova servers; no user documents used; probe spend 0 of ≤20-request cap (probe blocked, see §1).

## 1. Tuned-endpoint multimodal probe — BLOCKED-until-v6-redeploy

**Probe not run.** The read-only Vertex inventory (2026-07-10, see `docs/lane3/s33-candidate-packet.md` §2) shows **zero deployed endpoints** in us-central1 and us-east4 — the v5-reasoning endpoint `8811908947217743872` named as the probe target no longer exists as a deployed endpoint. There is nothing to send an inlineData part to.

**Answer from documentation only — marked UNCONFIRMED:**

- Vertex SFT for Gemini 2.5 Flash is GA and supports tuning on text, image, audio, video, and document data — so a *multimodally-tuned* golden-v8 is not blocked at the tuning layer.
- Whether a **text-tuned** endpoint (v6/v7 were tuned on text-only JSONL) accepts and usefully processes image/audio `inlineData` at inference is **UNCONFIRMED in official docs**. Architecturally plausible (LoRA adapter over a multimodal base; serving limits documented as "same as base model"), but quality on untuned modalities is unguaranteed — inference distribution should match tuning distribution.
- Hard in-tree finding: the worker's tuned path is **physically text-only** — `services/worker/src/ai/vertex-client.ts:50-52` builds `contents: [{ role: 'user', parts: [{ text: … }] }]`; there is no inlineData plumbing anywhere in the tuned call path. Even a "yes" from the probe implies worker changes before any pilot.

**Probe protocol (to execute once the v6 endpoint is recreated for L3-S0/S4):**

1. Auth: `gcloud auth` service-account token against the regional Vertex endpoint (no Developer-API key needed for a Vertex endpoint; `GEMINI_API_KEY` from Secret Manager only if a Developer-API comparison leg is added).
2. Payloads — SYNTHETIC ONLY, generated locally: (a) one PNG rendered from text (e.g., a fake "Certificate of Completion" string rendered to bitmap); (b) one ~2-second generated WAV (sine-sweep + synthesized speech snippet). Never a user document.
3. ≤20 requests total (CTO R14 mock-sandwich cap), read-only inference, no worker involvement, no bytes through Arkova infra.
4. Record per modality: HTTP accept/reject; if accepted, output quality notes (does it attempt extraction? emit v6 schema fields? hallucinate?); token count; latency.
5. Outcome updates this memo §1 and the v8 scoping decision. Until then, every downstream doc must carry: **"tuned-endpoint multimodal serving: UNCONFIRMED."**

## 2. Client-side WASM transcription feasibility (audio → §1.6-clean text path)

The §1.6 constitution is the binding constraint: image extraction of text-bearing documents **already ships** compliantly (client OCR via PDF.js + Tesseract.js → `stripPII` → server receives stripped text only, `src/lib/ocrWorker.ts`, `src/lib/aiExtraction.ts`). Audio has **no honest path today** — no client transcription exists, server ingestion of audio bytes is forbidden (§1.6), and §1.6A is connector-only. Client-side WASM transcription would convert audio to text **on device**, then reuse the existing stripPII → text extraction path unchanged.

### 2.1 Engine options (published sources)

| Engine | Models (size) | Browser performance (published) | Notes |
|---|---|---|---|
| **whisper.cpp WASM** (ggml-org, `whisper.wasm` example) | tiny.en 75MB / base.en 142MB / small.en 466MB; quantized Q5_1: 31 / 57 / 182MB | ~2–3× real-time for tiny/base on a modern desktop CPU + browser (60s audio in ~20–30s); requires WASM SIMD-128; models beyond `small` documented as unsatisfactory in-browser | Pure CPU; also ships a `stream.wasm` real-time demo and `bench.wasm` for on-device benchmarking |
| **transformers.js v3 (ONNX Runtime Web + WebGPU)** | whisper-tiny ~40MB; whisper-base; whisper-small ~240MB (ONNX, quantized variants) | WebGPU gives ~5–10× (up to claimed 100×) over WASM backend; published demos report real-time to ~5–8× real-time for tiny/base-class models on WebGPU without blocking the UI (worker-based) | Quantization caveat: q8 encoder degrades feature quality — hybrid (fp32 encoder / q4 decoder) preserves accuracy; WebGPU availability varies (Chrome/Edge good, Safari/Firefox partial) |

Sources: ggml.ai whisper.cpp WASM examples + README (model sizes, SIMD requirement, 2–3× RT claim, small-model ceiling); huggingface/transformers.js v3 release notes + issue #894 (WebGPU-vs-WASM); Xenova whisper-web demo lineage; independent 2025/2026 browser-STT writeups (offlinetts.com, whisperstt.com). Numbers are order-of-magnitude planning inputs, not lab results — the spike harness (§2.2) produces our own.

### 2.2 Language coverage — the honest table

| Language | Coverage in WASM-viable models (tiny/base/small) | Assessment |
|---|---|---|
| **EN (US/UK)** | Excellent; `.en` models purpose-built | SHIPPABLE quality expected at tiny/base |
| **AU-EN** | Whisper is accent-robust for major English variants; treated as EN | Expected fine; verify with AU-accented golden samples (pairs with L3-S8 AU corpus) |
| **Swahili (sw)** | Multilingual checkpoints only (no `.en`). Published FLEURS WER for **large-v3** ≈ 10–15%; small/tiny multilingual models are **materially worse** on low-resource languages (published per-language tables show the gap widening as models shrink) | **NOT shippable-quality at WASM-viable sizes without measurement.** Kenya pilot audio needs a golden-set eval at the exact model size we'd ship; expect to need `small` (largest browser-viable) and possibly to declare Swahili audio out of scope for the first build |

Note: distil-whisper variants are EN-only — usable for the AU/US path, not Kenya-language audio.

### 2.3 Feasibility harness (spike-scoped, no repo dependencies)

Allowed: a tiny local Node/browser harness (throwaway, not committed to the repo, no new repo dependencies) that loads whisper.cpp WASM and transformers.js from local builds, feeds synthetic WAVs, and records: model download size, cold-load time, RTF (real-time factor) on CPU-WASM vs WebGPU, heap peak. ggml.ai's hosted `bench.wasm` gives a zero-setup first datapoint. Target devices: 1280px-class laptop AND a 375px-class mobile profile (memory ceiling is the mobile risk: `small` ~1–2GB peak heap).

### 2.4 Delivery constraints if built (3.5)

- **CSP:** models + WASM must be self-hosted (precedent: Tesseract.js is already self-hosted for CSP). 31–240MB artifacts → CDN-cached, IndexedDB/service-worker persisted after first load.
- **Tiering:** WebGPU → WASM-SIMD fallback → graceful decline (feature-detect; never silently degrade quality without flagging it in the extraction record).
- **Chunking:** Whisper operates on 30s windows; long-audio requires VAD + windowing in the worker thread (see failure modes below).
- **No new repo deps without architecture review** (§1.1 hard constraint) — the build story must include that review.

## 3. Architecture decision memo

### Options

| Option | Verdict | Rationale |
|---|---|---|
| **(A) Client-side WASM transcription → stripPII → existing text path** | **PRIMARY (CTO R4)** | Constitutionally clean — zero audio bytes leave the device; reuses the entire shipped extraction/PII pipeline; zero marginal server inference cost; heavy client (model download, compute), Swahili quality risk at small sizes |
| **(B) §1.6B server-side carve-out** (per-org consent; fetch → transcribe in memory → discard; redaction guards; CI lint — modeled on §1.6A) | **RESERVE ONLY** | Held in reserve iff WASM fails feasibility (§2.3 harness). Returns as a **constitution PR** requiring founder sign-off + §1.6A-style guards + the SCRUM-2492-style byte-lint. Enables Gemini-quality transcription (incl. Swahili via large models) at ~$0.12/audio-hour, but breaks the "documents never leave your device" guarantee for a new modality — highest-cost trust decision |
| **(C) Decline audio** | **REJECTED (CTO R4: "Do not decline audio")** | — |

### Cost model

- Server-side Gemini 2.5 Flash audio ≈ 32 tokens/sec of audio ≈ **~$0.12/audio-hour** input — cost is not the blocker; compliance and QA are.
- Image/document pages ≈ **~$0.0004/page** — image is effectively free at our volumes, and already flows as OCR-text today (PDF pages billed as image input on the API only matter for a future server-side path we are not taking).
- Client-side WASM: ~zero marginal inference cost; the real costs are model distribution bandwidth (31–240MB, cached), client battery/latency, and eng time for the tiered fallback.

### Failure-mode inventory (either architecture; drives eval design)

1. **Long-audio hallucination/repetition** — Whisper-class and Gemini both loop or fabricate on long inputs; mitigate: VAD + 30s windowing, repetition detectors, max-duration caps.
2. **Fluent-but-wrong output** — transcripts read plausibly while corrupting the load-bearing tokens (names, license numbers, dates); mitigate: golden-set eval scores **extracted FACTS, not eyeballed transcripts** (research brief §3), grounding checks against the transcript.
3. **Diarization limits** — Whisper does not natively diarize; Gemini manages 2–3 clean speakers and degrades on crosstalk; mitigate: single-speaker scope for pilot; no speaker-attribution claims (R-7).
4. **Timestamp drift** — navigation-grade only; never evidentiary. Proof copy must not assert timestamp precision (§1.5).
5. **Schema-induced false confidence** — required fields get plausibly filled instead of abstained; mitigate: **every extraction field nullable + per-field evidence spans** pointing into the transcript; abstention scored per the eval methodology (`docs/lane3/s33-eval-methodology.md`).
6. **Accent / low-resource degradation** — Swahili at WASM sizes (§2.2); mitigate: per-language golden sets before any language is claimed supported.
7. **Silent truncation** — 30s window bugs drop trailing audio; mitigate: duration reconciliation check (input duration vs transcribed span).

### Decision

**Adopt (A) as primary.** Spike exit in 3.3 = §2.3 harness numbers + this memo; build decision + timeline land in 3.5 planning. (B) is pre-authorized as a reserve path only via constitution PR (CTO founder-decision 3). No tuned-multimodal claims by anyone until §1's probe answers the UNCONFIRMED question.

## 4. Pilot-facing messaging (CTO R4, R-7-clean)

> "Image-based documents work today — text is read and prepared entirely on your device before anything reaches Arkova. Audio support is in active feasibility evaluation under that same on-device guarantee; we'll share a decision and timeline after the current evaluation, targeting a next-sprint build."

What this deliberately does NOT claim (R-7): no audio availability date, no tuned-model multimodal capability, no Swahili support, no diarization/speaker attribution, no timestamp precision.
