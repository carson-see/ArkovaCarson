"""Sync + async HTTP clients for the Arkova API (INT-04).

Mirrors the TypeScript SDK in `packages/sdk/src/client.ts` so Python consumers
see the same `anchor() / verify() / verify_batch()` surface. Uses httpx for
sync + async support without pulling extra dependencies.
"""

from __future__ import annotations

import hashlib
import sys
from dataclasses import asdict
from typing import Any, Dict, List, Optional, Sequence, Union

import httpx

from .errors import ArkovaError
from .models import AnchorReceipt, VerificationResult

DEFAULT_BASE_URL = "https://arkova-worker-270018525501.us-central1.run.app"
DEFAULT_TIMEOUT_S = 30.0
# Mirrors `MAX_BATCH_SIZE` in packages/sdk/src/client.ts; the worker rejects
# batches larger than this with a 400.
MAX_BATCH_SIZE = 100


def _sha256_hex(data: Union[str, bytes]) -> str:
    """SHA-256 hex digest. Matches `generateFingerprint` semantics."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _user_agent() -> str:
    return f"@arkova/python/0.1.0 python/{sys.version_info.major}.{sys.version_info.minor}"


def _build_headers(api_key: Optional[str]) -> Dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "User-Agent": _user_agent(),
    }
    if api_key:
        headers["X-API-Key"] = api_key
    return headers


def _raise_for_status(resp: httpx.Response) -> None:
    if resp.is_success:
        return
    code: Optional[str] = None
    details: Any = None
    message = f"HTTP {resp.status_code}"
    try:
        body = resp.json()
        if isinstance(body, dict):
            code = body.get("error") or body.get("code")
            details = body.get("details")
            message = body.get("message") or message
    except (ValueError, KeyError):
        pass
    raise ArkovaError(message, status=resp.status_code, code=code, details=details)


def _to_receipt(payload: Dict[str, Any]) -> AnchorReceipt:
    return AnchorReceipt(
        public_id=payload["public_id"],
        fingerprint=payload["fingerprint"],
        status=payload["status"],
        created_at=payload["created_at"],
        record_uri=payload.get("record_uri"),
    )


def _to_verification(payload: Dict[str, Any]) -> VerificationResult:
    return VerificationResult(
        verified=bool(payload.get("verified", False)),
        public_id=payload.get("public_id", ""),
        fingerprint=payload.get("fingerprint", ""),
        status=payload.get("status", ""),
        anchor_timestamp=payload.get("anchor_timestamp", ""),
        credential_type=payload.get("credential_type"),
        issuer_org_name=payload.get("issuer_org_name"),
        chain_tx_id=payload.get("chain_tx_id"),
        block_height=payload.get("block_height"),
        revoked_at=payload.get("revoked_at"),
    )


class Arkova:
    """Synchronous Arkova client.

    Example:
        >>> from arkova import Arkova
        >>> client = Arkova(api_key="ak_...")
        >>> receipt = client.anchor("hello world")
        >>> result = client.verify(receipt.public_id)
        >>> assert result.verified
    """

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_S,
        client: Optional[httpx.Client] = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.Client(
            base_url=self._base_url,
            headers=_build_headers(api_key),
            timeout=timeout,
        )

    def __enter__(self) -> "Arkova":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def anchor(self, data: Union[str, bytes]) -> AnchorReceipt:
        """Compute SHA-256 fingerprint locally and submit for anchoring."""
        fingerprint = _sha256_hex(data)
        resp = self._client.post("/api/v1/anchor", json={"fingerprint": fingerprint})
        _raise_for_status(resp)
        return _to_receipt(resp.json())

    def verify(self, public_id: str) -> VerificationResult:
        """Fetch the verification result for an anchor by its public ID."""
        resp = self._client.get(f"/api/v1/verify/{public_id}")
        _raise_for_status(resp)
        return _to_verification(resp.json())

    def verify_batch(self, public_ids: Sequence[str]) -> List[VerificationResult]:
        """Verify up to MAX_BATCH_SIZE anchors in one round-trip."""
        if not public_ids:
            return []
        if len(public_ids) > MAX_BATCH_SIZE:
            raise ArkovaError(
                f"verify_batch: max {MAX_BATCH_SIZE} ids per call, got {len(public_ids)}",
                status=400,
                code="batch_too_large",
            )
        resp = self._client.post(
            "/api/v1/verify/batch",
            json={"public_ids": list(public_ids)},
        )
        _raise_for_status(resp)
        body = resp.json()
        items = body.get("results") if isinstance(body, dict) else body
        return [_to_verification(item) for item in items or []]


class AsyncArkova:
    """Async variant of Arkova for asyncio applications."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_S,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=self._base_url,
            headers=_build_headers(api_key),
            timeout=timeout,
        )

    async def __aenter__(self) -> "AsyncArkova":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def anchor(self, data: Union[str, bytes]) -> AnchorReceipt:
        fingerprint = _sha256_hex(data)
        resp = await self._client.post("/api/v1/anchor", json={"fingerprint": fingerprint})
        _raise_for_status(resp)
        return _to_receipt(resp.json())

    async def verify(self, public_id: str) -> VerificationResult:
        resp = await self._client.get(f"/api/v1/verify/{public_id}")
        _raise_for_status(resp)
        return _to_verification(resp.json())

    async def verify_batch(self, public_ids: Sequence[str]) -> List[VerificationResult]:
        if not public_ids:
            return []
        if len(public_ids) > MAX_BATCH_SIZE:
            raise ArkovaError(
                f"verify_batch: max {MAX_BATCH_SIZE} ids per call, got {len(public_ids)}",
                status=400,
                code="batch_too_large",
            )
        resp = await self._client.post(
            "/api/v1/verify/batch",
            json={"public_ids": list(public_ids)},
        )
        _raise_for_status(resp)
        body = resp.json()
        items = body.get("results") if isinstance(body, dict) else body
        return [_to_verification(item) for item in items or []]


# Re-export `dataclass.asdict` for callers who want plain dicts.
to_dict = asdict
