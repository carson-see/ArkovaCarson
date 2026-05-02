from __future__ import annotations

import asyncio

import httpx
import pytest

from arkova import Anchor, Arkova, ArkovaError, AsyncArkova, FingerprintVerification


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
                        "id": "rec_1",
                        "public_id": "ARK-DOC-ABC",
                        "score": 1.0,
                        "snippet": "Nursing license",
                    }
                ],
                "next_cursor": None,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.search("nurse", type="record")

    assert seen_headers == ["Bearer ak_test"]
    assert result.results[0].public_id == "ARK-DOC-ABC"


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

    with pytest.raises(ArkovaError) as exc_info:
        with Arkova(api_key="ak_test", retries=0, transport=transport) as client:
            client.list_orgs()

    assert exc_info.value.status_code == 429
    assert exc_info.value.retry_after == 42
    assert exc_info.value.problem is not None
    assert exc_info.value.problem.type.endswith("/rate-limited")


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
    async def run() -> str | None:
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
            return result.confidence_scores["overall"] if result.confidence_scores else None

    assert asyncio.run(run()) == pytest.approx(0.81)
