# Changelog

All notable changes to the `arkova-api-cli` package. This file starts at 0.2.0;
for anything earlier, see `git log -- packages/api-cli/`. Versions are released
independently from the `arkova` TypeScript SDK, the `arkova-mcp-server` npm
package and the `arkova` Python package.

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

Note for the release owner: the dependency in `package.json` is still declared
as `file:../sdk`, and `package-lock.json` records it as a local link with no
registry entry or integrity hash. Converting it to the published `^3.2.0` range
requires regenerating the lockfile, which could not be done in this change (no
`npm install` is possible against the symlinked `node_modules`). The package is
also still `private: true`, so nothing publishes from this state yet.
