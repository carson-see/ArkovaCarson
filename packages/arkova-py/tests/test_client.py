from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from pydantic import ValidationError

from arkova import (
    BULK_ANCHOR_MAX_ROWS,
    Anchor,
    AnchorReceipt,
    Arkova,
    ArkovaError,
    AsyncArkova,
    BulkAnchorInput,
    BulkAnchorRowError,
    FingerprintVerification,
    SearchResult,
    VerificationResult,
)
from arkova.models import (
    DocumentDetail,
    FingerprintDetail,
    OrganizationDetail,
    RecordDetail,
    RichVerificationFields,
)


def json_response(
    payload: dict,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    return httpx.Response(status_code, json=payload, headers=headers)


def test_search_returns_pydantic_models_and_auth_header() -> None:
    seen_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers.get("authorization"))
        assert request.url.params["q"] == "nurse"
        return json_response(
            {
                "results": [
                    {
                        "type": "record",
                        "id": "internal-record-uuid",
                        "public_id": "ARK-DOC-ABC",
                        "score": 1.0,
                        "snippet": "Nursing license",
                        "future_field": "kept",
                    }
                ],
                "next_cursor": None,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.search("nurse", type="record")

    assert seen_headers == ["Bearer ak_test"]
    assert result.results[0].public_id == "ARK-DOC-ABC"
    assert "id" not in result.results[0].model_fields_set
    assert not hasattr(result.results[0], "id")
    assert result.results[0].future_field == "kept"


def test_problem_json_errors_preserve_retry_after() -> None:
    transport = httpx.MockTransport(
        lambda _request: json_response(
            {
                "type": "https://arkova.ai/problems/rate-limited",
                "title": "Rate Limit Exceeded",
                "status": 429,
                "detail": "Slow down.",
            },
            status_code=429,
            headers={"content-type": "application/problem+json", "Retry-After": "42"},
        )
    )

    with (
        pytest.raises(ArkovaError) as exc_info,
        Arkova(api_key="ak_test", retries=0, transport=transport) as client,
    ):
        client.list_orgs()

    assert exc_info.value.status_code == 429
    assert exc_info.value.retry_after == 42
    assert exc_info.value.problem is not None
    assert exc_info.value.problem.type.endswith("/rate-limited")


def test_list_orgs_does_not_expose_internal_id() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "organizations": [
                    {
                        "id": "internal-org-uuid",
                        "public_id": "org_acme",
                        "display_name": "Acme Corp",
                        "domain": "acme.com",
                        "website_url": "https://acme.com",
                        "verification_status": "VERIFIED",
                        "future_field": "kept",
                    }
                ]
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.list_orgs()

    assert result.organizations[0].public_id == "org_acme"
    assert "id" not in result.organizations[0].model_fields_set
    assert not hasattr(result.organizations[0], "id")
    assert result.organizations[0].future_field == "kept"


def test_retries_429_before_success() -> None:
    attempts = 0
    sleeps: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return json_response(
                {
                    "type": "https://arkova.ai/problems/rate-limited",
                    "title": "Rate Limit Exceeded",
                    "status": 429,
                },
                status_code=429,
                headers={"content-type": "application/problem+json", "Retry-After": "3"},
            )
        return json_response(
            {
                "verified": True,
                "status": "ACTIVE",
                "fingerprint": "a" * 64,
                "public_id": "ARK-DOC-ABC",
            }
        )

    with Arkova(
        api_key="ak_test",
        retries=1,
        sleep=sleeps.append,
        transport=httpx.MockTransport(handler),
    ) as client:
        result = client.verify_fingerprint("a" * 64)

    assert result.verified is True
    assert attempts == 2
    assert sleeps == [3.0]


def test_verify_fingerprint_exposes_typed_rich_fields_when_returned() -> None:
    assert "confidence_scores" in FingerprintVerification.model_fields
    assert "sub_type" in FingerprintVerification.model_fields

    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "verified": True,
                "status": "ACTIVE",
                "fingerprint": "a" * 64,
                "public_id": "ARK-DOC-ABC",
                "description": "Transcript",
                "confidence_scores": {"overall": 0.89},
                "sub_type": "official_transcript",
                "file_mime": "application/pdf",
                "file_size": 4096,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.verify_fingerprint("a" * 64)

    assert result.description == "Transcript"
    assert result.confidence_scores == {"overall": 0.89}
    assert result.sub_type == "official_transcript"
    assert result.file_mime == "application/pdf"
    assert result.file_size == 4096


def test_verify_maps_rich_v1_verification_fields() -> None:
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        assert request.headers.get("authorization") == "Bearer ak_test"
        return json_response(
            {
                "verified": True,
                "status": "ACTIVE",
                "issuer_name": "University of Michigan",
                "recipient_identifier": "hash_123",
                "credential_type": "DEGREE",
                "issued_date": "2025-05-01",
                "expiry_date": None,
                "anchor_timestamp": "2026-04-24T12:00:00Z",
                "bitcoin_block": 123456,
                "network_receipt_id": "tx-1",
                "merkle_proof_hash": None,
                "record_uri": "https://app.arkova.ai/verify/ARK-2026-ABC",
                "jurisdiction": "US-MI",
                "explorer_url": "https://mempool.space/tx/tx-1",
                "description": "Bachelor of Science credential",
                "ferpa_notice": "Redisclosure notice",
                "directory_info_suppressed": False,
                "compliance_controls": ["SOC2-CC6.1"],
                "chain_confirmations": 6,
                "parent_public_id": "ARK-2026-PARENT",
                "version_number": 2,
                "revocation_tx_id": None,
                "revocation_block_height": None,
                "file_mime": "application/pdf",
                "file_size": 2048,
                "confidence_scores": {
                    "overall": 0.92,
                    "grounding": 0.88,
                    "fields": {"issuerName": 0.95},
                },
                "sub_type": "official_undergraduate",
            }
        )

    with Arkova(
        api_key="ak_test",
        base_url="https://api.arkova.test/v2",
        transport=httpx.MockTransport(handler),
    ) as client:
        result = client.verify("ARK-2026-ABC")

    assert seen_paths == ["/v1/verify/ARK-2026-ABC"]
    assert result.verified is True
    assert result.issuer_name == "University of Michigan"
    assert result.description == "Bachelor of Science credential"
    assert result.compliance_controls == ["SOC2-CC6.1"]
    assert result.chain_confirmations == 6
    assert result.parent_public_id == "ARK-2026-PARENT"
    assert result.version_number == 2
    assert result.file_mime == "application/pdf"
    assert result.file_size == 2048
    assert result.confidence_scores == {
        "overall": 0.92,
        "grounding": 0.88,
        "fields": {"issuerName": 0.95},
    }
    assert result.sub_type == "official_undergraduate"


def test_verify_uses_api_v1_sibling_path_when_base_url_includes_api_v2() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/verify/ARK-2026-ABC"
        return json_response({"verified": False, "status": "PENDING"})

    with Arkova(
        api_key="ak_test",
        base_url="https://worker.example/api/v2",
        transport=httpx.MockTransport(handler),
    ) as client:
        result = client.verify("ARK-2026-ABC")

    assert result.verified is False
    assert result.status == "PENDING"


def test_verify_percent_encodes_public_id_sync() -> None:
    seen_raw_paths: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_raw_paths.append(request.url.raw_path)
        return json_response({"verified": True, "status": "ACTIVE"})

    with Arkova(
        api_key="ak_test",
        base_url="https://worker.example/api/v2",
        transport=httpx.MockTransport(handler),
    ) as client:
        result = client.verify("ARK-2026/A B?C")

    assert seen_raw_paths == [b"/api/v1/verify/ARK-2026%2FA%20B%3FC"]
    assert result.verified is True


def test_verify_percent_encodes_public_id_async() -> None:
    async def run() -> tuple[list[bytes], bool]:
        seen_raw_paths: list[bytes] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_raw_paths.append(request.url.raw_path)
            return json_response({"verified": True, "status": "ACTIVE"})

        async with AsyncArkova(
            api_key="ak_test",
            base_url="https://worker.example/api/v2",
            transport=httpx.MockTransport(handler),
        ) as client:
            result = await client.verify("ARK-2026/A B?C")
            return seen_raw_paths, result.verified

    seen_raw_paths, verified = asyncio.run(run())
    assert seen_raw_paths == [b"/api/v1/verify/ARK-2026%2FA%20B%3FC"]
    assert verified is True


def test_async_client_get_anchor() -> None:
    async def run() -> str:
        async def handler(_request: httpx.Request) -> httpx.Response:
            return json_response(
                {
                    "public_id": "ARK-DOC-ABC",
                    "verified": True,
                    "status": "ACTIVE",
                    "record_uri": "https://app.arkova.ai/verify/ARK-DOC-ABC",
                }
            )

        async with AsyncArkova(
            api_key="ak_test",
            transport=httpx.MockTransport(handler),
        ) as client:
            result = await client.get_anchor("ARK-DOC-ABC")
            return result.record_uri

    assert asyncio.run(run()) == "https://app.arkova.ai/verify/ARK-DOC-ABC"


def test_get_anchor_exposes_typed_rich_fields_when_returned() -> None:
    assert "confidence_scores" in Anchor.model_fields
    assert "sub_type" in Anchor.model_fields

    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "public_id": "ARK-DOC-ABC",
                "verified": True,
                "status": "ACTIVE",
                "record_uri": "https://app.arkova.ai/verify/ARK-DOC-ABC",
                "description": "Diploma",
                "compliance_controls": ["FERPA-99.31"],
                "chain_confirmations": 3,
                "parent_public_id": "ARK-DOC-PARENT",
                "version_number": 2,
                "revocation_tx_id": "rev-tx",
                "revocation_block_height": 123457,
                "file_mime": "application/pdf",
                "file_size": 8192,
                "confidence_scores": {"overall": 0.91},
                "sub_type": "official_undergraduate",
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.get_anchor("ARK-DOC-ABC")

    assert result.description == "Diploma"
    assert result.compliance_controls == ["FERPA-99.31"]
    assert result.chain_confirmations == 3
    assert result.parent_public_id == "ARK-DOC-PARENT"
    assert result.version_number == 2
    assert result.revocation_tx_id == "rev-tx"
    assert result.revocation_block_height == 123457
    assert result.file_mime == "application/pdf"
    assert result.file_size == 8192
    assert result.confidence_scores == {"overall": 0.91}
    assert result.sub_type == "official_undergraduate"


def test_async_verify_maps_rich_v1_verification_fields() -> None:
    async def run() -> tuple[float | None, str | None, str | None]:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/v1/verify/ARK-2026-ABC"
            return json_response(
                {
                    "verified": True,
                    "status": "ACTIVE",
                    "description": "Transcript",
                    "confidence_scores": {"overall": 0.81},
                    "sub_type": "official_transcript",
                }
            )

        async with AsyncArkova(
            api_key="ak_test",
            base_url="https://api.arkova.test/v2",
            transport=httpx.MockTransport(handler),
        ) as client:
            result = await client.verify("ARK-2026-ABC")
            return (
                result.confidence_scores["overall"] if result.confidence_scores else None,
                result.description,
                result.sub_type,
            )

    overall, description, sub_type = asyncio.run(run())
    assert overall == pytest.approx(0.81)
    assert description == "Transcript"
    assert sub_type == "official_transcript"


# PROOF-05 (SCRUM-2338) — get_merkle_proof + additive nullable proof_bundle.


def test_get_merkle_proof_populated_bundle_via_api_v1() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/verify/abc123/proof"
        return json_response(
            {
                "public_id": "abc123",
                "fingerprint": "ff" * 32,
                "merkle_root": "aa" * 32,
                "merkle_proof": [{"hash": "bb" * 32, "position": "left"}],
                "tx_id": "tx-999",
                "block_height": 800000,
                "block_timestamp": "2026-04-18T10:00:00Z",
                "batch_id": "batch-1",
                "verified": True,
                "proof_bundle": {
                    "fingerprint": "ff" * 32,
                    "merkle_root": "aa" * 32,
                    "merkle_proof": [{"hash": "bb" * 32, "position": "left"}],
                    "merkle_index": 0,
                    "leaf_count": 4,
                    "tx_id": "tx-999",
                    "block_height": 800000,
                    "block_hash": "cc" * 32,
                    "block_header": "dd" * 80,
                    # Canonical ARKV + 32-byte root, NO version byte.
                    "op_return_payload": "41524b56" + "ee" * 32,
                    "block_timestamp": "2026-04-18T10:00:00Z",
                    "proof_schema_version": 1,
                    "signature": None,
                },
            }
        )

    with Arkova(
        api_key="ak_test",
        base_url="https://worker.example/api/v2",
        transport=httpx.MockTransport(handler),
    ) as client:
        result = client.get_merkle_proof("abc123")

    assert result.verified is True
    assert result.proof_bundle is not None
    assert result.proof_bundle.block_hash == "cc" * 32
    assert result.proof_bundle.block_header == "dd" * 80
    assert result.proof_bundle.merkle_index == 0
    assert result.proof_bundle.leaf_count == 4
    assert result.proof_bundle.proof_schema_version == 1
    assert result.proof_bundle.signature is None


def test_get_merkle_proof_null_bundle_when_incomplete() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "public_id": "abc123",
                "fingerprint": "ff" * 32,
                "merkle_root": "aa" * 32,
                "merkle_proof": [],
                "verified": False,
                "proof_bundle": None,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.get_merkle_proof("abc123")

    assert result.proof_bundle is None


# CodeRabbit (SCRUM-2338): a malformed but NON-null proof_bundle must fail closed
# to None — never manufacture a valid-looking, unverifiable bundle.
_COMPLETE_WIRE_BUNDLE = {
    "fingerprint": "ff" * 32,
    "merkle_root": "aa" * 32,
    "merkle_proof": [{"hash": "bb" * 32, "position": "left"}],
    "merkle_index": 0,
    "leaf_count": 4,
    "tx_id": "tx-999",
    "block_height": 800000,
    "block_hash": "cc" * 32,
    "block_header": "dd" * 80,
    "op_return_payload": "41524b56" + "ee" * 32,
    "block_timestamp": "2026-04-18T10:00:00Z",
    "proof_schema_version": 1,
    "signature": None,
}


@pytest.mark.parametrize(
    "mutation",
    [
        {"tx_id": None},
        {"block_height": None},
        {"leaf_count": "4"},
        {"block_header": None},
        {"merkle_proof": "nope"},
        {"merkle_proof": []},
        {"merkle_proof": [{"hash": "bb" * 32, "position": "up"}]},
        {"fingerprint": None},
        {"op_return_payload": None},
        {"merkle_index": None},
    ],
    ids=lambda m: "-".join(m.keys()),
)
def test_get_merkle_proof_malformed_bundle_fails_closed(mutation: dict) -> None:
    bad_bundle = {**_COMPLETE_WIRE_BUNDLE, **mutation}

    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "public_id": "abc123",
                "fingerprint": "ff" * 32,
                "merkle_root": "aa" * 32,
                "merkle_proof": [{"hash": "bb" * 32, "position": "left"}],
                "tx_id": "tx-999",
                "block_height": 800000,
                "block_timestamp": "2026-04-18T10:00:00Z",
                "batch_id": "batch-1",
                "verified": True,
                "proof_bundle": bad_bundle,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.get_merkle_proof("abc123")

    # The frozen top-level response still parses; only the bundle fails closed.
    assert result.verified is True
    assert result.proof_bundle is None


def test_get_merkle_proof_missing_required_member_fails_closed() -> None:
    bad_bundle = {k: v for k, v in _COMPLETE_WIRE_BUNDLE.items() if k != "tx_id"}

    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "public_id": "abc123",
                "fingerprint": "ff" * 32,
                "merkle_root": "aa" * 32,
                "merkle_proof": [{"hash": "bb" * 32, "position": "left"}],
                "verified": True,
                "proof_bundle": bad_bundle,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.get_merkle_proof("abc123")

    assert result.proof_bundle is None


def test_user_agent_matches_installed_package_version() -> None:
    from importlib.metadata import PackageNotFoundError, version

    try:
        expected_version = version("arkova")
    except PackageNotFoundError:  # repo-checkout run without pip install -e .
        expected_version = "unknown"

    seen: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers.get("user-agent"))
        return json_response({"results": [], "next_cursor": None})

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        client.search("anything")

    assert seen == [f"arkova-python/{expected_version}"]


# ── anchor() / anchor_bulk() write path (HAKI-REQ-02) ────────────────────


def test_fingerprint_matches_known_sha256() -> None:
    with Arkova(api_key="ak_test", transport=httpx.MockTransport(lambda r: json_response({}))) as client:
        fp = client.fingerprint("hello world")
    assert fp == "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"


def test_anchor_sends_precomputed_fingerprint_via_bearer_auth() -> None:
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        return json_response(
            {
                "public_id": "ARK-2026-001",
                "fingerprint": "a" * 64,
                "status": "PENDING",
                "created_at": "2026-01-01T00:00:00Z",
                "record_uri": "https://app.arkova.ai/verify/ARK-2026-001",
            },
            status_code=201,
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        receipt = client.anchor(fingerprint="a" * 64)

    assert receipt.public_id == "ARK-2026-001"
    assert receipt.status == "PENDING"
    assert receipt.record_uri == "https://app.arkova.ai/verify/ARK-2026-001"
    assert len(seen_requests) == 1
    req = seen_requests[0]
    assert req.method == "POST"
    assert req.url.path == "/v1/anchor"
    assert req.headers.get("authorization") == "Bearer ak_test"
    assert json.loads(req.content) == {"fingerprint": "a" * 64}


def test_anchor_fingerprints_data_client_side_raw_content_never_sent() -> None:
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        return json_response(
            {
                "public_id": "ARK-2026-002",
                "fingerprint": "irrelevant",
                "status": "PENDING",
                "created_at": "2026-01-01T00:00:00Z",
                "record_uri": "https://app.arkova.ai/verify/ARK-2026-002",
            },
            status_code=201,
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        expected_fp = client.fingerprint("raw document body")
        client.anchor("raw document body")

    assert len(seen_requests) == 1
    body = seen_requests[0].content
    assert b"raw document body" not in body
    assert json.loads(body) == {"fingerprint": expected_fp}


def test_anchor_rejects_neither_fingerprint_nor_data_without_network_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    with (
        Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor()

    assert exc_info.value.code == "invalid_request"


def test_anchor_rejects_both_fingerprint_and_data_without_network_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    with (
        Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor("data", fingerprint="a" * 64)

    assert exc_info.value.code == "invalid_request"


def test_anchor_plain_json_error_surfaces_message_and_code() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response({"error": "Invalid fingerprint"}, status_code=400)

    with (
        Arkova(api_key="ak_test", retries=0, transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor(fingerprint="a" * 64)

    assert exc_info.value.status_code == 400
    # No separate `message` key on this payload — `error` doubles as both the
    # code and the display message (parity with the TS SDK's `jsonOrThrow`
    # fallback chain: `json.message ?? json.error ?? generic`).
    assert str(exc_info.value) == "Invalid fingerprint"


def test_anchor_bulk_empty_input_returns_zero_row_response_no_network_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.anchor_bulk([])

    assert result.validated == 0
    assert result.queued == 0
    assert result.duplicates == []
    assert result.errors == []
    assert result.dry_run is False
    assert result.anchors == []


def test_anchor_bulk_rejects_over_cap_without_network_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    rows = [BulkAnchorInput(fingerprint="a" * 64) for _ in range(BULK_ANCHOR_MAX_ROWS + 1)]
    with (
        Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor_bulk(rows)

    assert exc_info.value.code == "batch_too_large"


def test_anchor_bulk_accepts_exactly_max_rows_boundary() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "batch_id": None,
                "validated": BULK_ANCHOR_MAX_ROWS,
                "queued": BULK_ANCHOR_MAX_ROWS,
                "duplicates": [],
                "errors": [],
                "dry_run": False,
                "anchors": [],
            },
            status_code=201,
        )

    rows = [BulkAnchorInput(fingerprint="a" * 64) for _ in range(BULK_ANCHOR_MAX_ROWS)]
    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.anchor_bulk(rows)

    assert result.validated == BULK_ANCHOR_MAX_ROWS


def test_anchor_bulk_sends_snake_case_fields_and_options() -> None:
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        return json_response(
            {
                "batch_id": "batch-1",
                "validated": 1,
                "queued": 1,
                "duplicates": [],
                "errors": [],
                "dry_run": False,
                "anchors": [
                    {
                        "public_id": "ARK-2026-100",
                        "fingerprint": "a" * 64,
                        "status": "PENDING",
                        "original_document_date": "2025-01-01T00:00:00Z",
                        "document_type": "contract",
                        "matter_or_case_ref": "CASE-1",
                        "external_id": "ext-1",
                        "anchored_at": "2026-01-01T00:00:00Z",
                    }
                ],
            },
            status_code=201,
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.anchor_bulk(
            [
                BulkAnchorInput(
                    fingerprint="a" * 64,
                    credential_type="CONTRACT_PRESIGNING",
                    description="signed NDA",
                    original_document_date="2025-01-01T00:00:00Z",
                    document_type="contract",
                    matter_or_case_ref="CASE-1",
                    external_id="ext-1",
                )
            ],
            batch_id="batch-1",
            duplicate_strategy="skip",
        )

    assert result.batch_id == "batch-1"
    assert result.queued == 1
    assert result.anchors is not None
    assert result.anchors[0].public_id == "ARK-2026-100"
    assert result.anchors[0].matter_or_case_ref == "CASE-1"

    assert len(seen_requests) == 1
    req = seen_requests[0]
    assert req.url.path == "/v1/anchor/bulk"
    body = json.loads(req.content)
    assert body == {
        "anchors": [
            {
                "fingerprint": "a" * 64,
                "credential_type": "CONTRACT_PRESIGNING",
                "description": "signed NDA",
                "original_document_date": "2025-01-01T00:00:00Z",
                "document_type": "contract",
                "matter_or_case_ref": "CASE-1",
                "external_id": "ext-1",
            }
        ],
        "duplicate_strategy": "skip",
        "batch_id": "batch-1",
    }


def test_anchor_bulk_mixed_fingerprint_and_data_rows() -> None:
    seen_requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_requests.append(request)
        return json_response(
            {
                "batch_id": None,
                "validated": 2,
                "queued": 2,
                "duplicates": [],
                "errors": [],
                "dry_run": False,
                "anchors": [],
            },
            status_code=201,
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        expected_fp = client.fingerprint("second document")
        client.anchor_bulk(
            [
                BulkAnchorInput(fingerprint="b" * 64),
                BulkAnchorInput(data="second document"),
            ]
        )

    body = json.loads(seen_requests[0].content)
    assert len(body["anchors"]) == 2
    assert body["anchors"][0]["fingerprint"] == "b" * 64
    assert body["anchors"][1]["fingerprint"] == expected_fp
    assert b"second document" not in seen_requests[0].content


def test_anchor_bulk_row_rejects_neither_fingerprint_nor_data_without_network_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    with (
        Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor_bulk([BulkAnchorInput()])

    assert exc_info.value.code == "invalid_request"


def test_anchor_bulk_row_rejects_both_fingerprint_and_data_without_network_call() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    with (
        Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor_bulk([BulkAnchorInput(fingerprint="a" * 64, data="x")])

    assert exc_info.value.code == "invalid_request"


def test_anchor_bulk_dry_run_surfaces_duplicates_without_inserting() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["dry_run"] is True
        return json_response(
            {
                "batch_id": None,
                "validated": 3,
                "queued": 2,
                "duplicates": [
                    {"row": 1, "fingerprint": "c" * 64, "scope": "in_batch", "decision": "skip"}
                ],
                "errors": [],
                "dry_run": True,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.anchor_bulk(
            [
                BulkAnchorInput(fingerprint="a" * 64),
                BulkAnchorInput(fingerprint="c" * 64),
                BulkAnchorInput(fingerprint="c" * 64),
            ],
            dry_run=True,
            duplicate_strategy="skip",
        )

    assert result.dry_run is True
    assert result.queued == 2
    assert result.duplicates[0].row == 1
    assert result.duplicates[0].scope == "in_batch"
    assert result.anchors is None


def test_anchor_bulk_surfaces_per_row_errors_on_partial_success() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "batch_id": None,
                "validated": 2,
                "queued": 1,
                "duplicates": [],
                "errors": [{"row": 1, "code": "insert_failed", "message": "Failed to create anchor record."}],
                "dry_run": False,
                "anchors": [
                    {
                        "public_id": "ARK-2026-200",
                        "fingerprint": "a" * 64,
                        "status": "PENDING",
                        "original_document_date": None,
                        "document_type": None,
                        "matter_or_case_ref": None,
                        "external_id": None,
                        "anchored_at": "2026-01-01T00:00:00Z",
                    }
                ],
            },
            status_code=201,
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.anchor_bulk(
            [BulkAnchorInput(fingerprint="a" * 64), BulkAnchorInput(fingerprint="b" * 64)]
        )

    assert result.queued == 1
    assert result.errors[0].row == 1
    assert result.errors[0].code == "insert_failed"
    assert result.anchors is not None
    assert len(result.anchors) == 1


def test_anchor_bulk_409_duplicate_fail_preserves_code_and_status() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "error": "duplicate_fingerprints",
                "message": (
                    'Batch contains 1 duplicate fingerprint(s); pick a duplicate_strategy '
                    'other than "fail" to proceed.'
                ),
                "duplicates": [{"row": 1, "fingerprint": "a" * 64, "scope": "in_db", "decision": "fail"}],
            },
            status_code=409,
        )

    with (
        Arkova(api_key="ak_test", retries=0, transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor_bulk([BulkAnchorInput(fingerprint="a" * 64), BulkAnchorInput(fingerprint="a" * 64)])

    assert exc_info.value.status_code == 409
    assert exc_info.value.code == "duplicate_fingerprints"


def test_anchor_bulk_402_insufficient_credits_preserves_code_and_status() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {"error": "insufficient_credits", "balance": 0, "required": 5, "message": "Not enough credits."},
            status_code=402,
        )

    with (
        Arkova(api_key="ak_test", retries=0, transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError) as exc_info,
    ):
        client.anchor_bulk([BulkAnchorInput(fingerprint="a" * 64) for _ in range(5)])

    assert exc_info.value.status_code == 402
    assert exc_info.value.code == "insufficient_credits"


def test_async_anchor_and_anchor_bulk_wire_to_correct_paths_with_bearer_auth() -> None:
    async def run() -> tuple[str, str, list[str]]:
        seen_paths: list[str] = []
        seen_auth: list[str | None] = []

        def anchor_handler(request: httpx.Request) -> httpx.Response:
            seen_paths.append(request.url.path)
            seen_auth.append(request.headers.get("authorization"))
            return json_response(
                {
                    "public_id": "ARK-2026-ASYNC",
                    "fingerprint": "a" * 64,
                    "status": "PENDING",
                    "created_at": "2026-01-01T00:00:00Z",
                    "record_uri": "https://app.arkova.ai/verify/ARK-2026-ASYNC",
                },
                status_code=201,
            )

        async with AsyncArkova(
            api_key="ak_test", transport=httpx.MockTransport(anchor_handler)
        ) as client:
            receipt = await client.anchor(fingerprint="a" * 64)
            public_id = receipt.public_id

        bulk_paths: list[str] = []

        def bulk_handler(request: httpx.Request) -> httpx.Response:
            bulk_paths.append(request.url.path)
            return json_response(
                {
                    "batch_id": None,
                    "validated": 1,
                    "queued": 1,
                    "duplicates": [],
                    "errors": [],
                    "dry_run": False,
                    "anchors": [],
                },
                status_code=201,
            )

        async with AsyncArkova(
            api_key="ak_test", transport=httpx.MockTransport(bulk_handler)
        ) as client:
            bulk_result = await client.anchor_bulk([BulkAnchorInput(fingerprint="b" * 64)])

        return public_id, bulk_result.dry_run and "dry" or "not-dry", seen_paths + bulk_paths

    public_id, dry_marker, paths = asyncio.run(run())
    assert public_id == "ARK-2026-ASYNC"
    assert dry_marker == "not-dry"
    assert paths == ["/v1/anchor", "/v1/anchor/bulk"]


def test_async_anchor_bulk_empty_input_no_network_call() -> None:
    async def run() -> int:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("no network call expected")

        async with AsyncArkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
            result = await client.anchor_bulk([])
            return result.queued

    assert asyncio.run(run()) == 0


# ---------------------------------------------------------------------------
# BUG-2026-08-12-007 — `compliance_controls` is a LIST, not a dict.
#
# Published PyPI `arkova` 2.2.0 (tag `arkova-py-v2.2.0`, commit 8818d3af3) types
# `RichVerificationFields.compliance_controls` as `dict[str, Any] | None`. The
# API has only ever emitted a JSON ARRAY of control-ID strings, so `verify()` —
# the headline method — raised pydantic's "Input should be a valid dictionary"
# on every record that actually carries controls. Records with no controls
# parsed fine, which is why it survived the whole life of the release.
#
# The source fix landed 2026-08-01 in a1592b975, FOUR HOURS after that tag was
# cut, and was never republished — so the defect exists only in the published
# artifact. These tests are the ratchet: they pin the wire contract so source
# and artifact cannot drift apart again silently.
#
# Every shape below is taken from the API source, not invented:
#   * services/worker/src/api/v1/verify.ts          — buildVerificationResult
#   * services/worker/src/api/v1/docs.ts            — OpenAPI: array of string
#   * services/worker/src/utils/complianceMapping.ts — COMPLIANCE_CONTROLS_NOTE,
#     UNIVERSAL_CONTROLS + TYPE_SPECIFIC_CONTROLS.LEGAL, and
#     sanitizeStoredComplianceControls (returns `string[] | null`, never an object)
#   * services/worker/src/constants/proofAvailability.ts — the note pair
# ---------------------------------------------------------------------------

# Verbatim from services/worker/src/utils/complianceMapping.ts.
COMPLIANCE_CONTROLS_NOTE = (
    "Compliance control identifiers are informational metadata only. They indicate "
    "which regulatory controls Arkova maps to this record's credential type. They are "
    "not an audit, certification, conformity assessment, or attestation that this "
    "record, its issuer, or Arkova satisfies any listed control, framework, or "
    "regulation. In particular, no identifier listed here asserts a qualified trust "
    "service, qualified electronic signature, or qualified electronic seal under "
    "eIDAS. Compliance determination remains the responsibility of the relying party "
    "and its auditors."
)

# UNIVERSAL_CONTROLS + TYPE_SPECIFIC_CONTROLS.LEGAL, deduped in insertion order
# exactly as getComplianceControlIds() builds the set.
LEGAL_COMPLIANCE_CONTROLS = [
    "SOC2-CC6.1",
    "SOC2-CC6.7",
    "GDPR-5.1f",
    "GDPR-25",
    "ISO27001-A.10",
    "eIDAS-25",
    "eIDAS-35",
    "ISO27001-A.14",
    "LGPD-33",
    "PDPA-26",
    "LFPDPPP-36",
]

# Verbatim from services/worker/src/constants/proofAvailability.ts
# (PROOF_AVAILABILITY_NOTE.root_only — the class the overwhelming majority of
# prod anchors carry: ~2.97M SECURED, only ~6,110 with a stored branch).
ROOT_ONLY_NOTE = (
    "Measured: Arkova does not store a per-document inclusion proof for this "
    "record. "
    "Asserted: the document fingerprint shown here was committed to the Bitcoin "
    "network in the referenced anchor receipt at the recorded time. "
    "Not asserted: that a self-contained per-document proof bundle is available "
    "from Arkova for offline verification of this record. Verifying this record "
    "requires retrieving the referenced anchor receipt from the network. The "
    "absence of a stored per-document proof is not evidence that the record is "
    "invalid, and says nothing about the accuracy or legal effect of the "
    "underlying document."
)


def prod_shaped_legal_verification() -> dict:
    """The wire body `GET /api/v1/verify/ARK-2026-C3A718D0` returns.

    An ACTIVE `credential_type=LEGAL` record — the reproduction case for
    BUG-2026-08-12-007. Field set and omissions follow buildVerificationResult:
    `compliance_controls` is a non-empty array, `compliance_controls_note` rides
    with it, `version_number` is omitted (it equals 1), `ferpa_notice` is omitted
    (LEGAL is not a FERPA education type), `sub_type`/`parent_public_id` are
    omitted (null values are skipped, never serialised as null), and the proof
    pair is present because the branch question was measured on a settled status
    that carries a chain receipt.

    Values other than `public_id` and `credential_type` are synthetic: this file
    ships in the PyPI sdist, so the fixture carries no real issuer identity and
    no recipient field. `public_id` is kept verbatim because it is the documented
    reproduction case, and a public id is the one identifier this system is
    designed to expose (CLAUDE.md §6).
    """
    return {
        "verified": True,
        "status": "ACTIVE",
        "issuer_name": "Example Legal Services LLP",
        "credential_type": "LEGAL",
        "issued_date": "2026-03-11",
        "expiry_date": None,
        "anchor_timestamp": "2026-03-11T18:22:41.000Z",
        "bitcoin_block": 901_447,
        "network_receipt_id": (
            "3c1f9a7e2b6d48f0a5c3e9b17d24f8a0c6e5b3d1f9a72e4c8b06d5a1f3e7c9b24"
        ),
        "merkle_proof_hash": None,
        "record_uri": "https://app.arkova.ai/verify/ARK-2026-C3A718D0",
        "jurisdiction": "KE",
        "explorer_url": (
            "https://mempool.space/tx/"
            "3c1f9a7e2b6d48f0a5c3e9b17d24f8a0c6e5b3d1f9a72e4c8b06d5a1f3e7c9b24"
        ),
        "compliance_controls": LEGAL_COMPLIANCE_CONTROLS,
        "compliance_controls_note": COMPLIANCE_CONTROLS_NOTE,
        "chain_confirmations": 412,
        "file_mime": "application/pdf",
        "file_size": 184_320,
        "confidence_scores": {"overall": 0.94, "fields": {"issuerName": 0.97}},
        "fingerprint_source": "document_bytes",
        "proof_availability": "root_only",
        "proof_availability_note": ROOT_ONLY_NOTE,
    }


def verifying_client(payload: dict) -> Arkova:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(payload)

    return Arkova(api_key="ak_test", transport=httpx.MockTransport(handler))


def test_verify_parses_a_prod_shaped_record_carrying_compliance_controls() -> None:
    """The headline regression: `verify()` must not raise on a real record.

    On published 2.2.0 this fails with `1 validation error for
    VerificationResult / compliance_controls / Input should be a valid dictionary`.
    """
    with verifying_client(prod_shaped_legal_verification()) as client:
        result = client.verify("ARK-2026-C3A718D0")

    assert result.verified is True
    assert result.credential_type == "LEGAL"
    assert result.compliance_controls == LEGAL_COMPLIANCE_CONTROLS
    # A control list must never arrive without the statement of what it does NOT
    # assert (§1.5 / R-7). The API emits the pair together; the SDK surfaces both.
    assert result.compliance_controls_note == COMPLIANCE_CONTROLS_NOTE


def test_compliance_controls_is_declared_as_a_list_of_strings() -> None:
    """Pin the annotation itself, not just one round-trip.

    A test that only parses a list payload would still pass if someone widened
    the field to `Any` — which accepts everything and types nothing. This is the
    ratchet that makes a revert to the dict form, or a silent widening, fail.
    """
    assert RichVerificationFields.model_fields["compliance_controls"].annotation == (
        list[str] | None
    )

    # Same inherited field on every model that mirrors this response — the drift
    # hit all three at once, so the ratchet covers all three.
    for model in (VerificationResult, FingerprintVerification, Anchor):
        assert model.model_fields["compliance_controls"].annotation == (list[str] | None)
        assert model.model_fields["compliance_controls_note"].annotation == (str | None)


def test_dict_shaped_compliance_controls_is_rejected() -> None:
    """The dict form is not merely unused — it is unrepresentable on the wire.

    `sanitizeStoredComplianceControls` fails a non-array stored value CLOSED to
    `null` before it can reach a response, so an object arriving here means the
    payload did not come from this API. Quietly accepting it would re-open the
    very ambiguity this bug came from.

    Also pins how a shape mismatch SURFACES, which is half of why this bug was
    hard to spot: `_parse_json` converts the pydantic error into a generic
    `ArkovaError("Arkova API returned an unexpected response shape")`. The field
    that actually failed is only visible on `__cause__`, so a caller reading the
    top-level message alone learns nothing about which field drifted.
    """
    payload = prod_shaped_legal_verification()
    payload["compliance_controls"] = {"SOC2-CC6.1": True}

    with verifying_client(payload) as client, pytest.raises(ArkovaError) as excinfo:
        client.verify("ARK-2026-C3A718D0")

    cause = excinfo.value.__cause__
    assert isinstance(cause, ValidationError)
    assert "compliance_controls" in str(cause)


def test_verify_still_parses_records_with_no_compliance_controls() -> None:
    """The path that always worked must keep working.

    This is why the bug survived a release. `buildVerificationResult` OMITS the
    key whenever the sanitized value is null/empty, and withholds it entirely for
    any record that is not a current anchored credential (REVOKED / EXPIRED /
    SUPERSEDED / not yet anchored — BUG-2026-06-24-007). Most payloads therefore
    never exercised the broken branch.
    """
    payload = prod_shaped_legal_verification()
    del payload["compliance_controls"]
    del payload["compliance_controls_note"]

    with verifying_client(payload) as client:
        result = client.verify("ARK-2026-C3A718D0")

    assert result.verified is True
    assert result.compliance_controls is None
    assert result.compliance_controls_note is None


def test_verify_tolerates_an_explicit_null_compliance_controls() -> None:
    """Belt-and-braces around the omitted case.

    `/api/v1/verify` omits rather than nulls this key, but it is declared
    `nullable: true` in the published OpenAPI schema and sibling worker surfaces
    carry it as `null` internally (`EMPTY_API_RICH_FIELDS`). A client that fell
    over on an explicit null would be brittle for no benefit.
    """
    payload = prod_shaped_legal_verification()
    payload["compliance_controls"] = None
    payload["compliance_controls_note"] = None

    with verifying_client(payload) as client:
        result = client.verify("ARK-2026-C3A718D0")

    assert result.compliance_controls is None


def test_verify_types_the_proof_and_fingerprint_evidence_fields() -> None:
    """Same stale-snapshot drift class, found by the same audit.

    `fingerprint_source` (R19) and the `proof_availability` / `_note` pair
    (SCRUM-2575) are emitted by `buildVerificationResult` but were absent from
    the model. `extra="allow"` meant they parsed, so nothing broke — they were
    simply invisible to type checkers, IDE completion and `model_fields`.

    Typed as plain `str`, deliberately NOT `Literal`: over-narrow typing built
    from an API snapshot is exactly what caused BUG-2026-08-12-007, and a future
    member of either enum must not raise inside a consumer's `verify()` call.
    """
    for name in ("fingerprint_source", "proof_availability", "proof_availability_note"):
        assert name in VerificationResult.model_fields, f"{name} must be a declared field"
        assert VerificationResult.model_fields[name].annotation == (str | None)

    with verifying_client(prod_shaped_legal_verification()) as client:
        result = client.verify("ARK-2026-C3A718D0")

    assert result.fingerprint_source == "document_bytes"
    assert result.proof_availability == "root_only"
    assert result.proof_availability_note == ROOT_ONLY_NOTE


# ── Model ↔ emitter parity (BUG-2026-08-12-007 follow-up) ────────────────
#
# Every key set below is transcribed from the worker code that BUILDS the
# response, not from a captured sample payload. A sample only proves what one
# record happened to contain on one day; the emitter proves what the endpoint
# can ever emit. Sample-derived modelling is precisely what put `chain_tx_id`,
# `issuer_name`, `industry_tag`, `org_type`, `location`, `logo_url` and
# `field` into this SDK as fields that could only ever read `None`.
#
# These sets are a ratchet: if a route starts emitting a new key, the parity
# test fails and the model gets updated in the same change — rather than the
# key sitting in `model_extra` untyped and undiscoverable, which is how the
# fields corrected in 2.2.1 stayed invisible for a full release.

# services/worker/src/api/v1/anchor-submit.ts — `interface AnchorReceipt`.
# BOTH emit sites (the idempotent duplicate hit at 200 and the fresh insert at
# 201) build this same object literal with no conditional key.
ANCHOR_RECEIPT_EMITTED_KEYS = frozenset(
    {"public_id", "fingerprint", "status", "created_at", "record_uri"}
)

# services/worker/src/api/v2/resourceDetails.ts — `mapAnchorDetail()`. One
# return literal, shared by /records/{id}, /fingerprints/{fp} and
# /documents/{id}. `metadata` is the ONLY key that can be absent: `safeMetadata`
# returns `undefined` when no SAFE_METADATA_KEYS survived filtering, and an
# `undefined` value drops the key from the JSON entirely.
MAP_ANCHOR_DETAIL_EMITTED_KEYS = frozenset(
    {
        "type",
        "public_id",
        "verified",
        "status",
        "title",
        "description",
        "credential_type",
        "sub_type",
        "fingerprint",
        "issued_date",
        "expiry_date",
        "anchor_timestamp",
        "network_receipt_id",
        "record_uri",
        "metadata",
    }
)

# resourceDetails.ts — GET /api/v2/organizations/{public_id}. The handler does
# not spread the row; it names six keys explicitly in its `res.json({...})`.
ORGANIZATION_DETAIL_EMITTED_KEYS = frozenset(
    {
        "public_id",
        "display_name",
        "description",
        "domain",
        "website_url",
        "verification_status",
    }
)

# services/worker/src/api/v1/anchor-bulk.ts — the only two `errors.push()`
# sites in the file. The worker's `RowError` interface declares `field?: string`
# but nothing ever assigns it, so it never reaches the wire.
BULK_ROW_ERROR_EMITTED_KEYS = frozenset({"row", "code", "message"})
BULK_ROW_ERROR_EMITTED_CODES = ("insert_failed", "unexpected_error")


def map_anchor_detail_payload(
    detail_type: str,
    *,
    metadata: dict | None = None,
) -> dict:
    """Reproduce `mapAnchorDetail()` output for one anchor row.

    `status` is `ACTIVE`, not `SECURED`: `normalizeAnchorStatus()` rewrites
    `SECURED` on the way out, so `SECURED` never appears on this route.
    """
    payload: dict = {
        "type": detail_type,
        "public_id": "ARK-2026-C3A718D0",
        "verified": True,
        "status": "ACTIVE",
        "title": "engagement-letter.pdf",
        "description": "Signed engagement letter",
        "credential_type": "LEGAL",
        "sub_type": None,
        "fingerprint": "a" * 64,
        "issued_date": "2026-01-05T00:00:00Z",
        "expiry_date": None,
        "anchor_timestamp": "2026-01-06T12:00:00Z",
        "network_receipt_id": "9f" * 32,
        "record_uri": "https://app.arkova.ai/verify/ARK-2026-C3A718D0",
    }
    if metadata is not None:
        payload["metadata"] = metadata
    return payload


def detail_client(payload: dict) -> Arkova:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(payload)

    return Arkova(api_key="ak_test", transport=httpx.MockTransport(handler))


def test_anchor_receipt_declares_exactly_what_the_endpoint_emits() -> None:
    """`POST /api/v1/anchor` emits five keys; the model must declare those five.

    `chain_tx_id` was never one of them. An anchor is `PENDING` at creation and
    has no chain transaction yet by definition — the receipt is issued before
    any batch drain runs, so there is no value the endpoint could put there.
    """
    assert set(AnchorReceipt.model_fields) == ANCHOR_RECEIPT_EMITTED_KEYS


def test_anchor_receipt_exposes_the_record_uri_every_response_carries() -> None:
    """`record_uri` is the caller's link to the verification page.

    It was absent from the model, so it landed in `model_extra`: invisible to
    type checkers and IDE completion, and absent from `model_dump()` round
    trips through the declared schema. Callers had to rebuild the URL by hand.
    """
    payload = {
        "public_id": "ARK-2026-C3A718D0",
        "fingerprint": "a" * 64,
        "status": "PENDING",
        "created_at": "2026-01-06T12:00:00Z",
        "record_uri": "https://app.arkova.ai/verify/ARK-2026-C3A718D0",
    }

    assert "record_uri" in AnchorReceipt.model_fields, "must be declared, not a pydantic extra"

    receipt = AnchorReceipt.model_validate(payload)

    assert receipt.record_uri == "https://app.arkova.ai/verify/ARK-2026-C3A718D0"
    assert "record_uri" not in (receipt.model_extra or {})


def test_anchor_receipt_status_is_not_narrowed_to_a_literal() -> None:
    """`status` stays `str` even though the endpoint only ever sends `PENDING`.

    Same reasoning as `fingerprint_source` / `proof_availability` in 2.2.1:
    a `Literal["PENDING"]` would be an API snapshot promoted to a hard
    constraint, and the day the endpoint gains a status it would raise inside
    `anchor()` rather than surface the new value.
    """
    receipt = AnchorReceipt.model_validate(
        {
            "public_id": "ARK-2026-C3A718D0",
            "fingerprint": "a" * 64,
            "status": "SOME_FUTURE_STATUS",
            "created_at": "2026-01-06T12:00:00Z",
            "record_uri": "https://app.arkova.ai/verify/ARK-2026-C3A718D0",
        }
    )

    assert receipt.status == "SOME_FUTURE_STATUS"


@pytest.mark.parametrize(
    "model",
    [RecordDetail, FingerprintDetail, DocumentDetail],
)
def test_detail_models_declare_exactly_what_map_anchor_detail_emits(model: type) -> None:
    """All three v2 detail routes share one mapper, so they share one key set.

    `issuer_name` is not in it. `mapAnchorDetail` has no such key — issuer
    reaches the client through `metadata["issuer"]` instead (see below).
    """
    assert set(model.model_fields) == MAP_ANCHOR_DETAIL_EMITTED_KEYS


@pytest.mark.parametrize(
    ("detail_type", "getter"),
    [
        ("record", "get_record"),
        ("fingerprint", "get_fingerprint"),
        ("document", "get_document"),
    ],
)
def test_detail_routes_surface_the_type_discriminator(detail_type: str, getter: str) -> None:
    """`type` is emitted unconditionally and identifies which route answered.

    It is the one field that distinguishes the three otherwise-identical
    payloads, and it was not declared — so the discriminator was unusable
    without reaching into `model_extra`.
    """
    payload = map_anchor_detail_payload(detail_type)
    lookup = "a" * 64 if detail_type == "fingerprint" else "ARK-2026-C3A718D0"

    with detail_client(payload) as client:
        detail = getattr(client, getter)(lookup)

    assert "type" in type(detail).model_fields, "must be declared, not a pydantic extra"
    assert detail.type == detail_type
    assert "type" not in (detail.model_extra or {})
    assert detail.public_id == "ARK-2026-C3A718D0"
    assert detail.record_uri == "https://app.arkova.ai/verify/ARK-2026-C3A718D0"


def test_detail_metadata_is_declared_and_carries_the_issuer() -> None:
    """`metadata` is the replacement path for the phantom `issuer_name`.

    `safeMetadata()` allow-lists ten keys (SAFE_METADATA_KEYS), `issuer` among
    them. So issuer data was reaching Python consumers all along — just not
    where the model told them to look.
    """
    payload = map_anchor_detail_payload(
        "record",
        metadata={"issuer": "Example Legal Services LLP", "jurisdiction": "US-NY"},
    )

    with detail_client(payload) as client:
        detail = client.get_record("ARK-2026-C3A718D0")

    assert detail.metadata == {"issuer": "Example Legal Services LLP", "jurisdiction": "US-NY"}


def test_detail_metadata_is_none_when_the_worker_omits_it() -> None:
    """`safeMetadata()` returns `undefined` for an empty result, dropping the key.

    So absent-means-empty, and the model must tolerate the key being missing
    rather than requiring it.
    """
    payload = map_anchor_detail_payload("document")
    assert "metadata" not in payload

    with detail_client(payload) as client:
        detail = client.get_document("ARK-2026-C3A718D0")

    assert detail.metadata is None


def test_organization_detail_declares_exactly_the_six_emitted_keys() -> None:
    """The v2 org-detail handler names six keys explicitly.

    `industry_tag`, `org_type`, `location` and `logo_url` are not among them
    and are not selected from the `organizations` row either, so no code path
    could ever have populated them.
    """
    assert set(OrganizationDetail.model_fields) == ORGANIZATION_DETAIL_EMITTED_KEYS


def test_organization_detail_round_trips_the_route_payload() -> None:
    payload = {
        "public_id": "ORG-2026-4F2A",
        "display_name": "Example Legal Services LLP",
        "description": "Commercial litigation practice",
        "domain": "example-legal.test",
        "website_url": "https://example-legal.test",
        "verification_status": "VERIFIED",
    }

    with detail_client(payload) as client:
        org = client.get_organization("ORG-2026-4F2A")

    assert org.display_name == "Example Legal Services LLP"
    assert org.verification_status == "VERIFIED"
    assert org.model_dump() == payload


def test_bulk_row_error_declares_exactly_what_the_worker_pushes() -> None:
    """`field` is declared on the worker's `RowError` interface but never set.

    Both `errors.push()` sites pass `{row, code, message}`. Row-level schema
    failures never reach this array at all — a bad row fails Zod validation for
    the WHOLE request and returns a 400 with a `details[]` list instead, which
    is a different shape on a different response.
    """
    assert set(BulkAnchorRowError.model_fields) == BULK_ROW_ERROR_EMITTED_KEYS


@pytest.mark.parametrize("code", BULK_ROW_ERROR_EMITTED_CODES)
def test_bulk_row_error_parses_both_emitted_codes(code: str) -> None:
    error = BulkAnchorRowError.model_validate(
        {"row": 3, "code": code, "message": "Failed to create anchor record."}
    )

    assert error.row == 3
    assert error.code == code


def test_bulk_row_error_code_is_not_narrowed_to_a_literal() -> None:
    """Only two codes are emitted today, and `code` still stays `str`.

    The two known values are documented on the model rather than enforced by
    it, for the same reason `status` above is not a `Literal`.
    """
    error = BulkAnchorRowError.model_validate(
        {"row": 1, "code": "some_future_code", "message": "..."}
    )

    assert error.code == "some_future_code"


@pytest.mark.parametrize(
    ("model", "removed"),
    [
        (AnchorReceipt, "chain_tx_id"),
        (RecordDetail, "issuer_name"),
        (FingerprintDetail, "issuer_name"),
        (DocumentDetail, "issuer_name"),
        (OrganizationDetail, "industry_tag"),
        (OrganizationDetail, "org_type"),
        (OrganizationDetail, "location"),
        (OrganizationDetail, "logo_url"),
        (BulkAnchorRowError, "field"),
    ],
)
def test_phantom_fields_are_gone(model: type, removed: str) -> None:
    """Explicit ratchet against re-adding a field no endpoint emits.

    Each of these was declared, defaulted to `None`, and had no code path on
    the worker that could ever set it. `extra="allow"` means removal costs
    nothing if an endpoint later starts sending one: it would arrive as an
    extra and still be readable, and the parity tests above would fail and
    prompt a proper typed declaration.
    """
    assert removed not in model.model_fields


def test_search_result_score_is_a_constant_not_a_relevance_signal() -> None:
    """All four v2 search mappers hardcode `score: 1.0`.

    org / record / fingerprint / document each build `score: 1.0` literally;
    there is no ranking function anywhere in `services/worker/src/api/v2/
    search.ts`. The field is part of the frozen v2 response shape (§1.8) so
    the SDK keeps it, but sorting or thresholding on it is meaningless — every
    result ties. Ordering comes from the query's own `.order()` clause.

    Documented, deliberately not "fixed": the SDK cannot invent a relevance
    signal the API does not compute, and dropping a frozen field would be the
    breaking change.
    """
    results = [
        SearchResult.model_validate(
            {"type": result_type, "public_id": f"ARK-{result_type}", "score": 1.0, "snippet": ""}
        )
        for result_type in ("org", "record", "fingerprint", "document")
    ]

    assert {result.score for result in results} == {1.0}
