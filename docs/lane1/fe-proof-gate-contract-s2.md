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

1. **The PROOF-04 PDF proof-JSON shape** (`ProofPacket`).
2. **The PROOF-05 `proof_bundle` field shape** (superset envelope around the packet).
3. **`isProofDownloadable(status) === SECURED-only` semantics** + the badge rule.

---

## 2. The proof packet — `ProofPacket` (PROOF-04 embedded JSON)

Canonical TypeScript source: `src/lib/generateAuditReport.ts`
(`export interface ProofPacket`). This is the JSON embedded in the certificate
PDF (both rendered visibly and stored verbatim in the PDF document properties
under `keywords`, subject `arkova-proof-packet`).

```jsonc
{
  "fingerprint":          "<64-hex SHA-256 of the document>",
  "merkle_root":          "<64-hex>|null",
  "merkle_proof":         ["<64-hex>", "..."] /* ordered sibling path */ | null,
  "merkle_index":         3 | null,            /* leaf position in the tree */
  "tx_id":                "<64-hex network receipt id>" | null,
  "block_height":         850123 | null,
  "block_hash":           "<64-hex>" | null,
  "block_header":         "<160-hex raw 80-byte header>" | null,
  "op_return_payload":    "<hex>" | null,
  "proof_schema_version": 1 | null,
  "observed_time":        "2026-06-02T03:00:00Z" | null, /* ISO-8601 UTC */
  "signature": {                                /* OPTIONAL — present only when signed */
    "algorithm": "ECDSA-SHA256",
    "key_id":    "treasury-wif-1"               /* OPTIONAL */
  }
}
```

### Field provenance (DB columns → packet)

| Packet field | Source column | Notes |
|---|---|---|
| `fingerprint` | `anchors.fingerprint` | SHA-256, browser-computed for uploads (§1.6) |
| `merkle_root` | `anchor_proofs.merkle_root` | `text` (hex as-is) |
| `merkle_proof` | `anchor_proofs.proof_path` | `Json` array of hex strings; filtered to strings |
| `merkle_index` | `anchor_proofs.merkle_index` | `int` |
| `tx_id` | `anchors.chain_tx_id` → fallback `anchor_proofs.receipt_id` | |
| `block_height` | `anchor_proofs.block_height` → fallback `anchors.chain_block_height` | |
| `block_hash` | `anchor_proofs.block_hash` | `text` (hex as-is) |
| `block_header` | `anchor_proofs.block_header` | `bytea` → emit as hex string; see project memory `proof_bytea_vs_text_storage` |
| `op_return_payload` | `anchor_proofs.op_return_payload` | `text` hex |
| `proof_schema_version` | `anchor_proofs.proof_schema_version` | `int`, default 1 |
| `observed_time` | `anchor_proofs.block_timestamp` → fallback `anchors.chain_timestamp` | ISO-8601 UTC |
| `signature` | (treasury signer metadata) | algorithm + key id only — **never** a private key |

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
  *observed* at `observed_time`; it does NOT assert content accuracy, issuer
  identity, or credential validity.

---

## 3. `proof_bundle` field shape (PROOF-05 / SCRUM-2501 consumes)

`proof_bundle` is the **envelope** Lane 2 surfaces (download + render). It wraps
the exact `ProofPacket` above plus bounded, PII-safe display metadata. The
embedded `packet` MUST be byte-identical to what PROOF-04 embeds — do not
re-derive or re-order fields.

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
- `signature` is optional and present only when the treasury signer attaches
  metadata; consumers must treat it as possibly-absent.
- `proof_bundle.bundle_version` and `packet.proof_schema_version` are independent
  version axes — the envelope can evolve without bumping the packet schema.

---

_Lane 1 · PI-0 Sprint 2 · SCRUM-2337 (PROOF-04). Consumed by SCRUM-2501 (Lane 2)._
