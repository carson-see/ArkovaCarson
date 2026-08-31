# Publishing `arkova-verifier` + `arkova-verifier-cli`

First-publish runbook for the two verifier packages. Paste the commands in
order. Every command is literal — nothing here needs interpreting.

**Read this first, it is the whole reason the runbook exists:** these two
packages are published in a fixed order with a **one-line dependency edit in
between**. `arkova-verifier-cli` depends on `arkova-verifier` as
`file:../verifier`. A `file:` path cannot be published to the registry, but it
also cannot be replaced with `^0.1.0` ahead of time, because until
`arkova-verifier` is actually on the registry a fresh `npm install` would fail
to resolve it. So the edit happens **between** publish 1 and publish 2, and is
**reverted** afterwards.

| | Package | Directory | Command it installs |
|---|---|---|---|
| 1st | `arkova-verifier` | `packages/verifier` | *(library)* |
| 2nd | `arkova-verifier-cli` | `packages/verifier-cli` | `arkova-verify` |

Both names are **unscoped**. Unscoped packages are public by default, so
**`--access public` is not needed** and no npm organisation has to exist. This
is deliberate: the `@arkova` scope was never created, and per the founder
ruling recorded in `scripts/publish-packages.sh` the `arkova` org was never the
intended home. The already-published `arkova` and `arkova-mcp-server` are
unscoped under the same account, so these two match house convention.

Publishing is **founder-reserved** — run by Carson on the `crseeger` account.

---

## 0. Preflight

```bash
cd /path/to/ArkovaCarson
git checkout main
git pull
git status --porcelain           # must print NOTHING
```

Log in and confirm the account:

```bash
npm login
npm whoami                       # must print: crseeger
```

Confirm both names are still free (each must print a 404 error — that means
available):

```bash
npm view arkova-verifier version
npm view arkova-verifier-cli version
```

> npm publishes are effectively irreversible after 72 hours. Do not proceed
> until `npm whoami` prints the right account.

---

## 1. Publish `arkova-verifier` (must be first)

```bash
cd packages/verifier
npm install
npm run typecheck
npm test
npm run build
```

Inspect exactly what will ship before uploading:

```bash
npm pack --dry-run
```

Expect `dist/` (4 files), `README.md`, `LICENSE`, `package.json` — 7 files
total. If `README.md` is missing, stop: the npm page will render blank.

```bash
npm publish
```

Verify it landed:

```bash
npm view arkova-verifier version         # -> 0.1.0
npm view arkova-verifier dist-tags       # -> { latest: '0.1.0' }
```

---

## 2. The dependency edit (between the two publishes)

`arkova-verifier` is on the registry now, so the CLI can finally depend on it
by version instead of by path.

In `packages/verifier-cli/package.json`, change **one line**:

```diff
   "dependencies": {
-    "arkova-verifier": "file:../verifier"
+    "arkova-verifier": "^0.1.0"
   }
```

Then refresh the lockfile so it resolves from the registry rather than the
local path:

```bash
cd ../verifier-cli
rm -rf node_modules
npm install
```

Confirm it actually came from the registry and not from disk:

```bash
npm ls arkova-verifier           # -> arkova-verifier@0.1.0 (no "-> ./../verifier")
```

If that still shows a local path link, the edit did not take.

---

## 3. Publish `arkova-verifier-cli`

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Confirm the binary the `bin` field points at exists and is executable:

```bash
head -1 dist/cli.js              # -> #!/usr/bin/env node
node dist/cli.js --help          # -> usage text, exit 2
```

Inspect the tarball:

```bash
npm pack --dry-run
```

```bash
npm publish
```

Verify:

```bash
npm view arkova-verifier-cli version
npm view arkova-verifier-cli bin          # -> { 'arkova-verify': 'dist/cli.js' }
```

End-to-end check from the registry, in a throwaway directory — this proves a
real user's install works, including that the `arkova-verifier` dependency
resolves:

```bash
cd "$(mktemp -d)"
npm install arkova-verifier-cli
./node_modules/.bin/arkova-verify --help
```

---

## 4. Revert the dependency edit (do not skip)

**This step is mandatory.** Leaving `^0.1.0` in the committed manifest breaks
the monorepo development loop: local edits to `packages/verifier` would stop
reaching the CLI, the CI job that builds the dependency from source before
installing the CLI becomes meaningless, and the byte-identity and parity gates
would start testing the *published* verifier instead of the working tree.

Put the line back:

```diff
   "dependencies": {
-    "arkova-verifier": "^0.1.0"
+    "arkova-verifier": "file:../verifier"
   }
```

```bash
cd /path/to/ArkovaCarson/packages/verifier-cli
rm -rf node_modules
npm install                      # regenerates package-lock.json against file:
npm test                         # must be green again
git diff --stat                  # expect ONLY package.json + package-lock.json
```

Commit the revert deliberately, on a branch, so the tree ends where it started:

```bash
git checkout -b chore/verifier-post-publish-revert
git add package.json package-lock.json
git commit -m "chore(verifier-cli): restore file: dep after first npm publish"
```

> The alternative — deliberately keeping `^0.1.0` — is a real choice, but it is
> a different decision with its own consequences (above). Make it explicitly, in
> its own PR, not as a leftover from a publish.

---

## 5. After publishing

- `packages/verifier-cli/README.md` tells users to
  `npm install -g arkova-verifier-cli`. That instruction is only true once
  step 3 has completed — publish before advertising it.
- Bumping either version later: publish `arkova-verifier` first again, and if
  the CLI needs the new version, repeat steps 2–4 with the new range.
- `scripts/publish-packages.sh` covers `sdk` and `embed` only. It does **not**
  know about these two packages and must not be used for them — it has no
  concept of the ordered two-step `file:` dependency swap above.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `E404 ... PUT .../@arkova%2fverifier` on publish | Publishing a **scoped** name whose org does not exist | These packages are unscoped now. Check `name` in `package.json` has no `@arkova/` prefix. |
| `E402 payment required` | npm wants `--access public` for a scoped package | Only affects scoped names. Confirm the name is unscoped. |
| `npm ERR! 403 Forbidden` | Wrong account, or name taken since preflight | `npm whoami`; re-run the `npm view` availability check. |
| CLI install fails to resolve `arkova-verifier` | Publish order was reversed | `arkova-verifier` must be on the registry before the CLI is published. |
| Tarball has no `dist/` | Built into a stale/absent `dist` | Both packages run `prepack` on publish; if you packed with `--ignore-scripts`, run `npm run build` first. |
| `arkova-verify: command not found` after global install | Shell PATH lacks the npm global bin dir | `npm bin -g` and add it to PATH, or use `npx --package arkova-verifier-cli arkova-verify`. |
