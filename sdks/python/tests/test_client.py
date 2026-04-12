"""Tests for Arkova Python SDK — full parity with TypeScript SDK tests.

Uses respx to mock httpx requests. No real API calls.
"""

import hashlib
import pytest
import respx
from httpx import Response

from arkova import (
    ArkovaClient,
    ArkovaError,
    VERIFY_BATCH_SYNC_LIMIT,
    AnchorReceipt,
    VerificationResult,
    WebhookEndpoint,
    WebhookEndpointWithSecret,
    PaginatedWebhooks,
    NessieQueryResult,
    NessieContextResult,
)

BASE_URL = "https://test.arkova.ai"


@pytest.fixture
def client():
    c = ArkovaClient(api_key="ak_test_123", base_url=BASE_URL)
    yield c
    c.close()


# ── Init ──────────────────────────────────────────────────────────────


class TestInit:
    def test_creates_client_with_api_key(self):
        c = ArkovaClient(api_key="ak_test")
        assert c is not None
        c.close()

    def test_raises_without_api_key(self):
        with pytest.raises(ArkovaError, match="api_key is required"):
            ArkovaClient(api_key="")

    def test_context_manager(self):
        with ArkovaClient(api_key="ak_test") as c:
            assert c is not None

    def test_strips_trailing_slashes(self):
        c = ArkovaClient(api_key="ak_test", base_url="https://api.example.com///")
        assert c._base_url == "https://api.example.com"
        c.close()


# ── Fingerprint ───────────────────────────────────────────────────────


class TestFingerprint:
    def test_sha256_of_string(self):
        fp = ArkovaClient.fingerprint("hello world")
        expected = hashlib.sha256(b"hello world").hexdigest()
        assert fp == expected
        assert len(fp) == 64

    def test_sha256_of_bytes(self):
        fp = ArkovaClient.fingerprint(b"hello world")
        expected = hashlib.sha256(b"hello world").hexdigest()
        assert fp == expected

    def test_consistent_hashes(self):
        fp1 = ArkovaClient.fingerprint("test data")
        fp2 = ArkovaClient.fingerprint("test data")
        assert fp1 == fp2

    def test_known_hash(self):
        fp = ArkovaClient.fingerprint("hello world")
        assert fp == "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"


# ── Anchor ────────────────────────────────────────────────────────────


class TestAnchor:
    @respx.mock
    def test_anchor_sends_fingerprint(self, client):
        route = respx.post(f"{BASE_URL}/api/v1/anchor").mock(
            return_value=Response(200, json={
                "public_id": "ARK-2026-001",
                "fingerprint": "abc123",
                "status": "PENDING",
                "created_at": "2026-01-01T00:00:00Z",
                "record_uri": "https://app.arkova.ai/verify/ARK-2026-001",
            })
        )
        receipt = client.anchor("test document")
        assert receipt.public_id == "ARK-2026-001"
        assert receipt.status == "PENDING"
        assert receipt.created_at == "2026-01-01T00:00:00Z"
        assert route.called

    @respx.mock
    def test_anchor_with_metadata(self, client):
        respx.post(f"{BASE_URL}/api/v1/anchor").mock(
            return_value=Response(200, json={
                "public_id": "ARK-2026-002",
                "fingerprint": "def456",
                "status": "PENDING",
                "created_at": "2026-01-01T00:00:00Z",
                "record_uri": "",
            })
        )
        receipt = client.anchor(
            b"diploma.pdf content",
            credential_type="DEGREE",
            description="BS Computer Science",
        )
        assert receipt.public_id == "ARK-2026-002"

    @respx.mock
    def test_anchor_fingerprint_direct(self, client):
        respx.post(f"{BASE_URL}/api/v1/anchor").mock(
            return_value=Response(200, json={
                "public_id": "ARK-2026-003",
                "fingerprint": "precomputed",
                "status": "PENDING",
                "created_at": "2026-01-01T00:00:00Z",
                "record_uri": "",
            })
        )
        receipt = client.anchor_fingerprint("precomputed")
        assert receipt.fingerprint == "precomputed"

    @respx.mock
    def test_anchor_error(self, client):
        respx.post(f"{BASE_URL}/api/v1/anchor").mock(
            return_value=Response(400, json={
                "error": "validation_error",
                "message": "Invalid fingerprint format",
            })
        )
        with pytest.raises(ArkovaError) as exc_info:
            client.anchor("bad")
        assert exc_info.value.status_code == 400
        assert exc_info.value.code == "validation_error"


# ── Verify ────────────────────────────────────────────────────────────


class TestVerify:
    @respx.mock
    def test_verify_by_public_id(self, client):
        respx.get(f"{BASE_URL}/api/v1/verify/ARK-2026-001").mock(
            return_value=Response(200, json={
                "verified": True,
                "status": "ACTIVE",
                "issuer_name": "University of Michigan",
                "credential_type": "DEGREE",
                "issued_date": "2025-05-15",
                "expiry_date": None,
                "anchor_timestamp": "2026-01-01T00:00:00Z",
                "network_receipt_id": "tx-abc",
                "record_uri": "https://app.arkova.ai/verify/ARK-2026-001",
            })
        )
        result = client.verify("ARK-2026-001")
        assert result.verified is True
        assert result.status == "ACTIVE"
        assert result.issuer_name == "University of Michigan"
        assert result.network_receipt_id == "tx-abc"
        assert result.issued_date == "2025-05-15"

    @respx.mock
    def test_verify_not_found(self, client):
        respx.get(f"{BASE_URL}/api/v1/verify/ARK-MISSING").mock(
            return_value=Response(404, json={"error": "not_found"})
        )
        result = client.verify("ARK-MISSING")
        assert result.verified is False
        assert result.error == "Record not found"

    @respx.mock
    def test_verify_data(self, client):
        respx.post(f"{BASE_URL}/api/verify-anchor").mock(
            return_value=Response(200, json={
                "verified": True,
                "status": "ACTIVE",
                "anchor_timestamp": "2026-01-01T00:00:00Z",
                "network_receipt_id": "tx-def",
                "record_uri": "https://app.arkova.ai/verify/ARK-2026-001",
            })
        )
        result = client.verify_data("my document content")
        assert result.verified is True

    @respx.mock
    def test_verify_server_error(self, client):
        respx.get(f"{BASE_URL}/api/v1/verify/ARK-ERR").mock(
            return_value=Response(500, json={
                "error": "internal_error",
                "message": "Server error",
            })
        )
        with pytest.raises(ArkovaError) as exc_info:
            client.verify("ARK-ERR")
        assert exc_info.value.status_code == 500


# ── Batch Verify ──────────────────────────────────────────────────────


class TestVerifyBatch:
    def test_empty_returns_empty(self, client):
        results = client.verify_batch([])
        assert results == []

    def test_rejects_over_limit(self, client):
        ids = [f"ARK-{i}" for i in range(21)]
        with pytest.raises(ArkovaError) as exc_info:
            client.verify_batch(ids)
        assert exc_info.value.code == "batch_too_large"
        assert exc_info.value.status_code == 400

    @respx.mock
    def test_returns_mapped_results(self, client):
        respx.post(f"{BASE_URL}/api/v1/verify/batch").mock(
            return_value=Response(200, json={
                "results": [
                    {
                        "verified": True,
                        "status": "ACTIVE",
                        "issuer_name": "University A",
                        "credential_type": "DEGREE",
                        "issued_date": "2025-01-01",
                        "expiry_date": None,
                        "anchor_timestamp": "2026-01-01T00:00:00Z",
                        "network_receipt_id": "tx-1",
                        "record_uri": "https://app.arkova.ai/verify/ARK-1",
                    },
                    {
                        "verified": False,
                        "status": "REVOKED",
                        "issuer_name": "University B",
                        "credential_type": "DEGREE",
                        "issued_date": "2024-01-01",
                        "expiry_date": None,
                        "anchor_timestamp": "2025-01-01T00:00:00Z",
                        "network_receipt_id": "tx-2",
                        "record_uri": "https://app.arkova.ai/verify/ARK-2",
                    },
                ]
            })
        )
        results = client.verify_batch(["ARK-1", "ARK-2"])
        assert len(results) == 2
        assert results[0].verified is True
        assert results[0].issuer_name == "University A"
        assert results[1].verified is False
        assert results[1].status == "REVOKED"

    @respx.mock
    def test_batch_rate_limit_error(self, client):
        respx.post(f"{BASE_URL}/api/v1/verify/batch").mock(
            return_value=Response(429, json={
                "error": "rate_limit_exceeded",
                "message": "Too many requests",
            })
        )
        with pytest.raises(ArkovaError) as exc_info:
            client.verify_batch(["ARK-1"])
        assert exc_info.value.status_code == 429
        assert exc_info.value.code == "rate_limit_exceeded"

    def test_limit_constant_is_20(self):
        assert VERIFY_BATCH_SYNC_LIMIT == 20


# ── Webhooks ──────────────────────────────────────────────────────────


class TestWebhooks:
    @respx.mock
    def test_create_returns_secret(self, client):
        respx.post(f"{BASE_URL}/api/v1/webhooks").mock(
            return_value=Response(201, json={
                "id": "wh-1",
                "url": "https://example.com/hooks",
                "events": ["anchor.secured", "anchor.revoked"],
                "is_active": True,
                "description": "prod",
                "created_at": "2026-04-11T10:00:00Z",
                "updated_at": "2026-04-11T10:00:00Z",
                "secret": "a" * 64,
                "warning": "Save this secret now.",
            })
        )
        result = client.webhooks.create(
            url="https://example.com/hooks",
            events=["anchor.secured", "anchor.revoked"],
            description="prod",
        )
        assert result.id == "wh-1"
        assert result.url == "https://example.com/hooks"
        assert result.is_active is True
        assert result.secret == "a" * 64
        assert "Save this secret" in result.warning

    @respx.mock
    def test_create_invalid_url(self, client):
        respx.post(f"{BASE_URL}/api/v1/webhooks").mock(
            return_value=Response(400, json={
                "error": "invalid_url",
                "message": "URL resolves to private network",
            })
        )
        with pytest.raises(ArkovaError) as exc_info:
            client.webhooks.create(url="https://10.0.0.1/hooks")
        assert exc_info.value.status_code == 400
        assert exc_info.value.code == "invalid_url"

    @respx.mock
    def test_list_with_pagination(self, client):
        respx.get(f"{BASE_URL}/api/v1/webhooks").mock(
            return_value=Response(200, json={
                "webhooks": [
                    {
                        "id": "wh-1",
                        "url": "https://a.example.com",
                        "events": ["anchor.secured"],
                        "is_active": True,
                        "description": None,
                        "created_at": "2026-04-11T10:00:00Z",
                        "updated_at": "2026-04-11T10:00:00Z",
                    }
                ],
                "total": 1,
                "limit": 50,
                "offset": 0,
            })
        )
        result = client.webhooks.list()
        assert len(result.webhooks) == 1
        assert result.webhooks[0].is_active is True
        assert result.total == 1

    @respx.mock
    def test_list_passes_params(self, client):
        route = respx.get(f"{BASE_URL}/api/v1/webhooks").mock(
            return_value=Response(200, json={
                "webhooks": [], "total": 0, "limit": 10, "offset": 20
            })
        )
        client.webhooks.list(limit=10, offset=20)
        assert route.called
        req = route.calls[0].request
        assert "limit=10" in str(req.url)
        assert "offset=20" in str(req.url)

    @respx.mock
    def test_get_by_id(self, client):
        respx.get(f"{BASE_URL}/api/v1/webhooks/wh-1").mock(
            return_value=Response(200, json={
                "id": "wh-1",
                "url": "https://example.com/hooks",
                "events": ["anchor.secured"],
                "is_active": True,
                "description": None,
                "created_at": "2026-04-11T10:00:00Z",
                "updated_at": "2026-04-11T10:00:00Z",
            })
        )
        result = client.webhooks.get("wh-1")
        assert result.id == "wh-1"

    @respx.mock
    def test_get_not_found(self, client):
        respx.get(f"{BASE_URL}/api/v1/webhooks/wh-missing").mock(
            return_value=Response(404, json={
                "error": "not_found", "message": "no such webhook"
            })
        )
        with pytest.raises(ArkovaError) as exc_info:
            client.webhooks.get("wh-missing")
        assert exc_info.value.status_code == 404
        assert exc_info.value.code == "not_found"

    @respx.mock
    def test_update_partial(self, client):
        respx.patch(f"{BASE_URL}/api/v1/webhooks/wh-1").mock(
            return_value=Response(200, json={
                "id": "wh-1",
                "url": "https://example.com/hooks",
                "events": ["anchor.secured"],
                "is_active": False,
                "description": None,
                "created_at": "2026-04-11T10:00:00Z",
                "updated_at": "2026-04-11T11:00:00Z",
            })
        )
        result = client.webhooks.update("wh-1", is_active=False)
        assert result.is_active is False

    @respx.mock
    def test_delete(self, client):
        respx.delete(f"{BASE_URL}/api/v1/webhooks/wh-1").mock(
            return_value=Response(204)
        )
        client.webhooks.delete("wh-1")  # Should not raise

    @respx.mock
    def test_delete_not_found(self, client):
        respx.delete(f"{BASE_URL}/api/v1/webhooks/wh-missing").mock(
            return_value=Response(404, json={
                "error": "not_found", "message": "gone"
            })
        )
        with pytest.raises(ArkovaError) as exc_info:
            client.webhooks.delete("wh-missing")
        assert exc_info.value.status_code == 404

    @respx.mock
    def test_send_test_event(self, client):
        respx.post(f"{BASE_URL}/api/v1/webhooks/test").mock(
            return_value=Response(200, json={
                "success": True,
                "status_code": 200,
                "event_id": "test_abc",
            })
        )
        result = client.webhooks.test("wh-1")
        assert result.success is True
        assert result.status_code == 200
        assert result.event_id == "test_abc"


# ── Nessie Query ──────────────────────────────────────────────────────


class TestQuery:
    @respx.mock
    def test_retrieval_results(self, client):
        respx.get(f"{BASE_URL}/api/v1/nessie/query").mock(
            return_value=Response(200, json={
                "results": [
                    {
                        "record_id": "rec-1",
                        "source": "edgar",
                        "source_url": "https://sec.gov/filing/123",
                        "record_type": "10-K",
                        "title": "Apple Annual Report",
                        "relevance_score": 0.91,
                        "anchor_proof": {
                            "chain_tx_id": "tx-abc",
                            "content_hash": "hash-1",
                        },
                    }
                ],
                "count": 1,
                "query": "apple revenue",
            })
        )
        result = client.query("apple revenue")
        assert result.count == 1
        assert result.results[0].record_id == "rec-1"
        assert result.results[0].anchor_proof is not None
        assert result.results[0].anchor_proof.chain_tx_id == "tx-abc"

    @respx.mock
    def test_query_with_limit(self, client):
        route = respx.get(f"{BASE_URL}/api/v1/nessie/query").mock(
            return_value=Response(200, json={
                "results": [], "count": 0, "query": "test"
            })
        )
        client.query("test", limit=5)
        req = route.calls[0].request
        assert "limit=5" in str(req.url)


class TestAsk:
    @respx.mock
    def test_context_mode_response(self, client):
        respx.get(f"{BASE_URL}/api/v1/nessie/query").mock(
            return_value=Response(200, json={
                "answer": "Apple reported $394B revenue in 2025.",
                "citations": [
                    {
                        "record_id": "rec-1",
                        "source": "edgar",
                        "source_url": "https://sec.gov/filing/123",
                        "title": "Apple 10-K",
                        "relevance_score": 0.92,
                        "excerpt": "Total revenue: $394 billion",
                        "anchor_proof": {
                            "chain_tx_id": "tx-abc",
                            "content_hash": "hash-1",
                        },
                    }
                ],
                "confidence": 0.88,
                "model": "gemini-2.5-flash",
                "query": "apple revenue 2025",
            })
        )
        result = client.ask("apple revenue 2025")
        assert "$394B" in result.answer
        assert len(result.citations) == 1
        assert result.confidence == 0.88
        assert result.citations[0].anchor_proof is not None
        assert result.citations[0].anchor_proof.chain_tx_id == "tx-abc"


# ── ArkovaError ───────────────────────────────────────────────────────


class TestArkovaError:
    def test_exposes_status_and_code(self):
        err = ArkovaError("boom", status_code=400, code="validation_error")
        assert err.status_code == 400
        assert err.code == "validation_error"
        assert str(err) == "boom"

    def test_code_optional(self):
        err = ArkovaError("boom", status_code=500)
        assert err.code is None

    def test_inherits_exception(self):
        err = ArkovaError("test")
        assert isinstance(err, Exception)
