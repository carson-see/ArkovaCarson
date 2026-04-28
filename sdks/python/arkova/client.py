"""Arkova SDK client — anchor, verify, and manage webhooks on Bitcoin.

Full parity with the TypeScript SDK (@arkova/sdk). Provides:
- Fingerprinting (client-side SHA-256)
- Anchor & verify (single and batch)
- Webhook management (CRUD + test)
- Nessie intelligence (query + ask)

Usage:
    from arkova import ArkovaClient

    client = ArkovaClient(api_key="ak_your_key")

    # Anchor data (hashes client-side, submits fingerprint)
    receipt = client.anchor(b"my important data")
    print(receipt.public_id)  # ARK-2026-XXXX

    # Verify by public_id
    result = client.verify(receipt.public_id)
    print(result.verified)  # True once anchored on-chain

    # Batch verify
    results = client.verify_batch(["ARK-2026-001", "ARK-2026-002"])

    # Webhook management
    wh = client.webhooks.create(url="https://example.com/hooks")
    print(wh.secret)  # Save this — shown only once

    # Nessie intelligence
    results = client.query("SEC 10-K filings")
    answer = client.ask("What are Apple's revenue trends?")
"""

import hashlib
import time
from typing import Dict, List, Optional, Union
from urllib.parse import quote

import httpx

from arkova.types import (
    AnchorProof,
    AnchorReceipt,
    BatchJob,
    BatchVerificationResult,
    NessieCitation,
    NessieContextResult,
    NessieQueryResult,
    NessieResult,
    PaginatedWebhooks,
    VerificationResult,
    WebhookEndpoint,
    WebhookEndpointWithSecret,
    WebhookTestResult,
)

DEFAULT_BASE_URL = "https://arkova-worker-270018525501.us-central1.run.app"

VERIFY_BATCH_SYNC_LIMIT = 20
"""Max public IDs per synchronous batch verify request.

Server returns sync results (200 OK) at this size or below; above this and up
to VERIFY_BATCH_MAX_SIZE the server returns 202 with a job_id for polling.
"""

VERIFY_BATCH_MAX_SIZE = 100
"""Max public IDs the server accepts in a single batch (sync or async)."""


class ArkovaError(Exception):
    """SDK error with HTTP status code and machine-readable error code."""

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class _WebhookNamespace:
    """Webhook management operations. Access via ``client.webhooks``."""

    def __init__(self, client: "ArkovaClient"):
        self._client = client

    def create(
        self,
        url: str,
        events: Optional[List[str]] = None,
        description: Optional[str] = None,
        verify: bool = False,
    ) -> WebhookEndpointWithSecret:
        """Register a new webhook endpoint. Returns the signing secret ONCE.

        Args:
            url: HTTPS URL to receive events. Must be publicly resolvable.
            events: Events to subscribe to. Default: ['anchor.secured', 'anchor.revoked']
            description: Free-text label (max 500 chars).
            verify: If True, send a verification ping with challenge token.

        Returns:
            WebhookEndpointWithSecret — save the ``secret`` immediately.
        """
        body: Dict[str, object] = {"url": url}
        if events is not None:
            body["events"] = events
        if description is not None:
            body["description"] = description
        if verify:
            body["verify"] = True

        data = self._client._request("POST", "/api/v1/webhooks", json=body)
        return _map_webhook_with_secret(data)

    def list(
        self, limit: Optional[int] = None, offset: Optional[int] = None
    ) -> PaginatedWebhooks:
        """List all webhook endpoints for the API key's organization."""
        params: Dict[str, str] = {}
        if limit is not None:
            params["limit"] = str(limit)
        if offset is not None:
            params["offset"] = str(offset)

        data = self._client._request("GET", "/api/v1/webhooks", params=params)
        return PaginatedWebhooks(
            webhooks=[_map_webhook(w) for w in data.get("webhooks", [])],
            total=data.get("total", 0),
            limit=data.get("limit", 50),
            offset=data.get("offset", 0),
        )

    def get(self, webhook_id: str) -> WebhookEndpoint:
        """Get a single webhook endpoint by ID."""
        data = self._client._request(
            "GET", f"/api/v1/webhooks/{quote(webhook_id, safe='')}"
        )
        return _map_webhook(data)

    def update(
        self,
        webhook_id: str,
        url: Optional[str] = None,
        events: Optional[List[str]] = None,
        description: Optional[str] = None,
        is_active: Optional[bool] = None,
    ) -> WebhookEndpoint:
        """Partially update a webhook endpoint."""
        body: Dict[str, object] = {}
        if url is not None:
            body["url"] = url
        if events is not None:
            body["events"] = events
        if description is not None:
            body["description"] = description
        if is_active is not None:
            body["is_active"] = is_active

        data = self._client._request(
            "PATCH",
            f"/api/v1/webhooks/{quote(webhook_id, safe='')}",
            json=body,
        )
        return _map_webhook(data)

    def delete(self, webhook_id: str) -> None:
        """Permanently delete a webhook endpoint."""
        self._client._request(
            "DELETE",
            f"/api/v1/webhooks/{quote(webhook_id, safe='')}",
            expect_no_content=True,
        )

    def test(self, endpoint_id: str) -> WebhookTestResult:
        """Send a synthetic test event to verify connectivity."""
        data = self._client._request(
            "POST",
            "/api/v1/webhooks/test",
            json={"endpoint_id": endpoint_id},
        )
        return WebhookTestResult(
            success=data.get("success", False),
            status_code=data.get("status_code", 0),
            event_id=data.get("event_id", ""),
        )


class ArkovaClient:
    """Client for the Arkova anchoring, verification, and intelligence API.

    Args:
        api_key: Your Arkova API key (starts with 'ak_').
        base_url: API base URL. Defaults to Arkova production.
        timeout: Request timeout in seconds. Defaults to 30.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
    ):
        if not api_key:
            raise ArkovaError("api_key is required")

        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self._base_url,
            headers={
                "X-API-Key": api_key,
                "Content-Type": "application/json",
                "User-Agent": "arkova-python/0.2.0",
            },
            timeout=timeout,
        )
        self.webhooks = _WebhookNamespace(self)

    def close(self) -> None:
        """Close the HTTP client."""
        self._client.close()

    def __enter__(self) -> "ArkovaClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    # ── Fingerprinting ────────────────────────────────────────────────

    @staticmethod
    def fingerprint(data: Union[bytes, str]) -> str:
        """Compute SHA-256 fingerprint of data.

        Args:
            data: Raw bytes or string to hash.

        Returns:
            64-character lowercase hex SHA-256 hash.
        """
        if isinstance(data, str):
            data = data.encode("utf-8")
        return hashlib.sha256(data).hexdigest()

    # ── Anchor ────────────────────────────────────────────────────────

    def anchor(
        self,
        data: Union[bytes, str],
        credential_type: Optional[str] = None,
        description: Optional[str] = None,
    ) -> AnchorReceipt:
        """Hash data client-side and submit the fingerprint for anchoring.

        The data never leaves your machine — only the SHA-256 hash is sent.

        Args:
            data: Raw bytes or string to anchor.
            credential_type: Optional type label (e.g., 'DEGREE', 'LICENSE').
            description: Optional human-readable description.

        Returns:
            AnchorReceipt with public_id for later verification.
        """
        fp = self.fingerprint(data)
        return self.anchor_fingerprint(
            fp, credential_type=credential_type, description=description
        )

    def anchor_fingerprint(
        self,
        fingerprint: str,
        credential_type: Optional[str] = None,
        description: Optional[str] = None,
    ) -> AnchorReceipt:
        """Submit a pre-computed fingerprint for anchoring.

        Args:
            fingerprint: 64-char hex SHA-256 hash.
            credential_type: Optional type label.
            description: Optional description.

        Returns:
            AnchorReceipt with public_id for later verification.
        """
        body: Dict[str, object] = {"fingerprint": fingerprint}
        if credential_type:
            body["credential_type"] = credential_type
        if description:
            body["description"] = description

        data = self._request("POST", "/api/v1/anchor", json=body)
        return AnchorReceipt(
            public_id=data["public_id"],
            fingerprint=data["fingerprint"],
            status=data["status"],
            created_at=data["created_at"],
            record_uri=data.get("record_uri", ""),
        )

    # ── Verify ────────────────────────────────────────────────────────

    def verify(self, public_id: str) -> VerificationResult:
        """Verify an anchor by its public ID.

        Args:
            public_id: The ARK-XXXX public identifier.

        Returns:
            VerificationResult with verified status and chain details.
        """
        try:
            data = self._request(
                "GET", f"/api/v1/verify/{quote(public_id, safe='')}"
            )
        except ArkovaError as e:
            if e.status_code == 404:
                return VerificationResult(verified=False, error="Record not found")
            raise

        return _map_verification_result(data)

    def verify_data(self, data: Union[bytes, str]) -> VerificationResult:
        """Hash data and verify the fingerprint against the chain.

        Args:
            data: Raw bytes or string to verify.

        Returns:
            VerificationResult with verified status.
        """
        fp = self.fingerprint(data)
        try:
            result = self._request(
                "POST", "/api/verify-anchor", json={"fingerprint": fp}
            )
        except ArkovaError:
            return VerificationResult(verified=False, error="Verification failed")

        return _map_verification_result(result)

    def verify_batch(self, public_ids: List[str]) -> List[VerificationResult]:
        """Verify multiple credentials in a single synchronous batch request.

        Accepts up to 20 public IDs per call. Returns results in input order.

        Args:
            public_ids: List of ARK-XXXX public identifiers (max 20).

        Returns:
            List of VerificationResult in the same order as input.

        Raises:
            ArkovaError: If batch exceeds sync limit or API fails.
        """
        if not public_ids:
            return []

        if len(public_ids) > VERIFY_BATCH_SYNC_LIMIT:
            raise ArkovaError(
                f"verify_batch accepts at most {VERIFY_BATCH_SYNC_LIMIT} public IDs "
                f"per synchronous request. Got {len(public_ids)}.",
                status_code=400,
                code="batch_too_large",
            )

        data = self._request(
            "POST",
            "/api/v1/verify/batch",
            json={"public_ids": public_ids},
        )

        return [_map_verification_result(r) for r in data.get("results", [])]

    def verify_batch_async(self, public_ids: List[str]) -> BatchJob:
        """Submit an async batch verification job for 21–100 public IDs.

        The server returns 202 with a job_id; poll with ``get_batch_job()``
        or block on ``wait_for_batch_job()``. For ≤20 IDs use ``verify_batch()``
        — the server returns sync results at that size and will not create a job.

        Args:
            public_ids: 21 to 100 ARK-XXXX public identifiers.

        Returns:
            BatchJob with status='submitted' (no results yet).

        Raises:
            ArkovaError: If count is outside (VERIFY_BATCH_SYNC_LIMIT, VERIFY_BATCH_MAX_SIZE].
        """
        if len(public_ids) <= VERIFY_BATCH_SYNC_LIMIT:
            raise ArkovaError(
                f"verify_batch_async requires more than {VERIFY_BATCH_SYNC_LIMIT} "
                f"public IDs (the server returns sync results at or below that size). "
                f"Use verify_batch() for ≤{VERIFY_BATCH_SYNC_LIMIT} IDs.",
                status_code=400,
                code="batch_too_small",
            )
        if len(public_ids) > VERIFY_BATCH_MAX_SIZE:
            raise ArkovaError(
                f"verify_batch_async accepts at most {VERIFY_BATCH_MAX_SIZE} "
                f"public IDs per request. Got {len(public_ids)}.",
                status_code=400,
                code="batch_too_large",
            )

        data = self._request(
            "POST",
            "/api/v1/verify/batch",
            json={"public_ids": public_ids},
        )

        if "job_id" not in data:
            raise ArkovaError(
                "Server did not return a job_id for async batch submission",
                status_code=500,
                code="unexpected_response",
            )

        return BatchJob(
            job_id=data["job_id"],
            status="submitted",
            total=data.get("total", len(public_ids)),
            created_at="",
            expires_at=data.get("expires_at", ""),
        )

    def get_batch_job(self, job_id: str) -> BatchJob:
        """Fetch the current status (and results, if complete) of a batch job.

        Args:
            job_id: ID returned by ``verify_batch_async()``.

        Returns:
            BatchJob with current status. ``results`` is populated when
            ``status == 'complete'``; ``error_message`` when ``'failed'``.
        """
        data = self._request(
            "GET", f"/api/v1/jobs/{quote(job_id, safe='')}"
        )
        return _map_batch_job(data)

    def wait_for_batch_job(
        self,
        job_id: str,
        timeout: float = 300.0,
        poll_interval: float = 2.0,
    ) -> BatchJob:
        """Block until a batch job reaches a terminal state (complete or failed).

        Args:
            job_id: ID returned by ``verify_batch_async()``.
            timeout: Max seconds to wait. Defaults to 300 (5 min).
            poll_interval: Seconds between polls. Defaults to 2.0.

        Returns:
            BatchJob in 'complete' or 'failed' status.

        Raises:
            ArkovaError: If the timeout is reached before the job finishes.
        """
        deadline = time.monotonic() + timeout
        while True:
            job = self.get_batch_job(job_id)
            if job.status in ("complete", "failed"):
                return job
            if time.monotonic() >= deadline:
                raise ArkovaError(
                    f"Batch job {job_id} did not finish within {timeout}s "
                    f"(last status: {job.status})",
                    status_code=408,
                    code="batch_job_timeout",
                )
            time.sleep(poll_interval)

    # ── Nessie Intelligence ───────────────────────────────────────────

    def query(self, q: str, limit: Optional[int] = None) -> NessieQueryResult:
        """Query Nessie — semantic search over 1.4M+ verified public records.

        Args:
            q: Search query string.
            limit: Max results to return.

        Returns:
            NessieQueryResult with ranked results and anchor proofs.
        """
        params: Dict[str, str] = {"q": q, "mode": "retrieval"}
        if limit is not None:
            params["limit"] = str(limit)

        data = self._request("GET", "/api/v1/nessie/query", params=params)

        return NessieQueryResult(
            results=[_map_nessie_result(r) for r in data.get("results", [])],
            count=data.get("count", 0),
            query=data.get("query", q),
        )

    def ask(self, q: str, limit: Optional[int] = None) -> NessieContextResult:
        """Ask Nessie — verified context mode with synthesized answer and citations.

        Args:
            q: Natural language question.
            limit: Max citations to include.

        Returns:
            NessieContextResult with answer, citations, and confidence score.
        """
        params: Dict[str, str] = {"q": q, "mode": "context"}
        if limit is not None:
            params["limit"] = str(limit)

        data = self._request("GET", "/api/v1/nessie/query", params=params)

        return NessieContextResult(
            answer=data.get("answer", ""),
            citations=[_map_nessie_citation(c) for c in data.get("citations", [])],
            confidence=data.get("confidence", 0.0),
            model=data.get("model", ""),
            query=data.get("query", q),
        )

    # ── Internal HTTP ─────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        json: Optional[Dict[str, object]] = None,
        params: Optional[Dict[str, str]] = None,
        expect_no_content: bool = False,
    ) -> Dict:
        """Internal HTTP request wrapper with error handling."""
        response = self._client.request(method, path, json=json, params=params)

        if expect_no_content and response.status_code in (200, 204):
            return {}

        if response.status_code >= 400:
            error_data: Dict = {}
            try:
                ct = response.headers.get("content-type", "")
                if ct.startswith("application/json"):
                    error_data = response.json()
            except Exception:
                pass

            raise ArkovaError(
                error_data.get("message", error_data.get("error", f"HTTP {response.status_code}")),
                status_code=response.status_code,
                code=error_data.get("error"),
            )

        return response.json()


# ── Internal mappers ──────────────────────────────────────────────────


def _map_verification_result(data: Dict) -> VerificationResult:
    return VerificationResult(
        verified=data.get("verified", False),
        status=data.get("status"),
        issuer_name=data.get("issuer_name"),
        credential_type=data.get("credential_type"),
        anchor_timestamp=data.get("anchor_timestamp"),
        bitcoin_block=data.get("bitcoin_block"),
        network_receipt_id=data.get("network_receipt_id"),
        record_uri=data.get("record_uri"),
        explorer_url=data.get("explorer_url"),
        description=data.get("description"),
        issued_date=data.get("issued_date"),
        expiry_date=data.get("expiry_date"),
        error=data.get("error"),
    )


def _map_batch_verification_result(data: Dict) -> BatchVerificationResult:
    return BatchVerificationResult(
        verified=data.get("verified", False),
        status=data.get("status"),
        issuer_name=data.get("issuer_name"),
        credential_type=data.get("credential_type"),
        anchor_timestamp=data.get("anchor_timestamp"),
        bitcoin_block=data.get("bitcoin_block"),
        network_receipt_id=data.get("network_receipt_id"),
        record_uri=data.get("record_uri"),
        explorer_url=data.get("explorer_url"),
        description=data.get("description"),
        issued_date=data.get("issued_date"),
        expiry_date=data.get("expiry_date"),
        error=data.get("error"),
        public_id=data.get("public_id", ""),
    )


def _map_batch_job(data: Dict) -> BatchJob:
    raw_results = data.get("results")
    results: Optional[List[BatchVerificationResult]] = None
    if isinstance(raw_results, list):
        results = [_map_batch_verification_result(r) for r in raw_results]

    return BatchJob(
        job_id=data.get("job_id", data.get("id", "")),
        status=data.get("status", ""),
        total=data.get("total", 0),
        created_at=data.get("created_at", ""),
        expires_at=data.get("expires_at", ""),
        completed_at=data.get("completed_at"),
        results=results,
        error_message=data.get("error_message"),
    )


def _map_webhook(data: Dict) -> WebhookEndpoint:
    return WebhookEndpoint(
        id=data["id"],
        url=data["url"],
        events=data.get("events", []),
        is_active=data.get("is_active", True),
        description=data.get("description"),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


def _map_webhook_with_secret(data: Dict) -> WebhookEndpointWithSecret:
    return WebhookEndpointWithSecret(
        id=data["id"],
        url=data["url"],
        events=data.get("events", []),
        is_active=data.get("is_active", True),
        description=data.get("description"),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
        secret=data.get("secret", ""),
        warning=data.get("warning", ""),
    )


def _map_anchor_proof(data: Optional[Dict]) -> Optional[AnchorProof]:
    if not data:
        return None
    return AnchorProof(
        chain_tx_id=data.get("chain_tx_id"),
        content_hash=data.get("content_hash", ""),
    )


def _map_nessie_result(data: Dict) -> NessieResult:
    return NessieResult(
        record_id=data.get("record_id", ""),
        source=data.get("source", ""),
        source_url=data.get("source_url", ""),
        record_type=data.get("record_type", ""),
        title=data.get("title"),
        relevance_score=data.get("relevance_score", 0.0),
        anchor_proof=_map_anchor_proof(data.get("anchor_proof")),
    )


def _map_nessie_citation(data: Dict) -> NessieCitation:
    return NessieCitation(
        record_id=data.get("record_id", ""),
        source=data.get("source", ""),
        source_url=data.get("source_url", ""),
        title=data.get("title"),
        relevance_score=data.get("relevance_score", 0.0),
        excerpt=data.get("excerpt", ""),
        anchor_proof=_map_anchor_proof(data.get("anchor_proof")),
    )
