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

Both PR CI and the PyPI publish workflow install from `uv.lock` with the exact
uv and Python versions declared in those workflows. Third-party packages are wheel-only (`uv sync --no-build`). The first-party
project is built once with the locked Hatchling and no isolated resolver; its
wheel is installed with `--no-deps --no-build`, and all checks use
`uv run --no-build`. Update the lock with each
dependency declaration and prove a clean sync before publishing or testing.

## Licensing
- **`LICENSE`** (2026-07-28, engineering-counsel review): MIT text copied verbatim from `packages/verifier-cli/LICENSE` (same copyright line, kept exact). Python convention is a root-level `LICENSE` file, not `files` array entries like the npm packages.
- `pyproject.toml` uses PEP 639 `license = "MIT"` + `license-files = ["LICENSE"]` (replaces the pre-639 `license = { text = "MIT" }` table form) so hatchling packages the LICENSE file into both the wheel's `dist-info/licenses/` and the sdist automatically. See `scripts/security/package-license-files.test.ts`.

## 2026-09-02 — packages/integrations truth pass
- **`VerificationResult.error`** (`src/arkova/models.py`): added a code comment stating the field
  is unreachable via `Client.verify()` / `Client.verify_fingerprint()` (and their async twins) —
  `_request()` calls `_raise_for_error()` before `_parse_json()` ever builds the model, so any
  response that could carry `error` raises `ArkovaError` first. The field itself was NOT removed:
  the worker's frozen v1 schema (CLAUDE.md §1.8) still declares it, and direct model construction
  (tests, fixtures) can still set it.
- **Python 3.13/3.14 classifiers** added to `pyproject.toml` (`requires-python` unchanged at
  `>=3.10`) — `pytest` (136 tests) and `ruff check src tests` both pass clean on Python 3.14.6.
- **README "Fixed in 2.2.1" corrected to "Fixed in 2.3.0"** — 2.2.1 was never published (this file
  already says "starts at 2.2.1" as a doc convention, not evidence it shipped; see `CHANGELOG.md`
  header). Install line changed to `pip install 'arkova>=2.3.0'` to match.
- Confirmed (no edit needed): `pyproject.toml` `version = "2.3.0"` and
  `.github/workflows/publish-python-sdk.yml`'s tag trigger (`arkova-py-v*`) would fire on a pushed
  `arkova-py-v2.3.0` tag. No tag was pushed as part of this pass — that remains an operator step.
