# agents.md — services/worker/src/api/v1/__tests__/

_Last updated: 2026-05-16_

## What This Folder Contains

Test suites for v1 API endpoints — verification, proof packets, and batch operations.

| File | Purpose |
|------|---------|
| `ai-template.contract.test.ts` | AI-03 (SCRUM-2383) privacy lock-ins for `/ai/template` + `/ai/tags`: schema-lint (no bytes/base64/raw-document payloads, incl. smuggling inside `fields`) and telemetry value-omission (logs carry names/counts/confidence + bounded error NAMES only — never field values) |
| `auditBatchVerify.test.ts` | Tests for batch audit verification endpoint |
| `provenance.test.ts` | Tests for provenance chain endpoint |
| `verify-proof.test.ts` | Tests for proof verification endpoint |

## Do / Don't Rules

- **DO** use `buildTestAnchor()` from `../__test-helpers__/build-anchor.ts` for fixtures
- **DO NOT** call real Supabase or Bitcoin APIs — mock all external dependencies
