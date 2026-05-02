# Changelog

## 0.2.0

- Document the API v2 organization contract change: `OrganizationSummary.publicId`
  is now `string | null` to match nullable `Org.public_id` values. SDK callers
  must null-check `publicId` before string operations such as `toUpperCase()`.
