# packages/api-cli/agents.md

## 2026-09-19 — UAT-12 durable status parity

`arkova status <public-id>` reads the API-key caller-scoped
`GET /api/v1/anchor/{publicId}/submission-status` contract and prints bounded JSON unchanged. It is
a read command: no retry/rearm or credit purchase is inferred from status output.

## 2026-09-19 — UAT-23 row import

`arkova import <rows-json-file>` accepts only strict fingerprint rows, caps input at 100, sends no file bytes or `org_id`, and never automatically retries the write.
## 2026-09-19 — UAT-24 folder parity

The CLI exposes list/create/update/reparent/delete/connector-bind-or-clear/bulk-move through the canonical folder routes. `--root` is the explicit null-parent operation; connector clear cannot be combined with binding fields.

## 2026-09-21 — 0.2.0 (PR #3034)

The `import` command is new public surface, so the package goes 0.1.0 -> 0.2.0
(`package.json` plus the root and `""` entries in `package-lock.json`, edited by
hand — `node_modules` is a symlink into another worktree, so `npm install` must
not run here). There is no hardcoded version literal in `src/` and no
`package-metadata.test.ts` at this head, so nothing else needed updating.

`CHANGELOG.md` starts at 0.2.0 and states the `arkova` ^3.2.0 requirement.
KNOWN GAP, recorded rather than papered over: the dependency is still declared
`file:../sdk` and the lockfile records it as a local link with no registry entry
or integrity hash, so converting it to the published `^3.2.0` range needs a
lockfile regeneration that could not happen here. The package is also still
`private: true`. Note too that the CLI does NOT call the SDK's `anchorImport` —
`import` goes through the CLI's own `CliClient.request('/api/v1/anchor/import')`
— so the SDK pin is a generation pin, not a call-site dependency.
