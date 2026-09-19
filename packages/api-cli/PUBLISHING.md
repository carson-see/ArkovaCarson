# Publishing `arkova-api-cli`

The repository manifest is intentionally not publishable:

- `private: true` prevents an accidental registry write;
- `arkova: file:../sdk` keeps source development pinned to the sibling SDK.

Release only from a clean, isolated checkout at the approved commit. Publish
`arkova@3.0.0` first and confirm that exact version is visible from npm. Then:

```sh
cd packages/api-cli
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run lint

npm pkg delete private
npm pkg set 'dependencies.arkova=3.0.0'
npm install --package-lock-only --ignore-scripts

npm pack --dry-run
npm publish --dry-run
```

Inspect the dry-run file list. It must contain only `LICENSE`, `README.md`,
`dist/cli.js`, `dist/cli.js.map`, `dist/cli.d.ts`, and `package.json`. The
packed manifest must contain `"arkova": "3.0.0"`, no `file:` dependency, and
no `private` field.

Install the produced tarball in an empty directory using the public registry,
then run:

```sh
arkova --help
ARKOVA_API_KEY=ak_test_placeholder arkova health
```

The health result must name the approved production git SHA. Publishing is an
explicit operator step after these checks; this runbook does not authorize it.
