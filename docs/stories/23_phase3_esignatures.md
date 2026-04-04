# Phase III: AdES Signature Engine Architecture Specification
_Created: 2026-04-03 | Priority: Phase III (months 18-36) | Status: ARCHITECTURE SPEC_
_Stories: PH3-ESIG-01, PH3-ESIG-02, PH3-ESIG-03_
_Gate: Phase II Gate 2 must be met before implementation begins_

---

## 1. Executive Summary

Phase III extends Arkova's tamper-proof anchoring infrastructure with **jurisdiction-compliant Advanced Electronic Signatures (AdES)**, enabling documents anchored on Arkova to carry legally binding electronic signatures recognized under EU eIDAS, US ESIGN/UETA, and other regulatory frameworks.

**What this delivers:**
- XAdES, PAdES, and CAdES signature support aligned to ETSI EN 319 132/142/122
- PKI certificate chain management with HSM-backed key storage
- RFC 3161 timestamp tokens from Qualified Trust Service Providers (QTSPs)
- Dual evidence model: PKI-based legal signatures + Bitcoin-anchored existence proofs
- Long-Term Validation (LTV) for signatures that remain verifiable decades after signing
- Customer-facing compliance center for audit proofs and SOC 2 evidence bundles

**What this does NOT change:**
- Client-side processing boundary (Constitution 1.6) remains intact -- documents never leave the user's device for fingerprinting
- Existing Bitcoin anchor pipeline is unchanged -- AdES signatures are a parallel evidence layer
- Verification API schema (frozen, Constitution 1.8) -- AdES endpoints are additive under `/api/v1/signatures/*`

**Business case:** Enterprise customers in regulated industries (financial services, healthcare, government contracting) require legally binding e-signatures for audit defensibility. AdES compliance unlocks EU public sector procurement (eIDAS mandate) and positions Arkova as a full-stack trust infrastructure provider.

---

## 2. System Architecture

### 2.1 High-Level Component Diagram

```
                                 +---------------------------+
                                 |      Browser (Client)     |
                                 |                           |
                                 | - Document fingerprint    |
                                 | - Signature intent UI     |
                                 | - Certificate selection   |
                                 | - Client-side PII strip   |
                                 +-------------+-------------+
                                               |
                                    HTTPS (fingerprint +
                                    signature request)
                                               |
                                 +-------------v-------------+
                                 |     Worker (Node.js)      |
                                 |                           |
                                 | +-------+ +-------------+ |
                                 | | AdES  | | Timestamp   | |
                                 | | Engine| | Service     | |
                                 | +---+---+ +------+------+ |
                                 |     |            |         |
                                 | +---v------------v------+  |
                                 | | PKI Manager          |  |
                                 | | (cert chain, CRL,    |  |
                                 | |  OCSP, HSM bridge)   |  |
                                 | +-----------+----------+  |
                                 +-------------|-------------+
                                               |
                          +--------------------+--------------------+
                          |                    |                    |
                  +-------v------+    +--------v-------+   +-------v-------+
                  | Supabase     |    | QTSP (RFC 3161)|   | Bitcoin       |
                  | (signatures, |    | DigiCert /     |   | Anchor        |
                  |  certs, TSTs)|    | Sectigo        |   | Pipeline      |
                  +--------------+    +----------------+   +---------------+
                                               |
                                      +--------v-------+
                                      | HSM / KMS      |
                                      | (AWS KMS /     |
                                      |  GCP Cloud HSM)|
                                      +----------------+
```

### 2.2 AdES Engine

The AdES engine is a new module within `services/worker/` that produces standards-compliant electronic signatures.

**Location:** `services/worker/src/signatures/`

```
services/worker/src/signatures/
  index.ts                    # barrel export
  adesEngine.ts               # orchestrator: coordinate signing flow
  xades/
    xadesBuilder.ts           # XAdES-B-B through XAdES-B-LTA
    xadesValidator.ts         # XAdES signature verification
    xadesProfiles.ts          # profile definitions (B-B, B-T, B-LT, B-LTA)
  pades/
    padesBuilder.ts           # PAdES-B-B through PAdES-B-LTA (PDF sig dict)
    padesValidator.ts         # PAdES signature verification
  cades/
    cadesBuilder.ts           # CAdES-B-B through CAdES-B-LTA (CMS/PKCS#7)
    cadesValidator.ts         # CAdES signature verification
  pki/
    certificateManager.ts     # cert chain resolution, caching, validation
    crlManager.ts             # CRL fetching, caching, delta-CRL support
    ocspClient.ts             # OCSP request/response handling
    hsmBridge.ts              # abstract HSM interface (AWS KMS, GCP Cloud HSM)
    trustStore.ts             # EU Trusted List (EUTL) + custom trust anchors
  timestamp/
    rfc3161Client.ts          # RFC 3161 TSA request builder
    qtspProvider.ts           # QTSP selection, failover, cost tracking
    timestampValidator.ts     # TST verification
  ltv/
    ltvBuilder.ts             # long-term validation data aggregation
    ltvValidator.ts           # LTV chain verification
  types.ts                    # shared types (SignatureLevel, SignatureFormat, etc.)
  constants.ts                # OIDs, algorithm identifiers, ETSI profile URIs
```

### 2.3 Signing Flow

**Sequence: Create AdES Signature (PAdES-B-LTA example)**

```
1. Client: User selects document, chooses "Sign with Legal Signature"
2. Client: generateFingerprint() runs client-side (unchanged)
3. Client: POST /api/v1/sign
   Body: {
     anchor_id: "ARK-...",                    // existing anchor
     fingerprint: "sha256:abc123...",          // client-computed
     format: "PAdES",                          // XAdES | PAdES | CAdES
     level: "B-LTA",                           // B-B | B-T | B-LT | B-LTA
     signer_certificate_id: "cert_...",        // org's signing cert
     jurisdiction: "EU",                       // EU | US | INTL
     metadata: { reason: "Contract approval" }
   }

4. Worker: Validate request (Zod schema)
5. Worker: Resolve signer certificate from PKI Manager
6. Worker: Validate cert chain against trust store (EUTL for EU)
7. Worker: Build signature value:
   a. Compute SignedInfo/SignedAttributes over fingerprint + metadata
   b. Sign via HSM (AWS KMS or GCP Cloud HSM) -- private key never in memory
   c. Attach signer certificate + chain
8. Worker: Request RFC 3161 timestamp token from QTSP
   a. Primary: DigiCert Timestamp Authority
   b. Fallback: Sectigo Timestamp Authority
   c. Embed TST in signature (SignatureTimeStamp for XAdES, TST in PDF sig dict for PAdES)
9. Worker: Aggregate LTV data (for B-LT and B-LTA):
   a. Fetch OCSP responses for all certs in chain
   b. Fetch CRLs for all certs in chain
   c. Embed in signature (XAdES: UnsignedProperties, PAdES: DSS, CAdES: unsigned attrs)
10. Worker: For B-LTA: request archive timestamp over LTV data + signature
11. Worker: Store signature record in `signatures` table
12. Worker: Link to existing anchor via `anchor_id`
13. Worker: Return signature ID + verification URL

14. Worker (async): If anchor not yet SECURED, Bitcoin anchor pipeline continues
    independently -- dual evidence accrues over time
```

### 2.4 Timestamp Service Architecture

The timestamp service wraps RFC 3161 interactions with failover and cost management.

```
                    +-------------------+
                    | qtspProvider.ts   |
                    |                   |
                    | - provider roster |
                    | - health checks   |
                    | - cost tracker    |
                    | - circuit breaker |
                    +--------+----------+
                             |
                   +---------+---------+
                   |                   |
           +-------v------+   +-------v------+
           | DigiCert TSA |   | Sectigo TSA  |
           | (primary)    |   | (fallback)   |
           +--------------+   +--------------+
```

**RFC 3161 Flow:**
1. Build `TimeStampReq` with SHA-256 hash of signature value
2. POST to TSA URL with `Content-Type: application/timestamp-query`
3. Parse `TimeStampResp`, validate status
4. Verify TST signature against TSA certificate
5. Embed TST in AdES signature structure
6. Store TST independently in `timestamp_tokens` table for audit

**Failover:** If primary TSA returns error or times out (5s), circuit breaker opens and routes to secondary. Health check pings every 60s to re-enable primary.

**Cost tracking:** Each TST request is logged with provider, cost (per QTSP contract), and timestamp. Monthly cost aggregation available via admin dashboard.

---

## 3. Database Schema Additions

All new tables follow Constitution 1.2 (schema-first) and 1.4 (RLS + FORCE ROW LEVEL SECURITY).

### 3.1 `signatures` Table

```sql
-- Migration: NNNN_signatures_table.sql

CREATE TABLE signatures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text NOT NULL UNIQUE,                     -- ARK-{org}-SIG-{unique}
  org_id          uuid NOT NULL REFERENCES organizations(id),
  anchor_id       uuid REFERENCES anchors(id),              -- link to existing anchor
  attestation_id  uuid REFERENCES attestations(id),         -- optional link to attestation

  -- Signature metadata
  format          text NOT NULL CHECK (format IN ('XAdES', 'PAdES', 'CAdES')),
  level           text NOT NULL CHECK (level IN ('B-B', 'B-T', 'B-LT', 'B-LTA')),
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SIGNED', 'TIMESTAMPED', 'LTV_EMBEDDED', 'COMPLETE', 'FAILED', 'REVOKED')),
  jurisdiction    text CHECK (jurisdiction IN ('EU', 'US', 'UK', 'CH', 'INTL')),

  -- Fingerprint (matches anchor fingerprint)
  document_fingerprint  text NOT NULL,

  -- Signer info
  signer_certificate_id uuid NOT NULL REFERENCES signing_certificates(id),
  signer_name           text,                               -- display name from cert CN
  signer_org            text,                               -- display name from cert O

  -- Signature data (stored as base64)
  signature_value       text,                               -- the cryptographic signature
  signed_attributes     jsonb,                              -- what was signed (hash, timestamp, cert digest)
  signature_algorithm   text,                               -- e.g., 'sha256WithRSAEncryption', 'ecdsa-with-SHA256'

  -- Timestamp token reference
  timestamp_token_id    uuid REFERENCES timestamp_tokens(id),

  -- LTV data
  ltv_data_embedded     boolean NOT NULL DEFAULT false,
  archive_timestamp_id  uuid REFERENCES timestamp_tokens(id),

  -- Metadata
  reason          text,                                      -- signing reason (e.g., "Contract approval")
  location        text,                                      -- signing location
  contact_info    text,                                      -- signer contact

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  signed_at       timestamptz,
  completed_at    timestamptz,
  revoked_at      timestamptz,
  revocation_reason text,
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  metadata        jsonb DEFAULT '{}'::jsonb,

  -- Constraints
  CONSTRAINT signatures_anchor_or_attestation
    CHECK (anchor_id IS NOT NULL OR attestation_id IS NOT NULL)
);

-- Indexes
CREATE INDEX idx_signatures_org_id ON signatures(org_id);
CREATE INDEX idx_signatures_anchor_id ON signatures(anchor_id);
CREATE INDEX idx_signatures_status ON signatures(status);
CREATE INDEX idx_signatures_created_at ON signatures(created_at DESC);
CREATE INDEX idx_signatures_signer_cert ON signatures(signer_certificate_id);

-- RLS
ALTER TABLE signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatures FORCE ROW LEVEL SECURITY;

CREATE POLICY signatures_select ON signatures FOR SELECT
  USING (org_id IN (
    SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
  ));

CREATE POLICY signatures_insert ON signatures FOR INSERT
  WITH CHECK (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- ROLLBACK: DROP TABLE signatures;
```

### 3.2 `signing_certificates` Table

```sql
-- Migration: NNNN_signing_certificates_table.sql

CREATE TABLE signing_certificates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),

  -- Certificate metadata
  subject_cn      text NOT NULL,                            -- Common Name
  subject_org     text,                                     -- Organization
  issuer_cn       text NOT NULL,                            -- Issuer Common Name
  issuer_org      text,                                     -- Issuer Organization
  serial_number   text NOT NULL,                            -- hex-encoded serial
  fingerprint_sha256 text NOT NULL,                         -- cert fingerprint for lookups

  -- Certificate data
  certificate_pem text NOT NULL,                            -- PEM-encoded X.509 certificate
  chain_pem       text[],                                   -- intermediate certs (PEM array)

  -- Key reference (HSM-backed, never raw key material)
  kms_provider    text NOT NULL CHECK (kms_provider IN ('aws_kms', 'gcp_kms')),
  kms_key_id      text NOT NULL,                            -- KMS key ARN or resource path
  key_algorithm   text NOT NULL,                            -- RSA-2048, RSA-4096, ECDSA-P256, ECDSA-P384

  -- Validity
  not_before      timestamptz NOT NULL,
  not_after       timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'SUSPENDED')),

  -- Trust level
  trust_level     text NOT NULL DEFAULT 'ADVANCED'
                  CHECK (trust_level IN ('BASIC', 'ADVANCED', 'QUALIFIED')),
  qtsp_name       text,                                     -- QTSP name if qualified cert
  eu_trusted_list_entry text,                               -- EUTL reference if applicable

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  metadata        jsonb DEFAULT '{}'::jsonb,

  CONSTRAINT signing_certs_unique_per_org
    UNIQUE (org_id, fingerprint_sha256)
);

-- Indexes
CREATE INDEX idx_signing_certs_org ON signing_certificates(org_id);
CREATE INDEX idx_signing_certs_status ON signing_certificates(status);
CREATE INDEX idx_signing_certs_not_after ON signing_certificates(not_after);

-- RLS
ALTER TABLE signing_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_certificates FORCE ROW LEVEL SECURITY;

CREATE POLICY signing_certs_select ON signing_certificates FOR SELECT
  USING (org_id IN (
    SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
  ));

CREATE POLICY signing_certs_insert ON signing_certificates FOR INSERT
  WITH CHECK (org_id IN (
    SELECT om.org_id FROM org_members om
    WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin')
  ));

-- ROLLBACK: DROP TABLE signing_certificates;
```

### 3.3 `timestamp_tokens` Table

```sql
-- Migration: NNNN_timestamp_tokens_table.sql

CREATE TABLE timestamp_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),

  -- What was timestamped
  signature_id    uuid REFERENCES signatures(id),           -- null for archive timestamps
  message_imprint text NOT NULL,                            -- SHA-256 hash that was timestamped (hex)
  hash_algorithm  text NOT NULL DEFAULT 'SHA-256',

  -- TST data
  tst_data        bytea NOT NULL,                           -- raw DER-encoded TimeStampToken
  tst_serial      text NOT NULL,                            -- TSA serial number
  tst_gen_time    timestamptz NOT NULL,                     -- genTime from TST

  -- Provider info
  tsa_name        text NOT NULL,                            -- e.g., 'DigiCert SHA2 Assured ID Timestamping CA'
  tsa_url         text NOT NULL,                            -- TSA endpoint URL
  tsa_cert_fingerprint text NOT NULL,                       -- TSA signing cert fingerprint
  qtsp_qualified  boolean NOT NULL DEFAULT false,           -- is this a qualified TSA per eIDAS?

  -- Token type
  token_type      text NOT NULL DEFAULT 'SIGNATURE'
                  CHECK (token_type IN ('SIGNATURE', 'ARCHIVE', 'CONTENT')),

  -- Cost tracking
  cost_usd        numeric(10, 4),                           -- per-token cost for billing
  provider_ref    text,                                     -- provider transaction reference

  -- Verification
  verified_at     timestamptz,                              -- last successful verification
  verification_status text DEFAULT 'UNVERIFIED'
                  CHECK (verification_status IN ('UNVERIFIED', 'VALID', 'INVALID', 'EXPIRED')),

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX idx_tst_org ON timestamp_tokens(org_id);
CREATE INDEX idx_tst_signature ON timestamp_tokens(signature_id);
CREATE INDEX idx_tst_gen_time ON timestamp_tokens(tst_gen_time DESC);
CREATE INDEX idx_tst_provider ON timestamp_tokens(tsa_name);

-- RLS
ALTER TABLE timestamp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE timestamp_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY tst_select ON timestamp_tokens FOR SELECT
  USING (org_id IN (
    SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
  ));

-- Worker-only inserts via service_role (no user INSERT policy)

-- ROLLBACK: DROP TABLE timestamp_tokens;
```

### 3.4 Schema Relationship Diagram

```
organizations
  |
  +-- signing_certificates (org_id FK)
  |     |
  +-- signatures (org_id FK)
  |     |-- signer_certificate_id -> signing_certificates.id
  |     |-- anchor_id -> anchors.id (existing)
  |     |-- attestation_id -> attestations.id (existing)
  |     |-- timestamp_token_id -> timestamp_tokens.id
  |     |-- archive_timestamp_id -> timestamp_tokens.id
  |     |
  +-- timestamp_tokens (org_id FK)
        |-- signature_id -> signatures.id
```

---

## 4. API Endpoints

All endpoints live under `/api/v1/signatures/` and require API key authentication (existing HMAC-SHA256 infrastructure). Rate limits follow Constitution 1.10.

### 4.1 POST `/api/v1/sign`

Create an AdES signature for an existing anchor or attestation.

**Request:**
```json
{
  "anchor_id": "ARK-ACME-DOC-A1B2C3",
  "fingerprint": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "format": "PAdES",
  "level": "B-LTA",
  "signer_certificate_id": "cert_9f8e7d6c",
  "jurisdiction": "EU",
  "reason": "Contract approval",
  "location": "Berlin, DE",
  "metadata": {
    "contract_ref": "CTR-2026-0042"
  }
}
```

**Validation (Zod):**
```typescript
const signRequestSchema = z.object({
  anchor_id: z.string().optional(),
  attestation_id: z.string().optional(),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  format: z.enum(['XAdES', 'PAdES', 'CAdES']),
  level: z.enum(['B-B', 'B-T', 'B-LT', 'B-LTA']),
  signer_certificate_id: z.string(),
  jurisdiction: z.enum(['EU', 'US', 'UK', 'CH', 'INTL']).optional(),
  reason: z.string().max(500).optional(),
  location: z.string().max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  (d) => d.anchor_id || d.attestation_id,
  { message: 'Either anchor_id or attestation_id required' }
);
```

**Response (201 Created):**
```json
{
  "signature_id": "ARK-ACME-SIG-X7Y8Z9",
  "status": "COMPLETE",
  "format": "PAdES",
  "level": "B-LTA",
  "signer": {
    "name": "Carson Seeger",
    "organization": "Acme Corp"
  },
  "signed_at": "2026-04-03T14:22:00Z",
  "timestamp": {
    "tsa": "DigiCert SHA2 Assured ID Timestamping CA",
    "gen_time": "2026-04-03T14:22:01Z",
    "qualified": true
  },
  "ltv_embedded": true,
  "anchor_proof": {
    "anchor_id": "ARK-ACME-DOC-A1B2C3",
    "status": "SECURED",
    "tx_id": "abc123..."
  },
  "verification_url": "https://app.arkova.io/verify/signature/ARK-ACME-SIG-X7Y8Z9"
}
```

**Error responses:**
| Code | Condition |
|------|-----------|
| 400 | Invalid request body, fingerprint mismatch |
| 401 | Missing or invalid API key |
| 403 | Certificate does not belong to caller's org |
| 404 | Anchor/attestation not found |
| 409 | Anchor already has a signature with this certificate |
| 422 | Certificate expired, revoked, or chain validation failed |
| 502 | QTSP timestamp service unavailable (after failover) |
| 429 | Rate limit exceeded |

### 4.2 GET `/api/v1/signatures/:id`

Retrieve a signature by its public ID.

**Response (200 OK):**
```json
{
  "signature_id": "ARK-ACME-SIG-X7Y8Z9",
  "status": "COMPLETE",
  "format": "PAdES",
  "level": "B-LTA",
  "jurisdiction": "EU",
  "document_fingerprint": "sha256:e3b0c44...",
  "signer": {
    "name": "Carson Seeger",
    "organization": "Acme Corp",
    "certificate_fingerprint": "sha256:f4c1d55..."
  },
  "signed_at": "2026-04-03T14:22:00Z",
  "timestamp": {
    "tsa": "DigiCert SHA2 Assured ID Timestamping CA",
    "gen_time": "2026-04-03T14:22:01Z",
    "qualified": true
  },
  "ltv": {
    "embedded": true,
    "ocsp_responses": 3,
    "crl_entries": 2,
    "archive_timestamp": "2026-04-03T14:22:02Z"
  },
  "anchor": {
    "anchor_id": "ARK-ACME-DOC-A1B2C3",
    "status": "SECURED",
    "network_observed_time": "2026-04-03T14:35:00Z"
  },
  "verification_url": "https://app.arkova.io/verify/signature/ARK-ACME-SIG-X7Y8Z9",
  "created_at": "2026-04-03T14:22:00Z"
}
```

**Notes:**
- `jurisdiction` omitted when null (frozen schema compliance, Constitution 1.8)
- Public verification URL works without API key (read-only public page)

### 4.3 POST `/api/v1/verify-signature`

Verify an AdES signature's validity, certificate chain, and timestamp token.

**Request:**
```json
{
  "signature_id": "ARK-ACME-SIG-X7Y8Z9"
}
```

OR (verify by fingerprint):
```json
{
  "document_fingerprint": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

**Response (200 OK):**
```json
{
  "valid": true,
  "signature_id": "ARK-ACME-SIG-X7Y8Z9",
  "checks": {
    "signature_integrity": { "status": "PASS", "detail": "Signature value matches signed attributes" },
    "certificate_chain": { "status": "PASS", "detail": "Chain valid to DigiCert Global Root G2" },
    "certificate_revocation": { "status": "PASS", "detail": "OCSP: good (checked 2026-04-03T14:22:00Z)" },
    "certificate_validity": { "status": "PASS", "detail": "Certificate valid until 2028-01-15" },
    "timestamp_token": { "status": "PASS", "detail": "RFC 3161 TST valid, qualified TSA" },
    "ltv_data": { "status": "PASS", "detail": "LTV data embedded, archive timestamp present" },
    "anchor_proof": { "status": "PASS", "detail": "Bitcoin anchor SECURED at block 890123" },
    "fingerprint_match": { "status": "PASS", "detail": "Document fingerprint matches anchor" }
  },
  "compliance": {
    "eidas_level": "QES",
    "etsi_profile": "EN 319 142-1 (PAdES B-LTA)",
    "legal_effect": "Equivalent to handwritten signature under eIDAS Art. 25(2)"
  },
  "verified_at": "2026-04-03T15:00:00Z"
}
```

**Verification check failures return `"valid": false`** with failing checks showing `"status": "FAIL"` and diagnostic detail. The response is still 200 (verification completed successfully, result is "invalid signature").

### 4.4 GET `/api/v1/signatures` (List)

List signatures for the authenticated organization.

**Query parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | Filter by status |
| `format` | string | Filter by format (XAdES, PAdES, CAdES) |
| `anchor_id` | string | Filter by anchor public ID |
| `from` | ISO 8601 | Signed after date |
| `to` | ISO 8601 | Signed before date |
| `limit` | integer | Max results (default 50, max 100) |
| `cursor` | string | Pagination cursor |

### 4.5 POST `/api/v1/signatures/:id/revoke`

Revoke a signature (e.g., if signer certificate is compromised).

**Request:**
```json
{
  "reason": "KEY_COMPROMISE",
  "detail": "Signing certificate private key potentially exposed"
}
```

**Revocation reasons:** `KEY_COMPROMISE`, `AFFILIATION_CHANGED`, `SUPERSEDED`, `CESSATION_OF_OPERATION`, `CERTIFICATE_HOLD`

---

## 5. ETSI Compliance Requirements

### 5.1 Applicable Standards

| Standard | Scope | Arkova Mapping |
|----------|-------|----------------|
| ETSI EN 319 132-1 | XAdES structure and profiles | `xadesBuilder.ts` |
| ETSI EN 319 132-2 | XAdES extended validation data | `ltvBuilder.ts` (XAdES path) |
| ETSI EN 319 142-1 | PAdES structure and profiles | `padesBuilder.ts` |
| ETSI EN 319 142-2 | PAdES extended validation data | `ltvBuilder.ts` (PAdES path) |
| ETSI EN 319 122-1 | CAdES structure and profiles | `cadesBuilder.ts` |
| ETSI EN 319 122-2 | CAdES extended validation data | `ltvBuilder.ts` (CAdES path) |
| ETSI EN 319 401 | General policy for TSP | Organizational controls |
| ETSI EN 319 411-1 | Policy for CA issuing certificates | Certificate management |
| ETSI EN 319 411-2 | Policy for CA issuing QC | Qualified certificate handling |
| ETSI EN 319 421 | Policy for TSA | `qtspProvider.ts` |
| ETSI EN 319 422 | TSA protocol profiles | `rfc3161Client.ts` |
| ETSI TS 119 312 | Cryptographic suites | Algorithm selection in `constants.ts` |

### 5.2 Signature Levels

| Level | What It Proves | ETSI Requirement | Implementation |
|-------|---------------|------------------|----------------|
| **B-B** (Basic) | Signer identity + document integrity | Signed attributes + signer cert | Minimum viable signature |
| **B-T** (Timestamp) | B-B + time of signing | B-B + RFC 3161 timestamp token | QTSP timestamp embedded |
| **B-LT** (Long-Term) | B-T + validation data for offline verification | B-T + OCSP responses + CRLs | LTV data embedded |
| **B-LTA** (Long-Term Archival) | B-LT + protection against algorithm obsolescence | B-LT + archive timestamp | Archive TST covers all prior data |

### 5.3 Cryptographic Requirements (ETSI TS 119 312)

**Minimum algorithms (valid through 2030+):**
| Purpose | Algorithm | Key Size |
|---------|-----------|----------|
| Signing (RSA) | RSASSA-PKCS1-v1_5 or RSASSA-PSS | >= 2048 bits |
| Signing (ECDSA) | ECDSA with P-256 or P-384 | 256 or 384 bits |
| Hashing | SHA-256, SHA-384, SHA-512 | -- |
| Timestamp hashing | SHA-256 minimum | -- |

**Banned algorithms:** SHA-1 (for any purpose), RSA < 2048, MD5.

### 5.4 eIDAS Alignment

| eIDAS Article | Requirement | Arkova Implementation |
|---------------|-------------|----------------------|
| Art. 3(10) | Electronic signature definition | All AdES levels qualify |
| Art. 3(11) | Advanced electronic signature (AdES) | B-B+ with qualified cert = AdES |
| Art. 3(12) | Qualified electronic signature (QES) | B-T+ with qualified cert from QTSP |
| Art. 25(1) | Legal effect of e-signatures | AdES accepted as evidence in legal proceedings |
| Art. 25(2) | QES = handwritten equivalent | Requires qualified cert + qualified SSCD (HSM) |
| Art. 25(3) | Cross-border recognition | QES from one EU member state recognized in all |
| Art. 42 | Qualified timestamp defined | RFC 3161 from qualified TSA on EU Trusted List |
| Art. 44 | Trust services supervision | QTSP must be on EU Trusted List |

### 5.5 US ESIGN/UETA Alignment

US law is technology-neutral -- any electronic signature demonstrating intent to sign is valid. Arkova's AdES signatures satisfy ESIGN/UETA by:
- Recording signer identity via X.509 certificate
- Recording intent via `reason` field and affirmative signing action
- Providing tamper-evident integrity via cryptographic signature
- Maintaining accessible records via Supabase + Bitcoin dual storage

---

## 6. Integration Points with Existing Arkova Infrastructure

### 6.1 Anchor Pipeline

**Current flow (unchanged):**
```
Document -> Fingerprint (client) -> Anchor record (Supabase) -> Batch job -> Bitcoin TX -> SECURED
```

**Extended flow:**
```
Document -> Fingerprint (client) -> Anchor record -> [optional] AdES Signature -> Batch job -> Bitcoin TX -> SECURED
                                                          |
                                                          +-> QTSP Timestamp Token
                                                          +-> LTV data
```

The signature is created **before or after** Bitcoin anchoring. They are independent evidence layers:
- **Anchor PENDING + Signature COMPLETE**: Document is signed but not yet on-chain
- **Anchor SECURED + Signature COMPLETE**: Full dual evidence (signature + blockchain)
- **Anchor SECURED + No Signature**: Original behavior, unchanged

### 6.2 Attestation Infrastructure

Attestations (`attestations` table) can optionally carry an AdES signature. The `signatures.attestation_id` FK links them. This enables signed attestations for employment verification, education credentials, etc. (ATT-01 through ATT-08).

### 6.3 Verification API

Existing `/api/v1/verify/:publicId` remains unchanged (frozen schema). New signature verification is additive:
- `/api/v1/verify/:publicId` returns existing anchor + attestation proof (unchanged)
- `/api/v1/verify-signature` adds signature-specific verification (new)
- Public verification page at `/verify/signature/:signaturePublicId` (new)

### 6.4 KMS Infrastructure

The existing KMS infrastructure (`services/worker/src/chain/kms/`) for Bitcoin signing is extended:
- `aws_kms.ts` and `gcp_kms.ts` already implement `sign()` operations
- AdES signing reuses these providers with different key configurations
- Bitcoin keys use `secp256k1`; AdES keys use `RSA-2048+` or `ECDSA P-256/P-384`
- Separate KMS keys for Bitcoin treasury vs. AdES signing (never shared)

### 6.5 Audit Events

All signature operations emit audit events to `audit_events`:
| Event | Trigger |
|-------|---------|
| `signature.created` | New signature request |
| `signature.completed` | Signature + timestamp + LTV all embedded |
| `signature.failed` | Signing or timestamping failed |
| `signature.revoked` | Signature revoked |
| `signature.verified` | Third-party verification request |
| `certificate.added` | New signing certificate registered |
| `certificate.expired` | Certificate expiration detected |
| `certificate.revoked` | Certificate revoked |
| `timestamp.acquired` | RFC 3161 TST obtained |
| `timestamp.failover` | Primary TSA failed, used secondary |

### 6.6 Compliance Mapping (CML stories)

Existing compliance badges (`ComplianceBadge.tsx`, `complianceMapping.ts`) extend to show:
- "eIDAS QES" badge when signature is B-T+ with qualified certificate
- "ETSI EN 319 142" badge for PAdES signatures
- "RFC 3161 Qualified Timestamp" badge when QTSP TST is embedded

### 6.7 OP_RETURN v2 Timestamp

The OP_RETURN v2 design (`docs/design/op_return_v2_timestamp.md`) provides a complementary timestamp layer. When both are present:
- **OP_RETURN v2 timestamp**: Arkova worker UTC time embedded in Bitcoin TX (proof of submission time)
- **RFC 3161 TST**: QTSP-certified timestamp (legally recognized time of signing)
- **Bitcoin block_time**: Miner-set timestamp (cryptographic proof of existence by that time)

Three independent temporal proofs for maximum legal defensibility.

---

## 7. Acceptance Criteria by Story

### 7.1 PH3-ESIG-01: AdES Signature Engine

**Priority:** P0 (Phase III) | **Effort:** XL | **Depends on:** Phase II complete

**Acceptance Criteria:**
- [ ] `services/worker/src/signatures/` module with barrel export
- [ ] XAdES builder produces valid XAdES-B-B, B-T, B-LT, B-LTA signatures per ETSI EN 319 132-1/2
- [ ] PAdES builder produces valid PAdES-B-B, B-T, B-LT, B-LTA signatures per ETSI EN 319 142-1/2
- [ ] CAdES builder produces valid CAdES-B-B, B-T, B-LT, B-LTA signatures per ETSI EN 319 122-1/2
- [ ] PKI certificate manager validates X.509 chains against trust store
- [ ] OCSP client checks certificate revocation status in real time
- [ ] CRL manager fetches and caches certificate revocation lists
- [ ] HSM bridge signs via AWS KMS and GCP Cloud HSM (private keys never in worker memory)
- [ ] `POST /api/v1/sign` endpoint with Zod validation
- [ ] `GET /api/v1/signatures/:id` endpoint returns signature details
- [ ] `POST /api/v1/verify-signature` endpoint performs full validation chain
- [ ] `POST /api/v1/signatures/:id/revoke` endpoint with reason codes
- [ ] `GET /api/v1/signatures` list endpoint with filtering and cursor pagination
- [ ] `signatures` table migration with RLS policies
- [ ] `signing_certificates` table migration with RLS policies
- [ ] Integration with existing anchor pipeline (`anchor_id` FK)
- [ ] Integration with existing attestation infrastructure (`attestation_id` FK)
- [ ] Audit events emitted for all signature lifecycle transitions
- [ ] Algorithm selection enforces ETSI TS 119 312 minimums (no SHA-1, no RSA < 2048)
- [ ] Banned UI terminology respected: "Fingerprint" not "Hash", etc. (Constitution 1.3)
- [ ] Public verification page at `/verify/signature/:publicId`
- [ ] Unit tests for all builders and validators (mock HSM, mock OCSP/CRL)
- [ ] Integration tests with mock TSA responses
- [ ] Coverage >= 80% on `services/worker/src/signatures/`

### 7.2 PH3-ESIG-02: QTSP Integration

**Priority:** P1 (Phase III) | **Effort:** XL | **Depends on:** PH3-ESIG-01

**Acceptance Criteria:**
- [ ] RFC 3161 client builds valid `TimeStampReq` and parses `TimeStampResp`
- [ ] Integration with DigiCert Timestamp Authority (primary QTSP)
- [ ] Integration with Sectigo Timestamp Authority (secondary QTSP)
- [ ] Circuit breaker failover: primary failure routes to secondary within 5s
- [ ] Health check pings TSA endpoints every 60s to detect recovery
- [ ] TST embedded in AdES signatures for B-T, B-LT, B-LTA levels
- [ ] `timestamp_tokens` table migration with RLS policies
- [ ] TST verification endpoint validates token signature against TSA certificate
- [ ] Dual timestamp evidence: QTSP token + Bitcoin anchor timestamp
- [ ] OP_RETURN v2 timestamp (if implemented) as third temporal proof
- [ ] Cost tracking: per-token cost logged with provider reference
- [ ] Monthly cost aggregation query for admin billing dashboard
- [ ] QTSP provider configuration via environment variables (no hardcoded URLs)
- [ ] TSA certificate trust validated against EU Trusted List for qualified TSPs
- [ ] ETSI EN 319 421/422 compliance verified via conformance tests
- [ ] Unit tests for RFC 3161 request/response parsing
- [ ] Integration tests with mock TSA server
- [ ] Failover tests: primary down, secondary responds
- [ ] Coverage >= 80% on `services/worker/src/signatures/timestamp/`

### 7.3 PH3-ESIG-03: Compliance Center

**Priority:** P1 (Phase III) | **Effort:** Large | **Depends on:** PH3-ESIG-01, CML-03

**Acceptance Criteria:**
- [ ] Customer-facing `/compliance` route (not admin-only)
- [ ] Compliance dashboard: organization compliance score (credential coverage + anchoring + signature status)
- [ ] Per-credential audit proof download (PDF): anchor proof + signature + timestamp + certificate chain
- [ ] Bulk audit export: CSV/JSON of all credentials with compliance status
- [ ] SOC 2 evidence bundle generation (extends CML-03 audit export with signature proofs)
- [ ] GDPR Article 30 Record of Processing Activities export
- [ ] eIDAS compliance report: list of qualified signatures, QTSP usage, certificate status
- [ ] Policy transparency page: data handling, retention, encryption policies (public)
- [ ] Scheduled compliance report delivery: email (via Resend) and webhook
- [ ] "Compliance Officer" role within organization (view compliance data, export proofs, no admin access)
- [ ] Role-based access: only org owners/admins can assign compliance officer role
- [ ] Compliance badges on verification pages updated for AdES signatures
- [ ] Desktop (1280px) and mobile (375px) responsive layouts
- [ ] Unit tests for export generators
- [ ] E2E tests for compliance dashboard navigation and download flows
- [ ] Coverage >= 80% on compliance center components

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **QTSP contract delays** — QTSP onboarding requires legal agreements and technical integration that can take months | HIGH | HIGH | Begin QTSP vendor evaluation and contract negotiation in Phase II. Identify 3 candidates (DigiCert, Sectigo, GlobalSign). Mock TSA for development. |
| **eIDAS certification cost** — Formal eIDAS conformity assessment is expensive (50-200K EUR) and time-consuming (6-12 months) | HIGH | HIGH | Start with self-assessment against ETSI standards. Engage conformity assessment body early for gap analysis. Budget for certification in Phase III. |
| **HSM key management complexity** — Qualified signatures require SSCD (Secure Signature Creation Device) which adds operational overhead | MEDIUM | HIGH | Leverage existing AWS KMS / GCP Cloud HSM infrastructure. Verify that chosen KMS qualifies as SSCD under eIDAS. If not, evaluate dedicated HSM (e.g., Thales Luna, AWS CloudHSM dedicated). |
| **Algorithm obsolescence** — Crypto algorithms weaken over time; B-LTA must remain valid for decades | LOW | HIGH | B-LTA archive timestamps protect against algorithm obsolescence by design. Monitor ETSI TS 119 312 updates. Implement re-timestamping job for aging signatures. |
| **Cross-jurisdiction conflicts** — Different jurisdictions have different signature requirements (EU eIDAS vs US ESIGN vs UK eIDAS equivalent) | MEDIUM | MEDIUM | Jurisdiction tag on signatures drives validation rules. Start with EU + US. Add UK, Switzerland as separate profiles. |
| **Performance at scale** — OCSP/CRL fetching, TSA requests add latency to signing flow | MEDIUM | MEDIUM | Cache OCSP responses (per RFC 6960 nextUpdate). Cache CRLs (per nextUpdate). TSA requests are async where possible. Target: < 3s for B-T, < 5s for B-LTA. |
| **Client-side boundary tension** — Some AdES implementations require server-side document access for PAdES (PDF modification) | MEDIUM | HIGH | Arkova signs over the fingerprint, not the document itself. PAdES signature dict is returned to client for embedding. Document never leaves browser (Constitution 1.6 preserved). |
| **SOC 2 Type II timeline** — Type II requires 6+ months of operational evidence | LOW | MEDIUM | Begin evidence collection immediately when Phase III starts. Automate evidence gathering via audit event exports. |

---

## 9. Dependencies and Prerequisites

### 9.1 Phase Gate: Phase II Must Be Complete

All 6 Phase II stories (PH2-AGENT-01 through PH2-AGENT-06) must be COMPLETE before Phase III implementation begins. Critical dependencies:
- **PH2-AGENT-01** (Audit trail) provides the event infrastructure signatures rely on
- **PH2-AGENT-04** (Oracle) establishes the verification pattern that signature verification extends
- **PH2-AGENT-05** (Agent identity) provides the delegation model for signing authority

### 9.2 Technical Prerequisites

| Prerequisite | Status | Notes |
|-------------|--------|-------|
| AWS KMS / GCP Cloud HSM operational | DONE | Existing Bitcoin KMS infrastructure |
| Anchor pipeline stable | DONE | 166K+ SECURED anchors on mainnet |
| Attestation infrastructure | DONE | 9 types, full lifecycle |
| Verification API (v1) | DONE | Frozen schema, 100% coverage |
| Compliance badges (CML-01) | DONE | ComplianceBadge.tsx, complianceMapping.ts |
| Compliance audit export (CML-03) | NOT STARTED | Required for PH3-ESIG-03 |
| OP_RETURN v2 timestamp | NOT STARTED | Optional but recommended for triple timestamp |
| Phase II stories (PH2-AGENT-*) | NOT STARTED | Phase gate requirement |

### 9.3 Vendor Dependencies

| Vendor | Purpose | Lead Time | Estimated Cost |
|--------|---------|-----------|----------------|
| DigiCert | Primary QTSP (RFC 3161 TSA) | 2-4 weeks (existing customer: faster) | $0.01-0.05 per timestamp |
| Sectigo | Secondary QTSP (failover TSA) | 2-4 weeks | $0.01-0.05 per timestamp |
| Conformity Assessment Body (CAB) | eIDAS conformity assessment | 6-12 months | 50-200K EUR |
| Certificate Authority | Qualified certificates for Arkova signing | 4-8 weeks | $500-2,000/year per cert |

### 9.4 New Environment Variables

```bash
# AdES Signature Engine (worker only)
ENABLE_ADES_SIGNATURES=false          # feature flag
ADES_DEFAULT_LEVEL=B-T                # default signature level

# QTSP / TSA (worker only)
QTSP_PRIMARY_URL=                     # DigiCert TSA endpoint
QTSP_PRIMARY_AUTH=                    # TSA authentication (if required)
QTSP_SECONDARY_URL=                   # Sectigo TSA endpoint
QTSP_SECONDARY_AUTH=                  # TSA authentication (if required)
QTSP_TIMEOUT_MS=5000                  # TSA request timeout
QTSP_HEALTH_INTERVAL_MS=60000        # health check interval

# PKI (worker only)
EUTL_UPDATE_INTERVAL_HOURS=24        # EU Trusted List refresh interval
OCSP_CACHE_TTL_SECONDS=3600          # OCSP response cache duration
CRL_CACHE_TTL_SECONDS=86400          # CRL cache duration

# AdES KMS (worker only) -- separate from Bitcoin KMS keys
ADES_KMS_PROVIDER=                    # aws | gcp
ADES_KMS_KEY_ID=                      # signing key ARN/resource
ADES_KMS_REGION=                      # key region
```

### 9.5 New npm Dependencies (Estimated)

| Package | Purpose | License |
|---------|---------|---------|
| `asn1js` | ASN.1 parsing for X.509 certs and CMS | BSD-3 |
| `pkijs` | PKI operations (cert validation, CMS signing) | BSD-3 |
| `@peculiar/x509` | X.509 certificate parsing and building | MIT |
| `ocsp` | OCSP request/response handling | MIT |
| `pdf-lib` | PDF modification for PAdES signature embedding | MIT |

All dependencies require license review and vulnerability scan before adoption (Constitution 1.4).

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **AdES** | Advanced Electronic Signature — signature with signer identity and document integrity |
| **B-B / B-T / B-LT / B-LTA** | Baseline signature levels (Basic / Timestamped / Long-Term / Long-Term Archival) |
| **CAdES** | CMS Advanced Electronic Signatures (binary documents) |
| **CRL** | Certificate Revocation List |
| **eIDAS** | EU Regulation on electronic identification and trust services |
| **EUTL** | EU Trusted List — registry of qualified trust service providers |
| **HSM** | Hardware Security Module |
| **LTV** | Long-Term Validation — embedded data enabling offline verification |
| **OCSP** | Online Certificate Status Protocol |
| **PAdES** | PDF Advanced Electronic Signatures |
| **QES** | Qualified Electronic Signature (eIDAS Article 3(12)) |
| **QTSP** | Qualified Trust Service Provider (eIDAS-accredited) |
| **RFC 3161** | Internet X.509 PKI Time-Stamp Protocol |
| **SSCD** | Secure Signature Creation Device (HSM meeting eIDAS requirements) |
| **TSA** | Time Stamping Authority |
| **TST** | Time-Stamp Token |
| **XAdES** | XML Advanced Electronic Signatures |

---

_Specification version: 2026-04-03 | Author: Architecture Spec (Phase III planning)_
_Related: `docs/stories/22_phase2_agentic_layer.md` (Phase III placeholders), `docs/design/op_return_v2_timestamp.md` (OP_RETURN v2), `docs/BACKLOG.md` (PH3-ESIG-01/02/03)_
