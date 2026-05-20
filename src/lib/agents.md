# agents.md — lib
_Last updated: 2026-05-19_

## What This Folder Contains

Core utility modules shared across the frontend. Every write path uses Zod validation; all UI copy lives in `copy.ts`. Client-side processing modules (`piiStripper`, `fileHasher`, `aiExtraction`, `mlRuntime`, `ocrWorker`) must NEVER be imported in `services/worker/`.

## Key Files
- `supabase.ts` — typed Supabase client (anon key only, never service role)
- `routes.ts` — named route constants consumed by App.tsx and navigation
- `copy.ts` — all user-facing strings, including legal-page notices; enforces banned-term vocabulary (Constitution 1.3)
- `validators.ts` — Zod schemas for fingerprints, anchors, profiles, API keys
- `switchboard.ts` — feature flag definitions and client-side checking
- `workerClient.ts` — fetch wrapper for frontend-to-worker API calls with auth injection
- `sentry.ts` — Sentry init with mandatory PII scrubbing (Constitution 1.4)
- `auditLog.ts` — client-side audit event logger via POST /api/audit/event (never direct insert)
- `fileHasher.ts` — SHA-256 fingerprinting via Web Crypto (client-side only)
- `piiStripper.ts` / `enhancedPiiStripper.ts` — PII redaction before data leaves browser
- `aiExtraction.ts` — OCR + PII strip + server extraction orchestrator (client-side)
- `proofPackage.ts` — proof package generation and validation for anchor verification
- `complianceMapping.ts` — static credential-type-to-regulatory-control mapping
- `explorer.ts` — mempool.space URL builder (uses approved terminology)
- `mlRuntime.ts` — WebGPU detection and VRAM budget for in-browser ML (2 GB cap)
- `csvExport.ts` / `csvParser.ts` / `xlsxParser.ts` — data import/export utilities
- `sourceProvenance.ts` / `badgeSvg.ts` — SCRUM-1599 public-safe source provenance helpers, evidence-level validation, badge URL construction, and fail-closed badge SVG status mapping

## Do / Don't Rules
- DO: Validate with Zod before any Supabase write
- DO: Put all UI-visible strings in `copy.ts`, not inline JSX
- DON'T: Import `piiStripper`, `fileHasher`, `aiExtraction`, `mlRuntime`, or `ocrWorker` in `services/worker/`
- DON'T: Expose service role key, raw API keys, or user emails in any module
- DON'T: Cast `verification_level` strings directly; use `parseVerificationLevel()` so unknown values disappear instead of rendering misleading evidence labels
