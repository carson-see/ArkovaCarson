"""Unit tests for the Python SDK (INT-04 / SCRUM Doc 1)."""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from arkova import Arkova, ArkovaError, AsyncArkova
from arkova.client import _sha256_hex


def _mock_transport(handler):
    return httpx.MockTransport(handler)


def test_sha256_hex_matches_hashlib() -> None:
    assert _sha256_hex("hello") == hashlib.sha256(b"hello").hexdigest()
    assert _sha256_hex(b"hello") == hashlib.sha256(b"hello").hexdigest()


def test_anchor_posts_fingerprint_and_returns_receipt() -> None:
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        captured["api_key"] = request.headers.get("X-API-Key")
        return httpx.Response(
            201,
            json={
                "public_id": "ARK-001",
                "fingerprint": captured["body"]["fingerprint"],
                "status": "PENDING",
                "created_at": "2026-04-28T00:00:00Z",
                "record_uri": "https://arkova.io/verify/ARK-001",
            },
        )

    client = httpx.Client(
        base_url="https://api.example",
        headers={"X-API-Key": "ak_test"},
        transport=_mock_transport(handler),
    )
    sdk = Arkova(api_key="ak_test", base_url="https://api.example", client=client)

    receipt = sdk.anchor("hello")
    assert receipt.public_id == "ARK-001"
    assert receipt.fingerprint == hashlib.sha256(b"hello").hexdigest()
    assert receipt.status == "PENDING"
    assert captured["api_key"] == "ak_test"
    assert captured["body"] == {"fingerprint": receipt.fingerprint}


def test_verify_returns_typed_result() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/verify/ARK-001"
        return httpx.Response(
            200,
            json={
                "verified": True,
                "public_id": "ARK-001",
                "fingerprint": "abc",
                "status": "SECURED",
                "anchor_timestamp": "2026-04-28T00:00:00Z",
                "credential_type": "DEGREE",
                "issuer_org_name": "MIT",
                "chain_tx_id": "txid",
                "block_height": 800000,
            },
        )

    client = httpx.Client(base_url="https://api.example", transport=_mock_transport(handler))
    sdk = Arkova(base_url="https://api.example", client=client)
    result = sdk.verify("ARK-001")
    assert result.verified is True
    assert result.credential_type == "DEGREE"
    assert result.block_height == 800000


def test_verify_batch_posts_array_and_unwraps_results() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body == {"public_ids": ["ARK-1", "ARK-2"]}
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "verified": True,
                        "public_id": "ARK-1",
                        "fingerprint": "a",
                        "status": "SECURED",
                        "anchor_timestamp": "t",
                    },
                    {
                        "verified": False,
                        "public_id": "ARK-2",
                        "fingerprint": "b",
                        "status": "REVOKED",
                        "anchor_timestamp": "t",
                        "revoked_at": "2026-04-28T00:00:00Z",
                    },
                ],
            },
        )

    client = httpx.Client(base_url="https://api.example", transport=_mock_transport(handler))
    sdk = Arkova(base_url="https://api.example", client=client)
    results = sdk.verify_batch(["ARK-1", "ARK-2"])
    assert len(results) == 2
    assert results[0].verified is True
    assert results[1].revoked_at == "2026-04-28T00:00:00Z"


def test_verify_batch_empty_list_short_circuits() -> None:
    sdk = Arkova(base_url="https://api.example")
    assert sdk.verify_batch([]) == []
    sdk.close()


def test_verify_batch_too_large_raises() -> None:
    sdk = Arkova(base_url="https://api.example")
    with pytest.raises(ArkovaError) as exc:
        sdk.verify_batch([f"ARK-{i}" for i in range(101)])
    assert exc.value.code == "batch_too_large"
    sdk.close()


def test_non_2xx_raises_arkova_error_with_code_and_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"error": "rate_limited", "message": "Too many requests"},
            headers={"Retry-After": "60"},
        )

    client = httpx.Client(base_url="https://api.example", transport=_mock_transport(handler))
    sdk = Arkova(base_url="https://api.example", client=client)
    with pytest.raises(ArkovaError) as exc:
        sdk.verify("ARK-1")
    assert exc.value.status == 429
    assert exc.value.code == "rate_limited"
    assert "Too many requests" in str(exc.value)


def test_context_manager_closes_owned_client() -> None:
    with Arkova(base_url="https://api.example") as sdk:
        assert isinstance(sdk, Arkova)


@pytest.mark.asyncio
async def test_async_verify_returns_typed_result() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "verified": True,
                "public_id": "ARK-1",
                "fingerprint": "a",
                "status": "SECURED",
                "anchor_timestamp": "2026-04-28T00:00:00Z",
            },
        )

    client = httpx.AsyncClient(base_url="https://api.example", transport=_mock_transport(handler))
    async with AsyncArkova(base_url="https://api.example", client=client) as sdk:
        result = await sdk.verify("ARK-1")
        assert result.verified is True
