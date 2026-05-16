# packages/arkova-py/tests/agents.md

Tests for the Arkova Python SDK.

## Files
- **`test_client.py`** — pytest tests for sync/async clients: search, verify, auth header, error handling, retry logic.

## Conventions
- Uses `httpx` transport mocks; never calls real Arkova API.
- Run via `pytest` from the `packages/arkova-py/` root.
