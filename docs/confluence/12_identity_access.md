# Identity & Access API Notes
_Last updated: 2026-05-03_

## SCRUM-897 Attestation Evidence Detail

`GET /api/v1/attestations/{publicId}` is a public verification endpoint for attestation records. The default response remains stable for existing consumers. Evidence metadata is returned as a public array, and attestor credential lineage is only added when callers request it with `?include=credentials`.

### Public Evidence Metadata

Evidence rows expose public metadata only:

- `public_id` uses the `AEV-XXXXXXXXXXXX` format.
- `fingerprint` is the SHA-256 evidence fingerprint.
- `mime` is the MIME type when known.
- `size` is the artifact size in bytes when known.

Internal evidence UUIDs must not appear in API responses, SDK models, UI copy, or screenshots. The metadata migration is `supabase/migrations/0284_attestation_evidence_public_metadata.sql`.

### Attestor Credential Chain

When `include=credentials` is present, the endpoint adds `attestor_credentials[]` for the linked credential lineage. The chain is capped at the current linked credential plus two parent levels to keep response size bounded and avoid recursive agent fetch loops.

Each chain item includes `public_id`, `credential_type`, `status`, `fingerprint`, `version_number`, `parent_public_id`, `is_current`, `chain_proof`, and `record_uri`.

### Operational Notes

- The endpoint uses public IDs and public record URLs for verifier-facing surfaces.
- Evidence attachment on create stores metadata and fingerprints only, not document bytes.
- Evidence rows are inserted after the attestation row by the worker API; if optional evidence metadata insert fails, the create response includes a warning while the attestation still exists.
- Production closeout requires migration approval/application, PR review, and a smoke check for default detail and `include=credentials`.

### Verification Commands

Run these before moving SCRUM-897 to Done:

```bash
npm test -- --run services/worker/src/api/v1/attestations.test.ts services/worker/src/api/v1/response-schemas.test.ts services/worker/src/api/v1/docs.test.ts packages/sdk/src/client.test.ts
npm run typecheck
npm run lint
npm run lint:copy
python -m pytest packages/python-sdk/tests/test_client.py
git diff --check
```
