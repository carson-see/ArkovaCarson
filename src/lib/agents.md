# agents.md — lib

_Last updated: 2026-05-26_

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
- `statusDisplay.ts` — SCRUM-2003 single source of truth for human-readable anchor/attestation status labels. Pure (no React/Supabase, mirrors `formatters.ts`). `getStatusDisplay(status) → { label, tone }` / `getStatusLabel(status) → string`. Maps every `anchor_status` (PENDING/BROADCASTING→"Processing", SUBMITTED, SECURED→"Verified", REVOKED, EXPIRED, SUPERSEDED, PENDING_RESOLUTION→"Needs Review") and `attestation_status` (DRAFT, ACTIVE, CHALLENGED + shared PENDING/REVOKED/EXPIRED) value to a §1.3-compliant label with a fail-safe title-cased fallback that is also banned-term-scrubbed. The fallback scrub (`FALLBACK_BANNED_PATTERNS`) is a deliberate SUPERSET of `scripts/check-copy-terms.ts` `FORBIDDEN_TERMS` — bare-substring terms (wallet/gas/transaction/crypto/bitcoin/blockchain/mining) match without boundaries so e.g. `GASEOUS`/`WALLETED`/`TRANSACTIONAL` are scrubbed, while boundary-bounded terms (hash/block/token) keep the canonical `(?<![-\w])…(?![-\w])` boundaries so `BLOCKADE` survives — replicated locally (not imported) to keep the module browser-safe (no `node:fs`). Use this instead of rendering a raw status enum in JSX or hand-rolling another inline `statusConfig` map.
- `mlRuntime.ts` — WebGPU detection and VRAM budget for in-browser ML (2 GB cap)
- `csvExport.ts` / `csvParser.ts` / `xlsxParser.ts` — data import/export utilities
- `sourceProvenance.ts` / `badgeSvg.ts` — SCRUM-1599 public-safe source provenance helpers, evidence-level validation, badge URL construction, and fail-closed badge SVG status mapping

## Recent Changes

- 2026-05-26 SCRUM-2013: `validators.ts` and `csvParser.ts` credential type lists expanded to 27 canonical values, adding `CPE`, `ACCREDITATION`, `CONTRACT_PRESIGNING`, and `CONTRACT_POSTSIGNING`.

## Do / Don't Rules

- DO: Validate with Zod before any Supabase write
- DO: Put all UI-visible strings in `copy.ts`, not inline JSX
- DON'T: Import `piiStripper`, `fileHasher`, `aiExtraction`, `mlRuntime`, or `ocrWorker` in `services/worker/`
- DON'T: Expose service role key, raw API keys, or user emails in any module
- DON'T: Cast `verification_level` strings directly; use `parseVerificationLevel()` so unknown values disappear instead of rendering misleading evidence labels

## Copy-lint coverage (SCRUM-2149)
`src/lib/**` is now scanned by `npm run lint:copy` (`scripts/check-copy-terms.ts`) for banned §1.3 terms in **user-visible strings** — JSX text and quoted display/error copy that reaches users (e.g. proof-package glossary text, Zod validation messages). The linter does NOT flag code positions (type unions, object keys, property access, URL segments, bare in-code enum/config values like `'mainnet'`), so internal chain/network identifiers in `explorer.ts`/`env.ts` are fine; only display strings must use approved vocabulary. `copy.ts` itself is excluded (it documents the rules). 2026-05-30: reworded `proofPackage.ts` proof_glossary ("SHA-256 hash" → "SHA-256 fingerprint", §1.3 Hash→Fingerprint).
