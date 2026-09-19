# Arkova API CLI

`arkova` is the JSON command-line client for the Arkova API. It is tracked by
[SCRUM-5180](https://arkova.atlassian.net/browse/SCRUM-5180). The independent
`arkova-verify` command remains separate and makes no Arkova API calls.

Build and run locally:

```sh
npm --prefix packages/sdk run build
npm --prefix packages/api-cli run build
ARKOVA_API_KEY=ak_example node packages/api-cli/dist/src/cli.js health
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
arkova verify ARK-2026-001
arkova probe ARK-2026-001 --org-id 00000000-0000-0000-0000-000000000000
arkova folder list --scope ORG --org-id 00000000-0000-0000-0000-000000000000
arkova folder create --name Cases --scope USER
arkova folder move --record-id ARK-2026-001 --folder-id 00000000-0000-0000-0000-000000000000
```
