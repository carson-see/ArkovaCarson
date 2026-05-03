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
                        "id": "internal-search-id",
                        "type": "record",
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
    assert "id" not in result.results[0].model_dump()


def test_list_orgs_does_not_require_internal_id() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "organizations": [
                    {
                        "id": "internal-org-id",
                        "public_id": "org_acme",
                        "display_name": "Acme Corp",
                        "domain": "acme.com",
                        "website_url": "https://acme.com",
                        "verification_status": "VERIFIED",
                    }
                ]
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.list_orgs()

    assert result.organizations[0].public_id == "org_acme"
    assert result.organizations[0].display_name == "Acme Corp"
    assert not hasattr(result.organizations[0], "id")
    assert "id" not in result.organizations[0].model_dump()


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


def test_verify_fingerprint_maps_rich_fields() -> None:
    assert "confidence_scores" in FingerprintVerification.model_fields
    assert "sub_type" in FingerprintVerification.model_fields

    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "verified": True,
                "status": "ACTIVE",
                "id": "internal-anchor-id",
                "org_id": "internal-org-id",
                "user_id": "internal-user-id",
                "fingerprint": "a" * 64,
                "public_id": "ARK-DOC-RICH",
                "issuer_name": "University of Michigan",
                "credential_type": "DEGREE",
                "sub_type": "Bachelor of Science",
                "description": "BS Computer Science, awarded May 2025.",
                "compliance_controls": {
                    "ferpa": True,
                    "retention_policy": "student-records-v1",
                },
                "chain_confirmations": 6,
                "parent_public_id": "ARK-DOC-PARENT",
                "version_number": 2,
                "revocation_tx_id": None,
                "revocation_block_height": None,
                "file_mime": "application/pdf",
                "file_size": 48123,
                "confidence_scores": {
                    "issuer_name": 0.99,
                    "credential_type": 0.97,
                },
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.verify_fingerprint("a" * 64)

    assert result.sub_type == "Bachelor of Science"
    assert result.description == "BS Computer Science, awarded May 2025."
    assert result.compliance_controls == {
        "ferpa": True,
        "retention_policy": "student-records-v1",
    }
    assert result.chain_confirmations == 6
    assert result.parent_public_id == "ARK-DOC-PARENT"
    assert result.version_number == 2
    assert result.revocation_tx_id is None
    assert result.revocation_block_height is None
    assert result.file_mime == "application/pdf"
    assert result.file_size == 48123
    assert result.confidence_scores == {
        "issuer_name": 0.99,
        "credential_type": 0.97,
    }
    assert "id" not in result.model_dump()
    assert "org_id" not in result.model_dump()
    assert "user_id" not in result.model_dump()


def test_get_anchor_maps_rich_fields() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "public_id": "ARK-DOC-RICH",
                "verified": True,
                "status": "ACTIVE",
                "id": "internal-anchor-id",
                "org_id": "internal-org-id",
                "user_id": "internal-user-id",
                "record_uri": "https://app.arkova.ai/verify/ARK-DOC-RICH",
                "issuer_name": "University of Michigan",
                "credential_type": "DEGREE",
                "sub_type": "Bachelor of Science",
                "description": "BS Computer Science, awarded May 2025.",
                "chain_confirmations": 6,
                "version_number": 2,
                "confidence_scores": {"issuer_name": 0.99},
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        result = client.get_anchor("ARK-DOC-RICH")

    assert result.sub_type == "Bachelor of Science"
    assert result.description == "BS Computer Science, awarded May 2025."
    assert result.chain_confirmations == 6
    assert result.version_number == 2
    assert result.confidence_scores == {"issuer_name": 0.99}
    assert "id" not in result.model_dump()
    assert "org_id" not in result.model_dump()
    assert "user_id" not in result.model_dump()


def test_v2_resource_detail_methods_map_public_shapes() -> None:
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path.endswith("/organizations/org_acme"):
            return json_response(
                {
                    "id": "internal-org-id",
                    "public_id": "org_acme",
                    "display_name": "Acme Corp",
                    "description": "Verified healthcare org",
                    "domain": "acme.com",
                    "website_url": "https://acme.com",
                    "verification_status": "VERIFIED",
                    "industry_tag": "healthcare",
                    "org_type": "employer",
                    "location": "Detroit, MI",
                    "logo_url": None,
                }
            )
        if request.url.path.endswith("/records/ARK-DOC-ABC"):
            return json_response(
                {
                    "id": "internal-anchor-id",
                    "org_id": "internal-org-id",
                    "user_id": "internal-user-id",
                    "public_id": "ARK-DOC-ABC",
                    "verified": True,
                    "status": "ACTIVE",
                    "fingerprint": "a" * 64,
                    "title": "Contract.pdf",
                    "description": "Signed agreement",
                    "issuer_name": "Acme Corp",
                    "credential_type": "LEGAL",
                    "sub_type": "contract",
                    "issued_date": "2026-04-01",
                    "expiry_date": None,
                    "anchor_timestamp": "2026-04-24T12:00:00Z",
                    "network_receipt_id": "tx-1",
                    "record_uri": "https://app.arkova.ai/verify/ARK-DOC-ABC",
                    "compliance_controls": {"soc2": True},
                    "chain_confirmations": 6,
                    "parent_public_id": None,
                    "version_number": 2,
                    "revocation_tx_id": None,
                    "revocation_block_height": None,
                }
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        org = client.get_organization("org_acme")
        record = client.get_record("ARK-DOC-ABC")

    assert seen_paths == ["/v2/organizations/org_acme", "/v2/records/ARK-DOC-ABC"]
    assert org.public_id == "org_acme"
    assert org.industry_tag == "healthcare"
    assert not hasattr(org, "id")
    assert "id" not in org.model_dump()
    assert record.public_id == "ARK-DOC-ABC"
    assert record.parent_public_id is None
    assert not hasattr(record, "id")
    assert "id" not in record.model_dump()
    assert "org_id" not in record.model_dump()
    assert "user_id" not in record.model_dump()


def test_v2_fingerprint_and_document_detail_methods() -> None:
    fingerprint = "a" * 64
    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        if request.url.path.startswith("/v2/fingerprints/"):
            return json_response(
                {
                    "id": "internal-anchor-id",
                    "org_id": "internal-org-id",
                    "user_id": "internal-user-id",
                    "public_id": "ARK-DOC-FP",
                    "verified": True,
                    "status": "ACTIVE",
                    "fingerprint": fingerprint,
                    "title": "Fingerprint receipt",
                    "description": None,
                    "issuer_name": "Acme Corp",
                    "credential_type": "LEGAL",
                    "sub_type": None,
                    "issued_date": None,
                    "expiry_date": None,
                    "anchor_timestamp": "2026-04-24T12:00:00Z",
                    "network_receipt_id": "tx-1",
                    "record_uri": "https://app.arkova.ai/verify/ARK-DOC-FP",
                    "compliance_controls": None,
                    "chain_confirmations": None,
                    "parent_public_id": None,
                    "version_number": None,
                    "revocation_tx_id": None,
                    "revocation_block_height": None,
                    "file_mime": None,
                    "file_size": None,
                }
            )
        return json_response(
            {
                "id": "internal-anchor-id",
                "org_id": "internal-org-id",
                "user_id": "internal-user-id",
                "public_id": "ARK-DOC-ABC",
                "verified": True,
                "status": "ACTIVE",
                "fingerprint": fingerprint,
                "title": "Contract.pdf",
                "description": None,
                "issuer_name": "Acme Corp",
                "credential_type": "LEGAL",
                "sub_type": None,
                "issued_date": None,
                "expiry_date": None,
                "anchor_timestamp": "2026-04-24T12:00:00Z",
                "network_receipt_id": "tx-1",
                "record_uri": "https://app.arkova.ai/verify/ARK-DOC-ABC",
                "compliance_controls": None,
                "chain_confirmations": None,
                "parent_public_id": None,
                "version_number": None,
                "revocation_tx_id": None,
                "revocation_block_height": None,
                "file_mime": "application/pdf",
                "file_size": 12345,
            }
        )

    with Arkova(api_key="ak_test", transport=httpx.MockTransport(handler)) as client:
        fingerprint_detail = client.get_fingerprint(fingerprint)
        document = client.get_document("ARK-DOC-ABC")

    assert seen_paths == [f"/v2/fingerprints/{fingerprint}", "/v2/documents/ARK-DOC-ABC"]
    assert fingerprint_detail.fingerprint == fingerprint
    assert fingerprint_detail.public_id == "ARK-DOC-FP"
    assert fingerprint_detail.file_size is None
    assert "id" not in fingerprint_detail.model_dump()
    assert "org_id" not in fingerprint_detail.model_dump()
    assert "user_id" not in fingerprint_detail.model_dump()
    assert document.public_id == "ARK-DOC-ABC"
    assert document.file_mime == "application/pdf"
    assert document.file_size == 12345
    assert "id" not in document.model_dump()
    assert "org_id" not in document.model_dump()
    assert "user_id" not in document.model_dump()


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
