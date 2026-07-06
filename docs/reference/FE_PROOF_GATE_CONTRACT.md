# FE-PROOF-GATE Contract — SECURED-only proof download (S3-D → SCRUM-2501)

> **Lane 1 → Lane 2 handoff contract.** Lane 1 owns the API truth in this document; Lane 2 owns the pixels
> and the final copy in `src/lib/copy.ts`. Lane 2 must not ship a fake proof, a fabricated download, or a
> raw 404 error toast. Every claim below is grounded in code at the file:line cited — if the code moves,
> re-verify before trusting a line number; the field names and verbatim strings are the contract.
>
> Per CLAUDE.md §0 rule 4, Confluence is the documentation source of truth; this file is the internal
> engineering contract mirror (same convention as `docs/reference/X402_API_ARCHITECTURE.md`).

- **Story:** SCRUM-2501 — SECURED-only proof download (Sprint 3, S3-D)
- **API owner:** Lane 1 (this contract). **UI owner:** Lane 2.
- **Endpoint under contract:** `GET /api/v1/verify/:publicId/proof`
- **Grounding baseline:** `main` @ merge `f927494e` (PR #1366), 2026-07-06.

---

## 1. Endpoint truth

### 1.1 Route and mounting

| Fact | Source |
|---|---|
| Handler: `router.get('/:publicId/proof', …)` | `services/worker/src/api/v1/verify-proof.ts:519` |
| Mounted at `/verify` — comment: "Merkle proof endpoint — public, no payment required (BTC-003)" | `services/worker/src/api/v1/router.ts:228-229` |
| v1 router mounted at `/api/v1` | `services/worker/src/index.ts:458` |
| **Effective URL:** `GET /api/v1/verify/:publicId/proof` | composition of the above |

### 1.2 Access model (what Lane 2's fetch layer must assume)

- **Public, anonymous GET.** The proof router is mounted *before* the `requireScope('verify')` +
  x402 payment gate that wraps the general `/verify` router (`router.ts:229` vs `router.ts:233-243`).
  No API key, no session, no payment step for this endpoint.
- **Feature-flagged:** the whole v1 surface is gated by `ENABLE_VERIFICATION_API`
  (CLAUDE.md §1.9; `index.ts:458` mount comment "gated behind ENABLE_VERIFICATION_API flag").
- **Rate limits:** anonymous traffic is limited to 100 req/min/IP with `Retry-After` on 429
  (CLAUDE.md §1.10; `router.ts:236` "rate-limited upstream at 100/min"). Lane 2 must treat 429 as
  transient (back off; do not render the empty-state or an error state from a 429).
- **Optional `?format=signed`** — wraps the same payload in a detached Ed25519 envelope. Not required
  for SCRUM-2501; documented in §2.5 because Lane 2 must not accidentally send it.

### 1.3 What the route does — and does NOT — check

Read this carefully; it is the one place reality differs from the story's shorthand:

1. Validates `publicId` (length ≥ 3, else 400) — `verify-proof.ts:522-525`.
2. Looks up the anchor by `public_id` with `deleted_at IS NULL` — `verify-proof.ts:536-541`.
   Missing/deleted ⇒ **404 `Record not found`** (`verify-proof.ts:655`).
3. Looks up the stored proof row in `anchor_proofs` (`merkle_root, proof_path, batch_id, merkle_index,
   block_header, block_hash, op_return_payload, proof_schema_version`) — `verify-proof.ts:549-553`;
   falls back to legacy `anchors.metadata` merkle fields — `verify-proof.ts:456` via
   `extractMetadataProof` (`verify-proof.ts:327-352`).
4. No proof from either source ⇒ **404 `No Merkle proof available…`** (`verify-proof.ts:614-619`).
5. **The route never reads `anchor.status`.** `status` is selected into `ProofAnchorData`
   (`verify-proof.ts:538,560`) but no branch in `buildProofResponse` or the route consults it.
   Availability is **proof-existence-gated, not status-gated**. The "SECURED-only" property is
   enforced upstream by the producers, not by this route — see §4.

---

## 2. Response catalogue (real shapes, from code — do not invent fields)

### 2.1 `200 OK` — `MerkleProofResponse` (`verify-proof.ts:177-197`)

```jsonc
{
  "public_id": "string",
  "fingerprint": "string",
  "merkle_root": "string",
  "merkle_proof": [ { "hash": "string", "position": "left" | "right" } ],
  "tx_id": "string | null",
  "block_height": "number | null",
  "block_timestamp": "string | null",
  "batch_id": "string | null",
  "verified": "boolean",            // cryptographic recompute of the root — NEVER derived from anchors.status (verify-proof.ts:187-191, 494-499)
  "proof_bundle": "ProofBundle | null"  // additive nullable (§1.8); null whenever the two-layer proof is incomplete
}
```

`proof_bundle` (`ProofBundle`, `verify-proof.ts:132-174`) — the CANONICAL self-contained packet
(frozen; PROOF-04 PDF and PROOF-07 CLI conform to it):

```jsonc
{
  "fingerprint": "string",
  "merkle_root": "string",
  "merkle_proof": [ { "hash": "string", "position": "left" | "right" } ],
  "merkle_index": "number | null",
  "leaf_count": "number",               // count of anchor_proofs rows sharing batch_id — arms the CVE-2012-2459 guard
  "tx_id": "string | null",
  "block_height": "number | null",
  "block_hash": "string | null",        // 64-hex when present
  "block_header": "string | null",      // 160-hex (raw 80-byte header) when present
  "op_return_payload": "string | null", // "41524b56" (ARKV) + 64-hex root, must commit THIS merkle_root
  "block_timestamp": "string | null",
  "proof_schema_version": "number",     // 1 = plain double-SHA256; non-null
  "signature": "null"                   // RESERVED — always null on the unsigned path (verify-proof.ts:165-173)
}
```

`proof_bundle` is emitted **only** when the full two-layer proof is complete
(`buildProofBundle`, `verify-proof.ts:383-425`): receipt fields present (`tx_id`, `block_height`,
`block_timestamp`), `merkle_index` + `leaf_count` present and in-range, `block_header` exactly 160 hex,
`block_hash` exactly 64 hex, and `op_return_payload` in canonical ARKV shape **committing this exact
`merkle_root`**. Any miss ⇒ `proof_bundle: null` — never a partial or fabricated bundle (§1.5).

### 2.2 `404 Not Found` — TWO distinct bodies (match on these verbatim)

| Condition | Verbatim body | Source |
|---|---|---|
| Record exists (not deleted) but **no Merkle proof** from `anchor_proofs` or metadata — i.e. direct-anchored / back-catalog | `{"error":"No Merkle proof available for this record. It may not have been batch-anchored."}` | `verify-proof.ts:615-617` (db path) and `verify-proof.ts:662-664` (injected-lookup path) — identical string, asserted in `__tests__/verify-proof.test.ts:142,157` |
| Unknown `publicId`, or record soft-deleted (`deleted_at` set) | `{"error":"Record not found"}` | `verify-proof.ts:655` |

**These two 404s mean different things.** The first is the honest **state-2** signal (§3). The second
means Lane 2's record reference is stale — that is a real error state, not an empty state.

### 2.3 `400 Bad Request`

`{"error":"Invalid publicId parameter"}` — `publicId` missing or shorter than 3 chars
(`verify-proof.ts:522-525`). Lane 2 should never trigger this with a real record's `public_id`.

### 2.4 `500 Internal Server Error` — three distinct bodies

| Verbatim body | Meaning | Source |
|---|---|---|
| `{"error":"Merkle proof data is malformed"}` | Stored proof/metadata failed shape validation | `verify-proof.ts:309,332-339` |
| `{"error":"Proof leaf count could not be determined; verification is indeterminate."}` | Batch-linked proof whose exact leaf count could not be resolved — FAIL-CLOSED, never a downgraded verdict | `verify-proof.ts:468-470` |
| `{"error":"Internal server error"}` | Unhandled exception | `verify-proof.ts:708` |

All 500s are transient/ops states for Lane 2: show a retryable "could not load" affordance,
**never** the state-2 empty state (that would misreport a data fault as "not batch-anchored").

### 2.5 `?format=signed` (out of scope for SCRUM-2501 — do not send)

- `200`: envelope `{ payload, signature: { alg, value }, signing_key_id, signed_at_utc, bundle_version }`
  (`services/worker/src/proof/signed-bundle.ts:8,60-64`) — note the top-level shape **differs** from §2.1.
- `503` when no signer configured: `{"error":"Signed proof bundle is not configured in this environment. Set PROOF_SIGNING_KEY_PEM + PROOF_SIGNING_KEY_ID or call without ?format=signed."}`
  (`verify-proof.ts:629-634, 678-684`).

---

## 3. THE CONTRACT — three states (plus one honest edge)

State detection uses TWO inputs: the record's status (already available to the page — dashboard reads
`anchors.status` via Supabase; the public verify API maps `SECURED → "ACTIVE"` per
`services/worker/src/api/v1/verify.ts:72-90,155-156`) and the `/proof` response.

| State | Record condition | `/proof` result | Lane 2 renders |
|---|---|---|---|
| **1 — Proof available** | SECURED + Merkle proof persisted (batch-anchored, two-layer proof complete) | `200` with `verified: true` **and** `proof_bundle !== null` | **Download affordance live.** The downloaded artifact is the `proof_bundle` object (canonical packet, §2.1) — never a hand-assembled subset. |
| **1b — Edge: partial proof** | SECURED + app-tree branch stored but layer-2 evidence incomplete (legacy metadata-proof records; FIX-1 rows awaiting PROOF-03 population) | `200` with `proof_bundle: null` (and possibly `verified: true`) | **Same honest empty-state as state 2** for the self-contained download — a complete downloadable packet does not exist yet. Do not synthesize one from the top-level fields. |
| **2 — Secured, direct-anchored (THE HONEST CORE)** | SECURED + no Merkle proof (direct-anchored). This is effectively the entire back catalogue today — the ~2.97M already-SECURED prod anchors have no app-tree branch (grounded in-repo: `supabase/migrations/0340_…_trigger.sql:17-19` "the ~2.97M anchors already SECURED have no app-tree branch yet (PROOF-01 §4 back-catalog)"; prod count 2,972,264 verified 2026-07-02) | `404` `{"error":"No Merkle proof available for this record. It may not have been batch-anchored."}` | **HONEST EMPTY-STATE.** Explicitly **NOT** an error toast. **NOT** a disabled "Download proof" button. **NO download control rendered at all.** See §3.1. |
| **3 — Not SECURED** | `PENDING` / `BROADCASTING` / `SUBMITTED` (lifecycle per `machines/bitcoinAnchor.machine.ts:48`) | Typically `404` (no proof row yet) — but do not rely on calling `/proof` to detect this state; key off the record status you already have | **Securing-in-progress** presentation. No proof bundle exists or is promised yet. A disabled/progress affordance is acceptable *here* (unlike state 2) because the record genuinely is mid-securing. |

Additional handling rules:

- `404` `{"error":"Record not found"}` → stale/deleted record reference. Real error state (not state 2).
- `429` → back off and retry; render neither empty-state nor error from it.
- `5xx` → retryable "could not load proof availability" affordance; never state-2 copy.
- `verified: false` on a `200` → **do not offer the download** even if `proof_bundle` is non-null.
  `verified` is the cryptographic recompute verdict (`verify-proof.ts:187-191`); offering a download
  whose branch does not recompute to its committed root would ship a fake proof. Treat as an
  ops/error state and surface it to Lane 1 — this combination indicates a data fault.
- **Status is a required belt-and-braces check.** Because the route is proof-existence-gated (§1.3),
  a REVOKED/SUPERSEDED record that once had a proof row can still return `200`. Lane 2's gate is
  `status is SECURED (public alias "ACTIVE") AND /proof 200 AND verified === true AND proof_bundle !== null`.
  Revoked/superseded/expired records follow their existing status presentations, not this contract's state 1.

### 3.1 State 2 — recommended copy frame (Lane 2 owns final wording in `src/lib/copy.ts`)

Requirements the final copy MUST satisfy:

1. **Affirm the record's standing first**: it is Secured and anchored. The absence of a downloadable
   packet is not a defect in the record and must not read as one.
2. **Explain availability honestly**: a self-contained, independently checkable proof file becomes
   available once the record is batch-anchored. Do not promise a date, do not say it is "being
   generated," and do not imply the user must act.
3. **Point to the evidence already on the page**: the Fingerprint and the Network Receipt (and
   Network Observed Time where shown) are already displayed and remain the record's verification
   surface today.
4. **Render no download control** — no disabled button, no greyed link, no spinner. An affordance
   that exists-but-is-disabled implies a temporary fault; this state is a truthful, stable "not
   applicable yet."

Suggested frame (illustrative only — final strings are Lane 2's, in `src/lib/copy.ts`, and must pass
`npm run lint:copy`):

> **Secured & anchored.** This record is protected on the Production Network — its Fingerprint and
> Network Receipt above are its proof of standing. A downloadable proof file becomes available for
> records secured through batch anchoring.

---

## 4. The SECURED-only rule — where it is actually enforced

The story's shorthand "SECURED-only proof download" is true in effect but the enforcement is
distributed. Lane 2 should understand the chain, because the route itself does not check status (§1.3):

1. **`anchor.status = 'SECURED'` is worker-only** via service_role (CLAUDE.md §1.4). The transition
   is executed by the confirmation cron (`services/worker/src/jobs/check-confirmations.ts:284,1073`)
   and formally constrained in `machines/bitcoinAnchor.machine.ts:73` ("Enforces that only worker can
   transition to SUBMITTED/SECURED") and `:122` (the SUBMITTED → SECURED transition).
2. **Proof rows are produced only for SECURED anchors.** Layer-2 evidence population filters
   `.eq('anchors.status', 'SECURED')` (`services/worker/src/jobs/confirmation-proof-populate.ts:253`),
   and the branch backfill does the same (`services/worker/src/jobs/proof-branch-backfill.ts:105`).
3. **A DB-level enforcement trigger exists but is INERT.** Migration
   `supabase/migrations/0340_scrum2335_proof_completeness_columns_and_trigger.sql` ships a gated
   "SECURED ⇒ proof complete" constraint trigger behind GUC `arkova.proof_enforce_secured_complete`,
   default OFF until the SCRUM-2471 backfill completes (two-phase rollout, lines 17-28).

Net effect: a record that returns a `200` proof today is SECURED — but that is an emergent property
of the producers, not a route guarantee, which is why §3's gate includes the status check on the
FE side.

---

## 5. Claims discipline (CLAUDE.md §1.5 / §1.13 R-7)

Every proof-related surface Lane 2 builds states what is measured, what is asserted, and what is
NOT asserted:

- **MEASURED** — the document **Fingerprint**; the **Network Receipt** (`tx_id` internally); the
  **Network Observed Time** (`block_timestamp` internally, displayed per §1.5 as "Network Observed
  Time"); and, when a bundle exists, the cryptographic recompute verdict (`verified`).
- **ASSERTED** — the record is Secured (its lifecycle status, transitioned worker-side per §4).
- **NOT ASSERTED** — that a downloadable, self-contained Merkle-proof file exists for this record.
  For state-2 records it does not, and no UI element may imply otherwise (no disabled download, no
  "proof coming soon" without PO-approved copy).

The `/proof` endpoint itself follows the same discipline: `proof_bundle` is `null` rather than
partial, and `verified` is recomputed, never inferred from status (`verify-proof.ts:96-126,187-191`).

---

## 6. Banned-terms compliance (CLAUDE.md §1.3 — UI copy only)

All user-visible strings live in `src/lib/copy.ts` and are CI-enforced by `npm run lint:copy`.
For this feature specifically:

| Never in UI copy | Use instead |
|---|---|
| Hash | **Fingerprint** |
| Transaction / tx | **Network Receipt** / Anchor Receipt |
| Block, block height, block header | avoid entirely; times display as **"Network Observed Time"** |
| Bitcoin / Blockchain / Mainnet / Testnet | **Production Network** / Test Environment |
| Broadcast | avoid ("anchored", "secured") |
| Merkle (jargon in end-user copy) | "proof file" / "downloadable proof" in end-user surfaces; "Merkle" already appears in existing technical labels (e.g. `copy.ts:435 PROOF_FINGERPRINT: 'Merkle Proof'`) — follow Lane 2's page conventions, do not add new jargon |

The downloaded JSON artifact is a technical file, not UI copy — its field names (`tx_id`,
`block_header`, `merkle_root`, …) are the frozen API contract and MUST NOT be renamed to satisfy
§1.3. §1.3 governs the strings around the control, not the packet contents.

Existing related copy Lane 2 will touch or reuse: `DOWNLOAD_PROOF: 'Download Proof'`
(`src/lib/copy.ts:265,1017`) and the PROOF-04 certificate strings (`copy.ts:779-840`).

---

## 7. Lane-1 sign-off checklist (required before SCRUM-2501 is Done)

Lane 1 co-reviews Lane 2's implementation. All boxes ticked before the story transitions:

- [ ] All states demonstrated against a running dev server: state 1 (200 + bundle), state 1b
      (200 + `proof_bundle: null`), state 2 (404 "No Merkle proof available…"), state 3 (not SECURED),
      plus `Record not found` and a 5xx.
- [ ] **1280px and 375px screenshots of every state in the PR** (CLAUDE.md §0 rule 6).
- [ ] State 2 renders NO download control, NO error toast, NO disabled button — verified in DOM,
      not just visually.
- [ ] 404 branch matches on response shape/status, not on substring-matching the error prose in a
      brittle way (the string is stable and test-asserted, but status+which-404 is the discriminator:
      "No Merkle proof available…" vs "Record not found" must route to different presentations).
- [ ] Download only enabled when `status SECURED/ACTIVE && 200 && verified === true && proof_bundle !== null`;
      downloaded artifact is the unmodified `proof_bundle` object.
- [ ] All new strings in `src/lib/copy.ts`; `npm run lint:copy` green; no §1.3 banned terms.
- [ ] Playwright E2E spec covering the three states (§1.7 — every user-facing flow requires an E2E
      spec before COMPLETE).
- [ ] `typecheck`, `lint`, `test` green; UAT screenshots logged; any regressions logged in the
      Bug Tracker master log (Confluence 88768514).
- [ ] Lane 1 reviewer sign-off recorded on the PR (co-review is the handoff's closing gate).

---

## 8. What changes when the batch-anchoring producer goes live

- **New anchors:** records anchored through the batch path get app-tree branches inline (FIX-1 /
  SCRUM-2471 write-at-broadcast) and layer-2 evidence via the confirmation-proof job (PROOF-03 /
  SCRUM-2336, `confirmation-proof-populate.ts`). Those records transition **state 2 → state 1**
  naturally as their proofs complete. Lane 2 needs no UI change for this — the same gate in §3
  starts returning 200-with-bundle for new records.
- **Historical direct-anchored records (the ~2.97M back catalogue):** they remain **state 2 unless
  re-anchored or backfilled**. A self-validating backfill job exists in code
  (`services/worker/src/jobs/proof-branch-backfill.ts` — manual-trigger only, explicitly "NOT for
  prod (in this change)" per its header, lines 31-37), and some legacy batches are marked
  unrecoverable by design. **Whether the back catalogue is backfilled or re-anchored in prod is a
  pending PO decision — this contract does not assert it either way**, and Lane 2's copy must not
  promise it (§5 NOT-ASSERTED).
- If/when the 0340 enforcement GUC flips on (§4.3), the SECURED⇒proof-complete invariant becomes a
  DB guarantee for *new* transitions; the FE contract in §3 is unchanged.

---

## 9. Reality-vs-plan notes (deltas Lane 2 should know)

1. **The route is proof-gated, not status-gated** (§1.3, §4). "SECURED-only" is enforced by the
   producers + the FE status check, not by a status branch in `verify-proof.ts`.
2. **A 200 does not imply a downloadable bundle** — `proof_bundle` can be `null` (state 1b). Gate the
   affordance on the bundle, not on the HTTP status.
3. **There are two different 404 bodies.** Only "No Merkle proof available…" is the state-2 signal.
4. **`verified: false` on a 200 is possible** and must suppress the download (§3).
5. The existing RecordDetailPage PROOF-04 certificate path sources proof data client-side from
   Supabase (`src/lib/sourceProofInput.ts`), not from this endpoint. SCRUM-2501's gate is about the
   `/proof` API surface; keep the two presentations consistent (a page must not simultaneously claim
   "no proof file" and successfully embed a complete packet in the PDF).

---

_Contract owner: Lane 1 (S3-D). Questions or drift found in code → flag on the SCRUM-2501 PR and
update this file in the same change. Last grounded: 2026-07-06 against `main` @ `f927494e`._
