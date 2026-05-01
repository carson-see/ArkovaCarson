# SCRUM-1597 Credential Evidence Migration Plan

Status: draft for review  
Scope: schema, canonicalization, hash helper, public-safe metadata, and migration plan only.

## Goal

Arkova needs to anchor credential evidence from third-party sources without overstating the trust level. The hash must bind the original `source_url`, normalized source metadata, credential summary, and evidence-strength label into one deterministic `credential_evidence_v1` package.

This plan intentionally does not add live provider fetching, account linking, or issuer submission. Those belong to later CSI stories.

## Current Safe Path

For the first implementation slice, no database table migration is required. The existing `anchors.metadata` JSONB column can carry additive public-safe fields:

- `evidence_schema_version`
- `evidence_package_hash`
- `source_url`
- `source_provider`
- `source_id`
- `source_fetched_at`
- `source_payload_hash`
- `source_payload_content_type`
- `source_payload_byte_length`
- `verification_level`
- `extraction_method`
- `extraction_manifest_hash`
- `extraction_confidence`
- `credential_title`
- `credential_type`
- `credential_issuer`
- `credential_issued_at`
- `credential_expires_at`
- `credential_id_hash`
- `recipient_identifier_hash`

These are additive and public-safe. They do not alter the frozen v1 verification response field names. Public verification can later choose to expose them inside sanitized metadata or a new additive metadata block.

## Canonical Hash Contract

The anchored fingerprint for URL-imported credential evidence should be the SHA-256 of canonical JSON for:

```json
{
  "schemaVersion": "credential_evidence_v1",
  "source": {
    "provider": "credly",
    "url": "https://example.com/badges/123",
    "id": "123",
    "fetchedAt": "2026-05-01T15:00:00.000Z",
    "payloadHash": "..."
  },
  "credential": {
    "type": "BADGE",
    "title": "Cloud Architecture Fundamentals",
    "issuerName": "Example Cloud",
    "issuedAt": "2026-03-20"
  },
  "evidence": {
    "verificationLevel": "captured_url",
    "extractionMethod": "html_metadata",
    "confidence": 0.74
  }
}
```

The final package stores `evidencePackageHash` alongside the normalized input, but the hash input excludes `evidencePackageHash` to avoid recursive hashing.

## URL Safety Rules

Before a `source_url` enters the evidence package:

- require absolute `http` or `https`
- reject localhost, `.localhost`, `.local`, private IPv4, loopback IPv4, link-local IPv4, CGNAT IPv4 (`100.64.0.0/10`), IPv4-mapped IPv6 for those ranges (for example `::ffff:127.0.0.1`), loopback IPv6, link-local IPv6, and unique-local IPv6 literals
- strip username/password
- strip fragments
- strip known secret query params such as `token`, `access_token`, `signature`, `key`, `secret`, `jwt`, `authorization`
- strip tracking params such as `utm_*`, `fbclid`, and `gclid`
- sort remaining query params before canonicalization

Later live-fetch work must add DNS resolution checks and redirect re-validation before making outbound HTTP requests.

## Future Table Migration

When CSI-02/CSI-04 move beyond metadata-only MVP, add a dedicated `credential_evidence_records` table:

```sql
CREATE TABLE credential_evidence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  schema_version text NOT NULL CHECK (schema_version = 'credential_evidence_v1'),
  evidence_package_hash char(64) NOT NULL CHECK (evidence_package_hash ~ '^[a-f0-9]{64}$'),
  source_provider text NOT NULL,
  source_url text NOT NULL,
  source_id text,
  source_fetched_at timestamptz NOT NULL,
  source_payload_hash char(64) NOT NULL CHECK (source_payload_hash ~ '^[a-f0-9]{64}$'),
  verification_level text NOT NULL,
  extraction_method text NOT NULL,
  public_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  private_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (anchor_id),
  UNIQUE (user_id, evidence_package_hash)
);
```

RLS plan:

- users can select their own evidence records
- org admins can select org-owned evidence records
- public verification reads only sanitized anchor metadata or a security-definer RPC
- `private_evidence` is never exposed through public verification

Index plan:

- `credential_evidence_records(anchor_id)`
- `credential_evidence_records(user_id, created_at DESC)`
- `credential_evidence_records(source_provider, source_id)` where `source_id IS NOT NULL`
- `credential_evidence_records(evidence_package_hash)`

## Verification Response Compatibility

Do not rename or remove frozen v1 verification response fields. Any public additions must be additive and safe:

- preserve current public verification schema
- add source provenance only through sanitized metadata or an additive `evidence`/`source` block in a future version
- never expose raw recipient names, emails, source tokens, signed URLs, cookies, or bearer material

## Rollout Plan

1. Land schema/helper/tests and public-safe metadata parsing.
2. Use `anchors.metadata` for CSI-02 URL-import MVP.
3. Add public verification rendering only after metadata has production fixtures.
4. Introduce `credential_evidence_records` table only when provider adapters or account-linked imports need private/raw payload retention.
5. Backfill table from `anchors.metadata` for records with `evidence_schema_version = 'credential_evidence_v1'`.

## Non-Goals

- no live provider fetching
- no OAuth/account linking
- no issuer submission API
- no public verification field removals or renames
- no raw credential payload storage in public metadata
