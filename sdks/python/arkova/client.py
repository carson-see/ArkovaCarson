"""Arkova SDK client — anchor and verify data integrity on Bitcoin.

Usage:
    from arkova import ArkovaClient

    client = ArkovaClient(api_key="ak_your_key")

    # Anchor data (hashes client-side, submits fingerprint)
    receipt = client.anchor(b"my important data")
    print(receipt.public_id)  # ARK-2026-XXXX

    # Verify by public_id
    result = client.verify(receipt.public_id)
    print(result.verified)  # True once anchored on-chain

    # Verify raw data (hashes and checks)
    result = client.verify_data(b"my important data")
"""

import hashlib
from typing import Optional, Union

import httpx

from arkova.types import AnchorReceipt, VerificationResult

DEFAULT_BASE_URL = "https://arkova-worker-270018525501.us-central1.run.app"


class ArkovaError(Exception):
    """Base exception for Arkova SDK errors."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


class ArkovaClient:
    """Client for the Arkova anchoring and verification API.

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
                "User-Agent": "arkova-python/0.1.0",
            },
            timeout=timeout,
        )

    def close(self) -> None:
        """Close the HTTP client."""
        self._client.close()

    def __enter__(self) -> "ArkovaClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

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
            credential_type: Optional type label (e.g., 'report', 'model_output').
            description: Optional human-readable description.

        Returns:
            AnchorReceipt with public_id for later verification.

        Raises:
            ArkovaError: If the API request fails.
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
        body: dict = {"fingerprint": fingerprint}
        if credential_type:
            body["credential_type"] = credential_type
        if description:
            body["description"] = description

        response = self._client.post("/api/v1/anchor", json=body)

        if response.status_code >= 400:
            error_data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            raise ArkovaError(
                error_data.get("error", f"HTTP {response.status_code}"),
                status_code=response.status_code,
            )

        data = response.json()
        return AnchorReceipt(
            public_id=data["public_id"],
            fingerprint=data["fingerprint"],
            status=data["status"],
            created_at=data["created_at"],
            record_uri=data["record_uri"],
        )

    def verify(self, public_id: str) -> VerificationResult:
        """Verify an anchor by its public ID.

        Args:
            public_id: The ARK-XXXX public identifier.

        Returns:
            VerificationResult with verified status and chain details.
        """
        response = self._client.get(f"/api/v1/verify/{public_id}")

        if response.status_code == 404:
            return VerificationResult(verified=False, error="Record not found")

        if response.status_code >= 400:
            error_data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            raise ArkovaError(
                error_data.get("error", f"HTTP {response.status_code}"),
                status_code=response.status_code,
            )

        data = response.json()
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
            error=data.get("error"),
        )

    def verify_data(self, data: Union[bytes, str]) -> VerificationResult:
        """Hash data and verify the fingerprint against the chain.

        Args:
            data: Raw bytes or string to verify.

        Returns:
            VerificationResult with verified status.
        """
        fp = self.fingerprint(data)
        response = self._client.post(
            "/api/verify-anchor", json={"fingerprint": fp}
        )

        if response.status_code >= 400:
            return VerificationResult(verified=False, error="Verification failed")

        result = response.json()
        return VerificationResult(
            verified=result.get("verified", False),
            status=result.get("status"),
            anchor_timestamp=result.get("anchor_timestamp"),
            bitcoin_block=result.get("bitcoin_block"),
            network_receipt_id=result.get("network_receipt_id"),
            record_uri=result.get("record_uri"),
        )
