# Changelog

## 0.2.0

- Adds API v2 organization, record, fingerprint, and document detail helpers.
- Removes internal `id` fields from public SDK search and organization summary
  shapes. Use `publicId` for follow-up detail calls.
- `RecordDetails.publicId`, `DocumentDetails.publicId`, and
  `FingerprintDetails.publicId` may be `string | null` when the API cannot
  safely publish an identifier. `OrganizationSummary.publicId` remains `string`.
