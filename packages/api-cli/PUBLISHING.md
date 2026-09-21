# Publishing `arkova-api-cli`

The repository manifest is intentionally not publishable:

- `private: true` prevents an accidental registry write;
- `arkova: file:../sdk` keeps source development pinned to the sibling SDK.

**Never hardcode the SDK version in this runbook or in a script that follows
it.** `packages/sdk`'s version moves independently of this package — e.g. a
pending change (PR #3034) bumps it to 3.2.0 — and this CLI must always be
published against **the version in `packages/sdk/package.json` at the
release commit**, i.e. the exact SDK version it was actually built and
tested with in this same release run, never a version copied from a prior
runbook edit or from memory.

Release only from a clean, isolated checkout at the approved commit. First
read the SDK version you are releasing against:

```sh
sdk_version=$(node -p "require('../sdk/package.json').version")
echo "Releasing api-cli against arkova@$sdk_version"
```

Publish `arkova@$sdk_version` first (from `packages/sdk`'s own publishing
step) and confirm that exact version is visible from npm. Then:

```sh
# The CLI prebuild hooks compile the sibling SDK, so install it first.
cd packages/sdk
npm ci --ignore-scripts
npm run build

cd packages/api-cli
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run lint

npm pkg delete private
# Caret range against the SDK version this CLI was built and tested with in
# THIS run — never an exact pin, and never a value from a previous release.
npm pkg set "dependencies.arkova=^$sdk_version"
npm install --package-lock-only --ignore-scripts

# Re-resolve from the public registry and qualify the exact release state.
rm -rf node_modules
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run lint

npm pack --dry-run
tarball=$(npm pack --silent)
npm publish --dry-run

install_dir=$(mktemp -d)
npm install --prefix "$install_dir" "$PWD/$tarball"
"$install_dir/node_modules/.bin/arkova" --help
```

Inspect the dry-run file list. It must contain only `LICENSE`, `README.md`,
`dist/cli.js`, `dist/cli.d.ts`, and `package.json` — no source map (checked
recursively under `dist/`), no `agents.md`, no test files, no eslint/vitest
config. `tsconfig.json` disables `sourceMap` and the build script cleans
`dist/` first for exactly this reason — a stale map from a prior local build
must not be able to survive into a fresh pack. The packed manifest must
contain `"arkova": "^<sdk_version>"` (the exact caret range set above), no `file:` dependency, and no `private` field.

The commands above install the produced tarball, including its exact
resolved `arkova` dependency, in an empty directory. Then run an
authenticated health check from that installed binary:

```sh
ARKOVA_API_KEY="$ARKOVA_RELEASE_SMOKE_KEY" \
  "$install_dir/node_modules/.bin/arkova" health
```

The health result must name the approved production git SHA. Publishing is an
explicit operator step after these checks; this runbook does not authorize it.
