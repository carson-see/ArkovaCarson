# FE-PROOF-GATE Contract — PI-0 Sprint 2 (Trust & Chain)

> **Status:** FROZEN for Sprint 2. Lane 1 owns this contract; Lane 2 (SCRUM-2501)
> consumes it. Changes after freeze are a handoff, not a reach-in — open a
> follow-up and notify both lanes.
>
> **Source of truth note:** this markdown is an internal engineering contract
> (per CLAUDE.md §4 it is NOT product documentation — the canonical spec lives
> on the Confluence story pages for SCRUM-2337 / SCRUM-2501). It exists so the
> two lanes can build against one frozen shape without blocking on each other.

Produced by: **PROOF-04 — PDF embeds proof JSON (SCRUM-2337)**, Lane 1.
Consumed by: **SCRUM-2501**, Lane 2.

---

## 1. Why this contract exists

The downloadable audit certificate (PDF) and the JSON proof package both carry
the same cryptographic *proof packet* — the minimum set of fields a third party
needs to re-verify a document **offline**, without contacting Arkova. PROOF-04
froze that packet shape and the gating rule. PROOF-05 (`proof_bundle`) and any
Lane 2 surface that renders or downloads proof MUST consume the same shape and
the same gate so the two never drift.

Three things are frozen here:

1. **The proof packet shape** (`ProofPacket`) — which IS the canonical
   `proof_bundle` field-for-field (PROOF-05 emits it, PROOF-07 CLI parses it).
2. **The optional Lane 2 download envelope** that wraps that packet verbatim.
3. **`isProofDownloadable(status) === SECURED-only` semantics** + the badge rule.

---

## 2. The proof packet — `ProofPacket` ≡ the canonical `proof_bundle` (PROOF-04 embedded JSON)

Canonical TypeScript source: `src/lib/generateAuditReport.ts`
(`export interface ProofPacket`). This is the JSON embedded in the certificate
PDF (both rendered visibly and stored verbatim in the PDF document properties
under `keywords`, subject `arkova-proof-packet`).

**This packet IS the canonical `proof_bundle` shape — field-for-field.** It is
what PROOF-05 (`services/worker/src/api/v1/verify-proof.ts` → `interface
ProofBundle`, SCRUM-2338) emits on `GET /api/v1/verify/:publicId/proof`, and what
the PROOF-07 reference CLI (`packages/verifier-cli/src/types.ts` → `interface
ProofPacket`) parses. The PDF embeds it **verbatim** — same field names, same
nullability — so the three never drift. The `merkle_proof` branch is the
structured `MerkleProofEntry[]` (`{ hash, position }`) used by the verify-proof
API; it is **never** flattened to `string[]` (that would drop the `position`
each sibling needs and the offline verifier could not recompute the root).

```jsonc
{
  "fingerprint":          "<64-hex SHA-256 of the document>",
  "merkle_root":          "<64-hex>|null",
  "merkle_proof": [                             /* ordered sibling branch, NOT string[] */
    { "hash": "<64-hex>", "position": "left" | "right" }
  ] | null,
  "merkle_index":         3 | null,             /* leaf position in the tree */
  "leaf_count":           8 | null,             /* total leaves — enables CVE-2012-2459 guard */
  "tx_id":                "<64-hex network receipt id>" | null,
  "block_height":         850123 | null,
  "block_hash":           "<64-hex>" | null,
  "block_header":         "<160-hex raw 80-byte header>" | null,
  "op_return_payload":    "<hex>" | null,       /* "ARKV"+root, NO version byte */
  "proof_schema_version": 1,                    /* NON-null; defaults to 1 */
  "block_timestamp":      "2026-06-02T03:00:00Z" | null, /* ISO-8601 UTC (machine field) */
  "signature": {                                /* envelope metadata, or null on unsigned path */
    "alg":            "Ed25519",
    "signing_key_id": "treasury-ed25519-1"
  } | null
}
```

> **Renamed since the first draft (this rework):** `observed_time` → `block_timestamp`
> (the machine field; the PDF's *human-readable* label may still read
> "Network Observed Time"). `merkle_proof` `string[]` → `{ hash, position }[]`.
> `proof_schema_version` is now non-null (defaults to `1`). Added `merkle_index`
> + `leaf_count`. `signature` is `{ alg, signing_key_id } | null` (was
> `{ algorithm, key_id? }` optional). **Lane 2 (SCRUM-2501) must build against
> this corrected shape**, not the earlier `string[]` / `observed_time` draft.

### Field provenance (DB columns → packet)

| Packet field | Source column | Notes |
|---|---|---|
| `fingerprint` | `anchors.fingerprint` | SHA-256, browser-computed for uploads (§1.6) |
| `merkle_root` | `anchor_proofs.merkle_root` | `text` (hex as-is) |
| `merkle_proof` | `anchor_proofs.proof_path` | `Json` array of `{ hash, position }`; **validated + preserved whole**, never flattened to strings |
| `merkle_index` | `anchor_proofs.merkle_index` | `int` |
| `leaf_count` | derived: `count(anchor_proofs WHERE batch_id = <row.batch_id>)` | arms the CLI's CVE-2012-2459 guard. Sourced the same way the server does (PROOF-05): RLS-scoped `head:true` count of the batch's proof rows (a number, no PII). Single-leaf / un-batched rows → `1`. If a batch member's count cannot be sourced, the packet ships `leaf_count: null` and is flagged **incomplete** (`proofComplete: false`) — the certificate then drops the "complete proof" claim. See `src/lib/sourceProofInput.ts`. |
| `tx_id` | `anchors.chain_tx_id` → fallback `anchor_proofs.receipt_id` | |
| `block_height` | `anchor_proofs.block_height` → fallback `anchors.chain_block_height` | |
| `block_hash` | `anchor_proofs.block_hash` | `text` (hex as-is) |
| `block_header` | `anchor_proofs.block_header` | `bytea` → emit as hex string; see project memory `proof_bytea_vs_text_storage` |
| `op_return_payload` | `anchor_proofs.op_return_payload` | `text` hex; "ARKV"+root, no version byte |
| `proof_schema_version` | `anchor_proofs.proof_schema_version` | `int` NOT NULL; defaults to `1` if absent |
| `block_timestamp` | `anchor_proofs.block_timestamp` → fallback `anchors.chain_timestamp` | ISO-8601 UTC |
| `signature` | (treasury signer metadata) | `{ alg, signing_key_id }` or `null` — **never** a private key |

### Hard rules for the packet (§1.5 / §1.6)

- **Allow-list only.** The packet is a strict subset of cryptographic fields.
  It MUST NOT contain document bytes, raw file content, `filename`, `issuerName`,
  `file_size`, `mime_type`, `user_id`, `org_id`, or any record identifier
  (`public_id`, anchor `id`). `buildProofPacket()` enforces this; PROOF-04 unit
  tests assert it (`src/lib/generateAuditReport.test.ts`).
- **Client-side only.** Generation runs in the browser. No worker import of the
  PDF/packet builder.
- **`null` is allowed; omission is not required** for the embedded packet (unlike
  the frozen public API where `jurisdiction: null` must be omitted). The packet
  uses explicit `null` for absent cryptographic fields so the schema is stable.
- **Claims discipline (§1.5):** the certificate states the fingerprint was
  *observed* at `block_timestamp` (labelled "Network Observed Time" in the PDF);
  it does NOT assert content accuracy, issuer identity, or credential validity.

---

## 3. `proof_bundle` envelope (PROOF-05 / SCRUM-2501 consumes)

The §2 `ProofPacket` IS the `proof_bundle` payload — Lane 2 (SCRUM-2501) and the
PROOF-07 CLI consume that object directly. PROOF-05's API returns it as the
`proof_bundle` key on the (frozen, additive-nullable) `MerkleProofResponse`.

When Lane 2 needs a richer download envelope (e.g. to carry display-only,
PII-safe record metadata alongside the proof), it wraps the §2 packet as
`packet` below. The embedded `packet` MUST be the §2 object **verbatim — same
field names, same order, same nullability** as what the PROOF-04 PDF embeds and
PROOF-05 emits. Do not re-derive, rename (`block_timestamp`, not
`observed_time`), or re-shape the branch (`{ hash, position }[]`, not
`string[]`). With that rule the embedded packet is genuinely byte-for-byte the
same object the API and CLI handle.

```jsonc
{
  "bundle_version": "1.0",                 // envelope version (string literal)
  "generated_at":   "2026-06-29T16:40:00Z",// ISO-8601 UTC, when the bundle was built
  "record": {                              // display-only, PII-safe metadata
    "public_id":       "rec_abc123",       // PUBLIC id only — never anchor.id/user_id/org_id
    "status":          "SECURED",          // raw enum (gate input; see §4)
    "status_display":  "Verified",         // from getStatusDisplay(status).label
    "credential_type": "DIPLOMA" | null
  },
  "packet": { /* ...exact ProofPacket from §2... */ },
  "verifier": {
    "reference_url": "https://arkova.ai/verify",   // offline reference verifier
    "schema_version": 1                            // mirrors packet.proof_schema_version
  }
}
```

Rules:

- `record` carries **only** `public_id` (never `anchors.id`, `user_id`, `org_id`),
  the raw `status`, its `status_display` label, and `credential_type`. No
  filename, no issuer, no file size.
- `packet` is the §2 object verbatim.
- A `proof_bundle` is produced **only** when `isProofDownloadable(status)` is true
  (see §4). For non-SECURED records, no bundle is emitted and the download
  affordance is hidden.

---

## 4. `isProofDownloadable(status)` — SECURED-only gate + badge rule

Canonical source: `src/lib/statusDisplay.ts`
(`export function isProofDownloadable`).

```ts
import { isProofDownloadable, getStatusDisplay } from '@/lib/statusDisplay';

// Gate the download UI (PDF + JSON + proof_bundle) on this — nothing else:
if (isProofDownloadable(anchor.status)) { /* show download */ }
```

Semantics (frozen):

- Returns `true` **only** when the normalized status is `SECURED`. Every other
  status — `PENDING`, `BROADCASTING`, `SUBMITTED`, `REVOKED`, `EXPIRED`,
  `SUPERSEDED`, `PENDING_RESOLUTION`, and all attestation statuses — returns
  `false`.
- **Fails closed:** `null`, `undefined`, blank, and unknown input → `false`.
- The input is the **raw enum** (`SECURED`), case/separator-insensitive. Do NOT
  pass the display label (`"Verified"`) — that returns `false` by design.
- Only genuinely SECURED anchors carry a complete, verifiable proof. A record is
  SECURED once the worker has confirmed it on the production network and written
  the `anchor_proofs` row; no other status has a complete packet.

### Badge rule (§1.3 — never hardcode "Verified")

- The user-facing status badge/label MUST come from `getStatusDisplay(status)`
  (`{ label, tone }`). `SECURED → { label: 'Verified', tone: 'positive' }`.
- Do NOT hardcode the string `"Verified"` in markup. (PROOF-04 fixes this in the
  PDF; the existing `ProofDownload.tsx` `<Badge variant="success">Verified</Badge>`
  is a known pre-existing hardcode — Lane 2 should switch it to
  `getStatusDisplay(...).label` when it touches that component.)
- Tone → variant mapping is the consumer's choice (e.g. shadcn `Badge variant`),
  but it must be derived from `tone`, not from a status string compare.

---

## 5. What Lane 2 can rely on (frozen handles)

| Handle | Location | Guarantee |
|---|---|---|
| `ProofPacket` (type) | `src/lib/generateAuditReport.ts` | Field set + nullability frozen for S2 |
| `buildProofPacket(data)` | `src/lib/generateAuditReport.ts` | Returns packet or `null` (gated SECURED + has proof) |
| `buildAuditReport(data)` | `src/lib/generateAuditReport.ts` | `{ doc, filename, embeddedProofJson }`; pure/client-side |
| `isProofDownloadable(status)` | `src/lib/statusDisplay.ts` | SECURED-only, fails closed |
| `getStatusDisplay(status)` | `src/lib/statusDisplay.ts` | `{ label, tone }`; §1.3-safe; never raw enum |
| Reference verifier URL | `CERTIFICATE_COPY.OFFLINE_VERIFY_TOOL` in `src/lib/copy.ts` | `https://arkova.ai/verify` |

## 6. Open items / non-goals

- The reference verifier at `https://arkova.ai/verify` accepting a pasted
  `proof_bundle`/packet is a **separate** deliverable (verifier UI). This
  contract only fixes the shape it must accept.
- `signature` is `{ alg, signing_key_id } | null` — present only on the signed
  path; it is explicit `null` (not omitted) on the default unsigned path.
  Consumers must treat it as possibly-`null`.
- `proof_bundle.bundle_version` and `packet.proof_schema_version` are independent
  version axes — the envelope can evolve without bumping the packet schema.

---

_Lane 1 · PI-0 Sprint 2 · SCRUM-2337 (PROOF-04). Consumed by SCRUM-2501 (Lane 2)._
