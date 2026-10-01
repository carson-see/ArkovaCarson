# Publishing `arkova-api-cli`

The source manifest keeps `private: true`. The sibling `arkova` SDK is a
**build-time devDependency** at `file:../sdk`; the CLI executable bundles it.
The packed CLI has no runtime `file:` dependency, so an isolated consumer can
install the tarball without the repository checkout or an unpublished SDK.
Bundling does not make this candidate publicly released.

From a clean, approved source checkout, build and test the exact candidate:

```sh
cd packages/sdk
npm ci --ignore-scripts
npm run build
npm test

cd ../api-cli
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run lint
npm pack --dry-run --ignore-scripts
```

The package should contain only `LICENSE`, `README.md`, `dist/cli.js`, and
`package.json`. Inspect the executable for a shebang and for the absence of
an external `arkova` import. No source maps or private/test files should ship.
The `private` field blocks publishing; the build-time local SDK link must not
appear in runtime `dependencies`.

Qualify the packed artifact from a directory outside this repository and any
parent `node_modules`. A repository-adjacent consumer can accidentally load an
ambient SDK and conceal a dangling `file:` link:

```sh
tarball=$(npm pack --ignore-scripts --silent)
install_dir=$(mktemp -d)
cd "$install_dir"
npm init -y
npm install --ignore-scripts --no-audit --no-fund "$OLDPWD/$tarball"
node_modules/.bin/arkova --help
npm ls --omit=dev --all
```

Use an approved, credential-scoped release test for API commands; the local
controlled backend fixture only proves packaged transport and validation.
Public publication requires a separate release decision: review the exact
artifact, version and license, remove `private` in that release candidate,
repeat the clean-install and security checks, and use the approved publishing
workflow. This runbook does not authorize npm publish or production use.
