# packages/api-cli/agents.md

## 2026-09-19 — UAT-12 durable status parity

`arkova status <public-id>` reads the API-key caller-scoped
`GET /api/v1/anchor/{publicId}/submission-status` contract and prints bounded JSON unchanged. It is
a read command: no retry/rearm or credit purchase is inferred from status output.

## 2026-09-19 — UAT-24 folder parity

The CLI exposes list/create/update/reparent/delete/connector-bind-or-clear/bulk-move through the canonical folder routes. `--root` is the explicit null-parent operation; connector clear cannot be combined with binding fields.

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
