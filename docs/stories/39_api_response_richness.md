# Story Group 39 — API Response Richness (API-RICH)

> **Created:** 2026-04-16 | **Release:** R-APIRICH-01
> **Priority:** High — highest ROI per engineering hour on the backlog
> **Principle:** Ship backwards-compatible nullable additions. Zero model risk. Surface already-stored data.

---

## Problem

The 2026-04-16 API surface audit found that the DB stores **30+ fields per anchor** plus linked manifests, audit events, and extraction_manifests — but `/verify/{publicId}`, `/ai/extract`, `/attestations/{publicId}`, and `/ai/search` return only ~15 fields each. The richest parts (compliance tags, per-field confidence, lifecycle history, zk proofs, version lineage, revocation provenance) are **stored but gated**.

Current responses look correct but feel thin. Enterprise customers pulling into Vanta / Drata / Anecdotes cannot get their control-mapping IDs. Developers get overall confidence but not per-field, so can't build fraud-flag filters. Auditors cannot reconstruct chain-of-custody because `audit_events` is logged internally, never exposed.

---

## Scope — 5 stories, all backwards-compatible nullable additions

Every addition below is a **nullable field or a new endpoint**. No existing field removed or renamed. No endpoint behavior changed. Constitution 1.8 (frozen schema) preserved because additions are explicitly allowed under the "new nullable fields" clause.

### API-RICH-01 — `GET /verify/{publicId}` rich fields

| Field | Source | Purpose |
|---|---|---|
| `compliance_controls` | `anchors.compliance_controls` JSON | SOC 2 / FERPA / HIPAA / GDPR control IDs for GRC integrations |
| `chain_confirmations` | `anchors.chain_confirmations` | Block-level maturity — is this anchor 6-confirmed yet? |
| `parent_anchor_id` + `version_number` | `anchors.parent_anchor_id`, `anchors.version_number` | Credential lineage (diploma reissue, amended license) |
| `revocation_tx_id` + `revocation_block_height` | `anchors.revocation_tx_id`, `anchors.revocation_block_height` | Revocation provenance chain |
| `file_mime` + `file_size` | `anchors.file_mime`, `anchors.file_size` | Document metadata |

**Files:** `services/worker/src/routes/verify.ts` (Zod schema), `docs/api/openapi.yaml`, `sdks/typescript/src/types.ts`, `sdks/python/arkova/types.py`

### API-RICH-02 — `POST /ai/extract` + `/verify/{publicId}` per-field confidence

| Field | Source | Purpose |
|---|---|---|
| `/verify`: `confidence_scores`; `/ai/extract`: `confidenceScores` | `extraction_manifests.confidence_scores` | Downstream confidence filtering without running another model |
| `/verify`: `sub_type`; `/ai/extract`: `subType` | `anchors.sub_type` on verification; Gemini v6 extraction fields on `/ai/extract` | Fine-grained classification |
| `description` | `anchors.description` on verification; Gemini v6 extraction fields on `/ai/extract` | 1-2 sentence human-readable summary |
| `/ai/extract`: `fraudSignals` | cross-field fraud checks output when emitted by extraction | Array of fraud indicators. `/verify` does not return `fraudSignals` today. |

**Files:** `services/worker/src/routes/ai-extract.ts`, `services/worker/src/routes/verify.ts`, SDK type updates

### API-RICH-03 — New `GET /anchor/{publicId}/lifecycle`

Returns chain-of-custody event log from `audit_events`:

```json
{
  "public_id": "ARK-DIPLOMA-1A2B3C",
  "events": [
    {"event_type": "uploaded", "timestamp": "...", "actor_role": "ORG_ADMIN"},
    {"event_type": "extraction_completed", "timestamp": "...", "actor_role": "system"},
    {"event_type": "pending_anchor", "timestamp": "...", "actor_role": "worker"},
    {"event_type": "submitted", "timestamp": "...", "actor_role": "worker", "metadata": {"tx_id": "..."}},
    {"event_type": "secured", "timestamp": "...", "actor_role": "worker", "metadata": {"block": 123456}},
    {"event_type": "verified", "timestamp": "...", "actor_role": "public"},
    {"event_type": "revoked", "timestamp": "...", "actor_role": "ORG_ADMIN"}
  ]
}
```

Actor identities scrubbed to role only — no email addresses or user IDs in public response (Constitution 1.4 + 1.6).

**Files:** new `services/worker/src/routes/anchor-lifecycle.ts`, route wiring, SDK additions

### API-RICH-04 — `/attestations/{publicId}` include evidence array

Currently returns `evidence_count` only. Add `evidence` array with per-evidence item fingerprint + mime + upload timestamp. Attestor chain included.

**Files:** `services/worker/src/routes/attestations.ts` (joined query), Zod schema update, SDK

### API-RICH-05 — New `GET /anchor/{publicId}/extraction-manifest`

Surfaces the VAI-01 verifiable-AI manifest (already stored in `extraction_manifests` table, never exposed):

- `manifestHash` — deterministic SHA-256 of extraction inputs + output
- `zkProof`, `zkPublicSignals`, `zkCircuitVersion` — present when ZK proof was generated (migration 0147 added these columns)
- `promptVersion` — hash of extraction prompt at inference time (AI-PROMPT-01)
- `modelVersion` — e.g. `gemini-golden-v6-endpoint-740332515062972416`

**Files:** new `services/worker/src/routes/anchor-extraction-manifest.ts`, SDK, OpenAPI

---

## Common acceptance criteria (every API-RICH story)

- [ ] New fields are nullable in both Zod response schema and OpenAPI spec
- [ ] Existing callers pass unchanged (snapshot-test the old shape)
- [ ] Vitest integration test covers: field present when data exists + field omitted/null when not
- [ ] SDK type updates ship in the **same PR** as the route change (TS + Python)
- [ ] `docs/api/openapi.yaml` example block updated
- [ ] `docs/confluence/15_api_changelog.md` v1.5.0 entry updated
- [ ] Frozen-schema audit: no existing field renamed, removed, or type-changed
- [ ] PII/leak audit: no `user_id`, `org_id`, `email`, or internal `anchors.id` exposed (Constitution 1.4)

---

## Out of scope (deliberate)

- **Writing to these new fields.** All 5 stories are read-only surfacing.
- **New rate-limiting tiers.** Existing rate limits still apply.
- **SDK major version bump.** All changes are additive; SDK bumps minor version only.
- **Frontend changes.** The admin dashboard already has these fields via direct Supabase queries; we're exposing to external API consumers.

---

## Priority order

1. **API-RICH-01** (Sprint 1) — highest user value per engineering hour, all DB columns already indexed.
2. **API-RICH-02** (Sprint 3) — depends on Gemini v6 extraction fields plus persisted `anchors.description` / `anchors.sub_type`; `/verify` reads the persisted anchor fields and the latest extraction manifest confidence scores.
3. **API-RICH-03** (Sprint 3) — independent, moderate effort.
4. **API-RICH-04** (Sprint 4) — blocked on no one.
5. **API-RICH-05** (Sprint 4) — only valuable when ZK proofs actually populate the column; currently sparse.

---

## References

- Audit: `docs/BACKLOG.md` TIER 0I (API Response Richness)
- Frozen schema rule: `CLAUDE.md` Constitution 1.8
- Existing VAI-01 storage: migration 0147, `extraction_manifests` table
- Existing compliance mapping: CML-01, CML-02 (migration 0137)
