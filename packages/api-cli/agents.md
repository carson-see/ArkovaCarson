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
## 2026-09-21 — recovered #2986 release-qualification fixes onto `main`

PR #2986 ("qualify SDK, MCP, CLI, embed, and LangChain releases") merged into a feature branch
(`fix/hygiene-webhook-payloads`) that had itself already merged into `main`, so its 36-file diff
never reached `main` despite showing MERGED on GitHub. Recovered here for this package:

- `LICENSE` (MIT) + `PUBLISHING.md` (the `file:../sdk` → registry-version swap runbook, kept
  version-current: `arkova@3.1.0`, not the PR's stale `3.0.0` — `main`'s `packages/sdk` had already
  advanced past that by the time this recovery landed, and this package must never document a
  publish step that would pin an older sibling version).
- `package.json`: `files: ["dist", "README.md", "LICENSE"]`, `license: "MIT"`, `author`,
  `repository.directory`, `publishConfig.access: "public"`, `prepublishOnly` running
  typecheck+test+lint.
- `src/package-metadata.test.ts`: guards the source-vs-release manifest state, the `files`
  allowlist, and (added in this recovery, not in the original PR) that a clean build's `dist/`
  contains no `.map` files — `npm pack --dry-run` must ship exactly `LICENSE`, `README.md`,
  `dist/cli.js`, `dist/cli.d.ts`, `package.json`. The original PR's `PUBLISHING.md` expected a
  shipped `dist/cli.js.map`; that was tightened here (`tsconfig.json` `sourceMap: false`) because a
  published CLI has no consumer-facing use for a source map and every extra shipped byte is surface
  a release-integrity reviewer has to re-clear.
- README's example command block was NOT taken verbatim from the PR (which narrowed to a
  `--action queue`-only example and dropped folder-command examples with a "may not yet be enabled
  in production" disclaimer) — `main` had since shipped `arkova status` (UAT-12) and full folder
  parity (UAT-24) above, so the disclaimer was stale. The recovered README keeps both anchor actions
  and the folder examples, and points at the UAT-12/UAT-24 notes above instead of hedging.
- Added to `scripts/security/package-license-files.test.ts`'s `TS_PACKAGES` list (was previously
  absent — this package's LICENSE/files coverage had no regression guard before this recovery).

See `packages/sdk/agents.md`, `packages/embed/agents.md`, `sdks/langchain-ts/agents.md`, and
`sdks/mcp-server/agents.md` for the sibling-package side of the same recovery.
## 2026-09-26 — agent lifecycle parity

The private CLI exposes generic agent lifecycle and ComputeID admission through the sibling SDK. Validate request files and flags before the SDK call, and add returned one-time keys to the redaction set before stdout serialization. The local `file:../sdk` link is now build-time only; the packed executable bundles the SDK and has no runtime sibling-path dependency. See the 2026-09-29 candidate entry below.

An agent update with no fields is a local usage error: exit 2 without invoking the SDK or network. Keep the machine-readable help's register/update flags complete. API failures may expose only the bounded SDK detail allowlist (`code`, `reason`, `permitted`, `agent_id`, `request_id`, `retryable`, `required`, `granted`, `missing`); arbitrary detail keys and secret-like values must never reach stderr.

## 2026-09-27 — private anchor listing candidate

`anchors list` calls the authenticated organization-bound v1 list contract through `Arkova.listAnchors`; it never substitutes public v2 search. `--tag` requires an explicit `--tag-scope user|organization`. Relative `--since Nh` is converted locally to an RFC3339 timestamp. One invocation returns one bounded page and its cursor; plain-language intent parsing and automatic all-page traversal are later parity slices. Version 0.3.0 remains private/unreleased.

## 2026-09-29 — clean-installed ComputeID client candidate

An isolated consumer exposed a real distribution bug: the packed CLI retained a runtime
`arkova: file:../sdk` dependency, so npm installed a dangling sibling symlink outside this
repository. Bundle the SDK into `dist/cli.js` with tsup after a package-local TypeScript
check, keep `arkova` as a build-time devDependency, and retain `private: true` until a
separate publication decision. `src/package-metadata.test.ts` now packs the candidate,
installs it with scripts disabled into an OS temp directory outside the checkout, invokes
the installed bin, and asserts no standalone runtime `arkova` dependency. The controlled
backend seven-operation UAT is candidate transport evidence only; it cannot prove live
tenant enforcement, real signed ComputeID receipt verification, or partner acceptance.
