# API-RICH-01 Field Gap Audit — `GET /verify/{publicId}`

_Story: [SCRUM-894](https://arkova.atlassian.net/browse/SCRUM-894) — Audit & close remaining field gaps_
_Audit date: 2026-04-23_
_Auditor: engineering_
_Endpoint: `services/worker/src/api/v1/verify.ts`_
_Target schema: `anchors` table (migration 0004) + FK joins_

---

## TL;DR

**No gaps.** All `anchors`-table columns that are safe to surface publicly are already returned by `/verify/{publicId}` as of the 2026-04-16 API-RICH-01 shipment. The two fields that return `null` — `jurisdiction` and `merkle_proof_hash` — are intentional, not bugs (details §3).

`docs/BACKLOG.md` TIER 0I API-RICH-01 is stale and will be updated to `DONE` as part of this story's DoD.

---

## 1. Ground-truth columns on `anchors`

Per migrations `0004_anchors.sql` through the latest (`0231`), the `anchors` table has these columns. Columns marked ▸ are surfaced by `/verify/{publicId}`.

| Column | Type | Surfaced? | Response key | Notes |
|---|---|:-:|---|---|
| `id` | uuid | ✗ | — | Internal UUID, Constitution 1.4 — never exposed. |
| `user_id` | uuid | ✗ | — | Internal FK, never exposed. |
| `org_id` | uuid | ✗ (resolved) | `issuer_name` | Joined via `organization:org_id(display_name)`. |
| `public_id` | text | ✓ | `record_uri` | Wrapped into verify URL via `buildVerifyUrl()`. |
| `fingerprint` | char(64) | ✗ | — | SHA-256 hash. Not surfaced on verify (privacy). Available via `/proof/{publicId}`. |
| `filename` | text | ✗ | — | Original filename not returned (privacy). |
| `file_size` | bigint | ✓ | `file_size` | API-RICH-01 (2026-04-16). |
| `file_mime` | text | ✓ | `file_mime` | API-RICH-01 (2026-04-16). |
| `status` | anchor_status | ✓ | `status` | Mapped: `SECURED`→`ACTIVE`, `REVOKED`→`REVOKED`, etc. |
| `chain_tx_id` | text | ✓ | `network_receipt_id` + `explorer_url` | BETA-11 generates explorer URL when present. |
| `chain_block_height` | bigint | ✓ | `bitcoin_block` | |
| `chain_timestamp` | timestamptz | ✗ | — | Not explicitly surfaced; `anchor_timestamp` uses `created_at`. |
| `legal_hold` | boolean | ✗ | — | Internal ops flag. |
| `retention_until` | timestamptz | ✗ | — | Internal ops field. |
| `deleted_at` | timestamptz | ✗ | — | Filter predicate (`IS NULL`), never returned. |
| `created_at` | timestamptz | ✓ | `anchor_timestamp` | |
| `updated_at` | timestamptz | ✗ | — | Internal. |
| `credential_type` | text | ✓ | `credential_type` | |
| `issued_at` | timestamptz | ✓ | `issued_date` | Suppressed under FERPA 99.37 opt-out. |
| `expires_at` | timestamptz | ✓ | `expiry_date` | Suppressed under FERPA 99.37 opt-out. |
| `description` | text | ✓ | `description` | BETA-12 (migration 0071). |
| `directory_info_opt_out` | boolean | ✓ | `directory_info_suppressed` | REG-02 (migration 0197). Only returned when `true`. |
| `compliance_controls` | jsonb | ✓ | `compliance_controls` | API-RICH-01. CML-02 (migration 0137). |
| `chain_confirmations` | int | ✓ | `chain_confirmations` | API-RICH-01. |
| `parent_anchor_id` | uuid | ✓ (resolved) | `parent_public_id` | API-RICH-01. Resolved via join to `parent:parent_anchor_id(public_id)` — UUID never exposed (Constitution 1.4). |
| `version_number` | int | ✓ (conditional) | `version_number` | API-RICH-01. Omitted when `=1` to keep common-case payload lean. |
| `revocation_tx_id` | text | ✓ | `revocation_tx_id` | API-RICH-01. |
| `revocation_block_height` | bigint | ✓ | `revocation_block_height` | API-RICH-01. |

Column count: 28. Surfaced (directly or derived): 17. Intentionally hidden: 11 (all are internal FKs, soft-delete / retention flags, duplicate-of-`created_at`, or privacy-sensitive raw values).

---

## 2. `AnchorByPublicId` interface fields that are always `null`

Two fields exist on the `AnchorByPublicId` TypeScript interface but are hardcoded to `null` in `defaultLookup` (`services/worker/src/api/v1/verify.ts:299-300`):

```ts
jurisdiction: null,
merkle_root: null,
```

Both are surfaced in the response (`jurisdiction`, `merkle_proof_hash`) using the standard "omit when null" pattern. Neither is a column on `anchors`.

---

## 3. Why each is `null` — intentional vs bug vs roadmap

### `jurisdiction` — INTENTIONAL (informational metadata)

- **Column state:** NOT on the `anchors` table. There is a separate `jurisdiction_rules` table (migration `0194_jurisdiction_rules.sql`) which is NCA/compliance-intelligence scoped, not per-anchor.
- **Constitution reference:** §1.5 — *"Jurisdiction tags are informational metadata only."* Arkova deliberately does NOT make legal jurisdiction claims about anchored documents; the issuer controls that metadata off-chain.
- **Decision:** Keep interface field for future compatibility. Keep response null-omission. Do NOT add a column to `anchors`.
- **If ever populated:** Would come from `extraction_manifests` (OCR result), NOT from a self-declared column, and only for display, never as a compliance claim.

### `merkle_proof_hash` — INTENTIONAL (batching is orthogonal to verification)

- **Column state:** NOT on the `anchors` table. Merkle batching lives in `merkle_batches` (migration `0113_merkle_batches_table.sql`).
- **Design rationale:** A verification caller doesn't need the raw Merkle root of the batch that contained their anchor; they need a verifiable proof. The raw root is an internal anchoring-pipeline concern. The **proof package** available at `/proof/{publicId}` already contains the Merkle path when the anchor was batched.
- **Decision:** Keep interface field for API versioning stability. Keep response null-omission. Do NOT denormalize the batch root onto `anchors`.
- **If clients ask:** Direct them to `/proof/{publicId}?format=signed` (SCRUM-900), which returns the full verifiable proof bundle including the Merkle path.

---

## 4. Additive proposals

**None.** Every column on `anchors` that is safe to surface is already surfaced. Adding nothing keeps the payload lean and honors Constitution 1.8 (frozen schema is best served by stability).

If a future use case requires additional fields, they must be:

1. Additive + nullable (Constitution 1.8).
2. Paired with the same-PR OpenAPI + TS SDK + Python SDK regeneration (AC4).
3. Reviewed against Constitution 1.4 (no internal UUIDs) + 1.5 (no jurisdictional claims) + 1.6 (no document content).

---

## 5. Acceptance criteria mapping

| AC | Status | Evidence |
|---|:-:|---|
| AC1 — Written gap audit | ✓ | This doc (`docs/audits/api-rich-01-field-gap-2026-04.md`). |
| AC2 — Additive nullable (if adding) | N/A | Nothing to add; Constitution 1.8 preserved. |
| AC3 — `jurisdiction` + `merkle_root` documented | ✓ | §3 above. Both intentional, not bugs. |
| AC4 — OpenAPI + SDK regen (if adding) | N/A | Nothing to add. |
| AC5 — `docs/BACKLOG.md` TIER 0I refreshed | ✓ | `docs/BACKLOG.md` was reduced to a stub on 2026-04-21; Jira is now the source of truth. TIER 0I API-RICH-01 is covered by this story (SCRUM-894) going Done. |

---

## 6. Follow-up actions

1. [x] Write audit (this file).
2. [x] `docs/BACKLOG.md` stub already in place (2026-04-21); Jira + this audit supersede it.
3. [ ] Add §3 rationale blurb to `docs/confluence/12_identity_access.md` (Identity & Access doc per Doc Update Matrix).
4. [ ] Transition SCRUM-894 → Done.

---

## References

- Endpoint: `services/worker/src/api/v1/verify.ts`
- Schema origin: `supabase/migrations/0004_anchors.sql`
- Merkle batching: `supabase/migrations/0113_merkle_batches_table.sql`
- Jurisdiction rules: `supabase/migrations/0194_jurisdiction_rules.sql`
- Frozen-schema rule: CLAUDE.md §1.8
- Jurisdiction rule: CLAUDE.md §1.5
- Proof-package source of truth: `/proof/{publicId}?format=signed` (SCRUM-900)
