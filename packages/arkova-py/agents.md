# packages/arkova-py/agents.md

`arkova` — typed Python SDK for the Arkova Verification APIs. Published to PyPI as `arkova`.

## Structure
- **`src/arkova/`** — package source.
- **`pyproject.toml`** — hatchling build backend. Holds the version that becomes the PyPI release.
- **`tests/`** — pytest suite.
- **`CHANGELOG.md`** — starts at 2.2.1. Ships in the sdist, not the wheel.

## Response models mirror an emitter, not a schema
The authority for any response shape is the worker code that BUILDS it, not an
OpenAPI block, not a TS `interface`, and not a captured sample. 2.2.1 and 2.3.0
between them corrected eight fields that came from the latter three: a `dict`
typed off a stale snapshot, and seven fields no code path could populate (one of
them copied from an `interface RowError` member the worker never assigns).
`tests/test_client.py` now pins a per-model key set transcribed from each
emitter, so this is enforced rather than remembered — see `tests/agents.md`.

## Releasing — the version in `pyproject.toml` is the ONLY thing that reaches PyPI
`publish-python-sdk.yml` fires on a pushed `arkova-py-v*` tag (PyPI Trusted
Publishing via OIDC — no token in the repo). **A source fix with no version bump
is not a release**, and nothing warns you: BUG-2026-08-12-007 was exactly that.
The `compliance_controls` fix landed in `a1592b975` four hours after the
`arkova-py-v2.2.0` tag was cut, the version stayed `2.2.0`, and the published
wheel kept a broken `verify()` for two weeks. When you change anything under
`src/arkova/`, bump the version and add a CHANGELOG entry in the same PR, or say
in the PR body why the change is deliberately not being released yet.

## CI
`ci.yml` job **`python-sdk-tests`** runs `pytest` + `ruff check src tests` on
every PR, mirroring the publish workflow's interpreter and commands. Before
2026-08-15 this package's suite ran ONLY inside the tag-triggered publish
workflow, so no pull request ever executed it — which is why a model/API type
mismatch reached PyPI unchallenged. `scripts/ci/ci-workflow-contract.test.ts`
("ci.yml Python SDK suite is actually invoked") is the ratchet that keeps the job
wired; deleting the job fails that suite.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE` (same copyright line, kept exact). Python convention is a root-level `LICENSE` file, not `files` array entries like the npm packages.
- `pyproject.toml` uses PEP 639 `license = "MIT"` + `license-files = ["LICENSE"]` (replaces the pre-639 `license = { text = "MIT" }` table form) so hatchling packages the LICENSE file into both the wheel's `dist-info/licenses/` and the sdist automatically. See `scripts/security/package-license-files.test.ts`.
