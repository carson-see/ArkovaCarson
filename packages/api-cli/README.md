# Arkova API CLI

`arkova` is the JSON command-line client for the Arkova API. The independent
`arkova-verify` command remains separate and makes no Arkova API calls.

After the package is published, install it with Node.js 20.14 or newer:

```sh
npm install --global arkova-api-cli@0.1.0
arkova --help
```

Build and run locally:

```sh
npm --prefix packages/sdk run build
npm --prefix packages/api-cli run build
ARKOVA_API_KEY=ak_example node packages/api-cli/dist/cli.js health
```

Every successful command writes one JSON value to stdout. Usage and API errors
write one JSON error to stderr and exit nonzero. Set `ARKOVA_BASE_URL` to select
an API deployment. Credentials are accepted from `ARKOVA_API_KEY`, or from a
JSON object piped to `--config -`; the CLI never writes credentials to disk.

`anchor` reads a local file and computes its SHA-256 fingerprint through the
shared `arkova` SDK. Only the fingerprint, selected action, description, and
private tags are sent to the API. File contents are not uploaded.

```sh
arkova anchor ./agreement.pdf --action queue --description "Signed agreement"
arkova verify ARK-2026-001
arkova probe ARK-2026-001 --org-id 00000000-0000-0000-0000-000000000000
```

The binary also exposes instant submission, private-tag, and folder commands.
Those commands require matching server capabilities and account permissions
that may not yet be enabled in production. Confirm them in the live Arkova API
documentation before automation. The `queue` action, health, read, verify, and
probe commands are the initial production-safe surface.
