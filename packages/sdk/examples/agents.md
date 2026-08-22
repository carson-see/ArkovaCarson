# packages/sdk/examples/agents.md

Usage examples for `arkova`.

## Files
- **`anchor-document.ts`** — minimal example: reads a file, computes fingerprint, anchors it, and prints the receipt.

## Conventions
- Examples require `ARKOVA_API_KEY` env var.
- Run via `tsx`: `ARKOVA_API_KEY=ak_live_... tsx anchor-document.ts ./document.pdf`.
- Paths are taken from argv verbatim. Absolute paths must keep working —
  `tsx anchor-document.ts /Users/me/contract.pdf` is ordinary usage, and these
  files ship inside the npm tarball, so they are the first thing a consumer runs.

## Do not add a working-directory sandbox
`tssecurity:S8707` ("Agentic workflows should not be vulnerable to path injection")
fires on any example that reads an argv-supplied path, because it models `process.argv`
as LLM-controlled. Its only compliant shape is confining the path to a base directory.

That confinement is wrong here — the argument is argv of a CLI the user invoked
themselves, so there is no trust boundary — and it breaks absolute paths. A jail was
added 2026-08-01, found in review to break first-run usage, and removed 2026-08-02.
This directory is in `sonar.exclusions` in `.sonarcloud.properties`; the full ruling is
the S8707 entry under KNOWN FALSE POSITIVES there. Do not re-add a jail to satisfy the
rule, and do not delete the exclusion without reading that entry first.
