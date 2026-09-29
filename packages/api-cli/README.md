# Arkova API CLI

`arkova` is the JSON command-line client for the Arkova API. The independent
`arkova-verify` command remains separate and makes no Arkova API calls.

After the package is published, install it with Node.js 20.14 or newer:

```sh
npm install --global arkova-api-cli@0.3.1
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
arkova anchor ./agreement.pdf --action instant --description "Signed agreement" --tag legal
arkova status ARK-2026-EXAMPLE
arkova verify ARK-2026-001
arkova probe ARK-2026-001 --org-id 00000000-0000-0000-0000-000000000000
arkova folder list --scope ORG --org-id 00000000-0000-0000-0000-000000000000
arkova folder create --name Cases --scope USER
arkova folder move --record-id ARK-2026-001 --folder-id 00000000-0000-0000-0000-000000000000
```

The binary exposes both the `queue` and `instant` anchor actions, plus status,
private-tag, and folder (list/create/update/reparent/delete/connector/bulk-move)
commands — all backed by the canonical API routes documented in
`packages/api-cli/agents.md` (UAT-12 status parity, UAT-24 folder parity).
Confirm capability flags for your account in the live Arkova API documentation
before automating a specific action.

## Agent lifecycle

Use `arkova agent register|list|get|update|revoke`, `arkova agent key create`, and `arkova agent computeid admit --request-json <local-file>`. Configure an organization API key with `agents:manage`; ComputeID admission is API-key-only and does not widen scopes. Output is JSON. Store one-time key output immediately. The restricted key returned by admission is not automatically an agent-management key. The CLI remains a private release candidate; its executable bundles the sibling SDK so the packed CLI can run from a clean consumer directory.

Requests have a 10-second timeout by default. Set `ARKOVA_TIMEOUT_MS` or pass `timeoutMs` in stdin configuration to choose an integer from 1 to 120000 milliseconds. Agent registration, key creation, and ComputeID admission are non-idempotent and are not automatically retried after a timeout; inspect their state before an operator retry.
