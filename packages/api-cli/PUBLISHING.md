# Publishing `arkova-api-cli`

The repository manifest is intentionally not publishable:

- `private: true` prevents an accidental registry write;
- `arkova: file:../sdk` keeps source development pinned to the sibling SDK.

Release only from a clean, isolated checkout at the approved commit. Publish
`arkova@3.1.0` first and confirm that exact version is visible from npm. Then:

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
npm pkg set 'dependencies.arkova=3.1.0'
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
`dist/cli.js`, `dist/cli.d.ts`, and `package.json` — no source map, no
`agents.md`, no test files, no eslint/vitest config. The tsconfig disables
`sourceMap` for exactly this reason. The
packed manifest must contain `"arkova": "3.1.0"`, no `file:` dependency, and
no `private` field.

The commands above install the produced tarball, including its exact public
`arkova@3.1.0` dependency, in an empty directory. Then run an authenticated
health check from that installed binary:

```sh
ARKOVA_API_KEY="$ARKOVA_RELEASE_SMOKE_KEY" \
  "$install_dir/node_modules/.bin/arkova" health
```

The health result must name the approved production git SHA. Publishing is an
explicit operator step after these checks; this runbook does not authorize it.
