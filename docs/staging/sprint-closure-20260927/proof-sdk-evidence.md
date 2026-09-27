# Singleton proof SDK parity — TDD evidence

Baseline: `04d59d52e94060eae571598460a1bdd0771c924c` in `debt-recovery-20260926`.

## RED

After adding only the coherent singleton fixtures:

- TypeScript: `npm test -- --run src/client.test.ts -t 'coherent single-leaf'` — **1 failed** at `expect(result.proofBundle).not.toBeNull()`; the mapper returned `null`.
- Python: `uv run --locked --no-sync --no-build pytest tests/test_client.py -q -k 'singleton_empty_branch'` — **1 failed** at `assert result.proof_bundle is not None`; the model returned `None`.

The first attempted runs could not start because dependencies were absent. Dependencies were installed from the package lockfiles before recording the meaningful RED runs above.

## GREEN

Focused contract suites after the implementation:

- TypeScript `getMerkleProof`: **25 passed**, 102 skipped.
- Python `get_merkle_proof`: **16 passed**, 122 deselected.

Full package gates:

- TypeScript SDK 3.2.1: **143/143 tests passed**; `tsc --noEmit` passed; package build including declarations passed.
- Python SDK 2.5.1: **200/200 tests passed**; `uv lock --check` and `ruff check src tests` passed.
- `git diff --check` passed.

The positive fixtures cover sync TypeScript plus sync/async Python, use a mixed-case root/fingerprint pair, and carry `ARKV + fingerprint` in `op_return_payload`. The negative matrices retain rejection of empty multi-leaf branches, singleton branches with a nonzero index, singleton branches whose root differs from the fingerprint, equal but non-hex roots/fingerprints, missing/null branches with otherwise coherent singleton fields, other missing/null required fields, wrong types, and malformed entries.
