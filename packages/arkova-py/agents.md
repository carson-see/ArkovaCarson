# packages/arkova-py/agents.md

`arkova` — typed Python SDK for the Arkova Verification APIs. Published to PyPI as `arkova`.

## Structure
- **`src/arkova/`** — package source.
- **`pyproject.toml`** — hatchling build backend.
- **`tests/`** — pytest suite.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE` (same copyright line, kept exact). Python convention is a root-level `LICENSE` file, not `files` array entries like the npm packages.
- `pyproject.toml` uses PEP 639 `license = "MIT"` + `license-files = ["LICENSE"]` (replaces the pre-639 `license = { text = "MIT" }` table form) so hatchling packages the LICENSE file into both the wheel's `dist-info/licenses/` and the sdist automatically. See `scripts/security/package-license-files.test.ts`.
