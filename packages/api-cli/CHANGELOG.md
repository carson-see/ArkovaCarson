# Changelog

## 0.3.0 — unreleased candidate

- Add explicit private anchor listing with date, private-tag scope, limit, and cursor filters. This remains part of the private candidate and is not a public CLI release.

All notable changes to the `arkova-api-cli` package. This file starts at 0.2.0;
for anything earlier, see `git log -- packages/api-cli/`. Versions are released
independently from the `arkova` TypeScript SDK, the `arkova-mcp-server` npm
package and the `arkova` Python package.

## 0.3.0

- Add JSON-output commands for all six generic agent lifecycle operations and ComputeID admission from a local receipt file.
- Validate agent and passport inputs before calling the SDK and redact one-time keys even when output fails after a successful response.
- This package remains private and still uses the repository-local `file:../sdk` dependency; this version does not claim registry availability.

## 0.2.0

Additive. No existing command changes shape.

- Add the `import` command: `arkova import <rows-json-file> --action
  queue|instant`, which sends 1–100 already-fingerprinted spreadsheet rows to
  `POST /api/v1/anchor/import`. Rows carry fingerprints and metadata only —
  never document bytes. Unsupported row fields, more than 100 rows and
  raw-document keys are all rejected before any request is made.
- A row may carry `recipient_email` / `recipient_name`. That assigns the record
  to that third party and can cause an activation email to be sent to that
  address. `recipient_name` without `recipient_email` is rejected locally,
  because the API rejects the whole request for that pair.
- `file_size` must be a positive integer. `0` is now rejected locally with a
  message naming the field; previously it was forwarded and the API rejected
  the entire request.
- Per-row results may report `created_recipient_failed` /
  `skipped_recipient_failed`. Both mean the anchor committed and only the
  recipient did not resolve: **the record exists, so do not re-run the row.**
  The row's `reason` code, not its status, says whether the recipient was
  linked and whether the invitation was sent.

### Requires `arkova` ^3.2.0

0.2.0 targets the `arkova` 3.2.0 SDK generation, which is the one that carries
the canonical import contract (`anchorImport`, the `*_recipient_failed`
statuses and the additive `recipientLinkFailed` counter). **Do not publish
0.2.0 against `arkova` 3.1.x**: 3.1.x predates that contract, and a CLI built
and tested against 3.2.0 must not be shipped resolving to it.

### Publish gate

0.2.0 is not tagged or published until both hold:

1. **The API serves the route.** `import` calls `POST /api/v1/anchor/import`
   directly; it does not go through the SDK's `anchorImport`. So the hard
   runtime dependency of this release is a deployed worker, not an SDK method.
   A smoke call against `api.arkova.ai` must return something other than 404
   before the tag is cut.
2. **The SDK floor is `^3.2.0`.** In the repository the dependency is declared
   as `file:../sdk`. The package's publish procedure (`PUBLISHING.md`, added with the first-publish
   change, PR #3035) rewrites it to a
   caret range on the version in `packages/sdk/package.json` at the release
   commit and regenerates the lockfile in an isolated copy; the package
   metadata test refuses any other state. It is deliberately not rewritten by
   hand here, because a `package.json` range without a regenerated lockfile
   breaks `npm ci`.
