# agents.md — services/worker/src/api/v1/contracts/

_Last updated: 2026-07-17_

## 2026-07-17 Credit-gate reference_id (SCRUM-2970)

- `anchor-pre-signing.ts` restructured to insert-then-deduct: the anchor row is inserted first (select now includes `id`), then `ensureAnchorCreditAvailable` runs with `reference_id` = the new row's id; on deduct failure the never-paid row is hard-deleted (compensation) and the frozen 402/503 bodies are unchanged. A fingerprint-derived reference was rejected in review — permanent 0326 ledger row + `deleted_at`-filtered dedup = free re-anchor after soft-delete. HTTP retries are absorbed by the org-scoped dedup lookup before the gate.

## What This Folder Contains

Contract e-signature anchoring endpoints. Pre-signing creates an unsigned anchor before the e-sign workflow; post-signing links the signed result back via `parent_anchor_id`.

| File | Purpose |
|------|---------|
| `anchor-pre-signing.ts` | `POST /api/v1/contracts/anchor-pre-signing` — creates unsigned-contract anchor receipt (fingerprint only, Constitution 1.6 compliant) |
| `anchor-pre-signing.test.ts` | Tests for pre-signing endpoint |
| `anchor-post-signing.ts` | `POST /api/v1/contracts/anchor-post-signing` — creates signed-contract anchor linked to pre-signing parent |
| `anchor-post-signing.test.ts` | Tests for post-signing endpoint |

## Do / Don't Rules

- **DO** link post-signing anchors to pre-signing anchors via `parent_anchor_id`
- **DO NOT** accept raw document bytes in the pre-signing path (Constitution 1.6 — fingerprint only)
