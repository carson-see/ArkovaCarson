"""Volume + concurrency evidence for the verification model surface.

BUG-2026-08-12-007 was a *typing* defect that only ever showed up when a real
payload met the model: `compliance_controls` was declared dict-only, the API
emits a list, and pydantic raised `ValidationError` from inside `verify()`.
The per-shape unit tests in `test_client.py` pin the shapes themselves.

This module pins the two properties those tests cannot: that the model holds up
across the whole shape space **at volume**, and that it stays correct when a
single process parses responses from **many threads at once** — which is what a
heavy SDK consumer (a batch verifier, a crawler, a CI fleet) actually does.

Deliberately offline: no network, no fixtures, no clock. Everything here is
`model_validate` against generated payloads.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError

from arkova import VerificationResult

# Volume floors. Chosen to be fast (<2s) but large enough that a per-instance
# leak, a shared-mutable-default bug, or a quadratic parse would show.
TOTAL_PAYLOADS = 10_000
THREADS = 20
PER_THREAD = 500
MIN_THROUGHPUT_PER_SEC = 2_000

# The full observed shape space for the fields this PR retypes. Each entry is a
# fragment merged into a base payload. The list is the point: the defect class
# is "a shape we did not type", so the sweep must cover absence, empty, single,
# many, and unicode/long values -- not just the happy case.
CONTROL_SHAPES: list[dict] = [
    {},
    {"compliance_controls": None},
    {"compliance_controls": ["SOC2-CC6.1"]},
    {"compliance_controls": ["SOC2-CC6.1", "ISO27001-A.12.1", "NIST-800-53-AU-2"]},
    {"compliance_controls": [f"CTRL-{i:04d}" for i in range(50)]},
    {
        "compliance_controls": ["SOC2-CC6.1"],
        "compliance_controls_note": "Identifiers only. Does NOT assert an audit was performed.",
    },
    {"compliance_controls": ["ÉCHANTILLON-1", "控制-2"]},
]

# `fingerprint_source` and `proof_availability` are typed `str`, NOT `Literal`,
# precisely so an unseen value cannot raise inside a consumer's verify(). These
# entries are the regression pin for that decision: the two known values plus
# values we have never seen must all parse.
OPEN_ENUM_SHAPES: list[dict] = [
    {},
    {"fingerprint_source": "document_bytes"},
    {"fingerprint_source": "issuer_record_attestation"},
    {"fingerprint_source": "a_value_that_did_not_exist_when_this_was_written"},
    {"proof_availability": "per_document", "proof_availability_note": "Per-document proof retrievable."},
    {"proof_availability": "root_only", "proof_availability_note": "On-chain commitment only."},
    {"proof_availability": "some_future_class", "proof_availability_note": "Unclassified."},
]


def _payload(index: int) -> dict:
    base = {
        "verified": True,
        "public_id": f"pub_{index:08d}",
        "description": f"record {index}",
        "chain_confirmations": index % 500,
    }
    base.update(CONTROL_SHAPES[index % len(CONTROL_SHAPES)])
    base.update(OPEN_ENUM_SHAPES[index % len(OPEN_ENUM_SHAPES)])
    return base


def _parse_range(start: int, count: int) -> list[VerificationResult]:
    return [VerificationResult.model_validate(_payload(start + i)) for i in range(count)]


def test_shape_space_parses_at_volume() -> None:
    """10k payloads across the full shape space parse with zero ValidationError."""
    started = time.perf_counter()
    results = _parse_range(0, TOTAL_PAYLOADS)
    elapsed = time.perf_counter() - started

    assert len(results) == TOTAL_PAYLOADS
    throughput = TOTAL_PAYLOADS / elapsed
    assert throughput >= MIN_THROUGHPUT_PER_SEC, (
        f"parse throughput {throughput:,.0f}/s below floor {MIN_THROUGHPUT_PER_SEC:,}/s"
    )

    # Every control list stayed a list of str -- never coerced to dict, never
    # collapsed to None, never shared between instances.
    for result in results:
        if result.compliance_controls is not None:
            assert isinstance(result.compliance_controls, list)
            assert all(isinstance(c, str) for c in result.compliance_controls)


def test_no_cross_instance_state_leak_at_volume() -> None:
    """A 50-control record must not bleed its list into its neighbours.

    A mutable default (`= []`) on a pydantic field is the classic way this
    breaks, and it is invisible at n=1.
    """
    results = _parse_range(0, TOTAL_PAYLOADS)
    big = [r for r in results if r.compliance_controls and len(r.compliance_controls) == 50]
    small = [r for r in results if r.compliance_controls and len(r.compliance_controls) == 1]
    assert big, "expected the 50-control shape in the sweep"
    assert small, "expected the 1-control shape in the sweep"
    assert all(len(r.compliance_controls) == 50 for r in big)
    assert all(len(r.compliance_controls) == 1 for r in small)
    # Distinct objects, not one shared list.
    assert len({id(r.compliance_controls) for r in big}) == len(big)


def test_concurrent_parsing_is_correct() -> None:
    """20 threads x 500 payloads: every result parses and matches its input."""
    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        futures = [
            pool.submit(_parse_range, t * PER_THREAD, PER_THREAD) for t in range(THREADS)
        ]
        batches = [f.result() for f in futures]

    assert len(batches) == THREADS
    flat = [r for batch in batches for r in batch]
    assert len(flat) == THREADS * PER_THREAD

    # public_id is derived from the index, so a cross-thread mix-up or a torn
    # read shows up as a duplicate or a missing id.
    ids = {r.public_id for r in flat}
    assert len(ids) == THREADS * PER_THREAD

    for index, result in enumerate(_parse_range(0, 200)):
        expected = _payload(index)
        assert result.compliance_controls == expected.get("compliance_controls")
        assert result.fingerprint_source == expected.get("fingerprint_source")
        assert result.proof_availability == expected.get("proof_availability")


def test_dict_compliance_controls_still_rejected_under_the_sweep() -> None:
    """Widening to `list[str]` must not have widened to `Any`.

    If this stops raising, the model has gone permissive and the sweep above
    would pass vacuously.
    """
    with pytest.raises(ValidationError):
        VerificationResult.model_validate(
            {"verified": True, "compliance_controls": {"SOC2-CC6.1": "met"}},
        )
