from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from arkova import (
    BULK_ANCHOR_MAX_ROWS,
    Anchor,
    Arkova,
    ArkovaError,
    AsyncArkova,
    BulkAnchorInput,
    FingerprintVerification,
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
                "compliance_controls": {"SOC2-CC6.1": True},
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
    assert result.compliance_controls == {"SOC2-CC6.1": True}
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
                "compliance_controls": {"FERPA-99.31": True},
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
    assert result.compliance_controls == {"FERPA-99.31": True}
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
            },
            status_code=201,
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        receipt = client.anchor(fingerprint="a" * 64)

    assert receipt.public_id == "ARK-2026-001"
    assert receipt.status == "PENDING"
    assert receipt.chain_tx_id is None
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
