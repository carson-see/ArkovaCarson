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
from .models import (
    AnchorReceipt,
    AttestationDetails,
    AttestationEvidence,
    AttestorCredential,
    VerificationResult,
)

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


def _to_attestation(payload: Dict[str, Any]) -> AttestationDetails:
    attester = payload.get("attester") if isinstance(payload.get("attester"), dict) else {}
    evidence = [
        AttestationEvidence(
            public_id=item["public_id"],
            evidence_type=item["evidence_type"],
            fingerprint=item["fingerprint"],
            created_at=item["created_at"],
            description=item.get("description"),
            mime=item.get("mime"),
            size=item.get("size"),
        )
        for item in payload.get("evidence", []) or []
    ]
    credentials = payload.get("attestor_credentials")
    attestor_credentials = None
    if isinstance(credentials, list):
        attestor_credentials = [
            AttestorCredential(
                public_id=item["public_id"],
                status=item["status"],
                record_uri=item["record_uri"],
                credential_type=item.get("credential_type"),
                fingerprint=item.get("fingerprint"),
                version_number=item.get("version_number"),
                parent_public_id=item.get("parent_public_id"),
                is_current=bool(item.get("is_current", False)),
                chain_proof=item.get("chain_proof"),
            )
            for item in credentials
        ]

    return AttestationDetails(
        public_id=payload["public_id"],
        attestation_type=payload["attestation_type"],
        status=payload["status"],
        subject_type=payload["subject_type"],
        subject_identifier=payload["subject_identifier"],
        attester_name=attester.get("name", ""),
        attester_type=attester.get("type", ""),
        attester_title=attester.get("title"),
        claims=payload.get("claims", []) or [],
        evidence=evidence,
        evidence_count=int(payload.get("evidence_count", len(evidence))),
        verify_url=payload["verify_url"],
        summary=payload.get("summary"),
        jurisdiction=payload.get("jurisdiction"),
        fingerprint=payload.get("fingerprint"),
        evidence_fingerprint=payload.get("evidence_fingerprint"),
        chain_proof=payload.get("chain_proof"),
        linked_credential=payload.get("linked_credential"),
        attestor_credentials=attestor_credentials,
        issued_at=payload.get("issued_at"),
        expires_at=payload.get("expires_at"),
        revoked_at=payload.get("revoked_at"),
        revocation_reason=payload.get("revocation_reason"),
        created_at=payload.get("created_at"),
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

    def get_attestation(
        self,
        public_id: str,
        *,
        include_credentials: bool = False,
    ) -> AttestationDetails:
        """Fetch a public attestation by public ID.

        Set include_credentials=True for the SCRUM-897 evidence array and
        bounded attestor credential chain.
        """
        path = f"/api/v1/attestations/{public_id}"
        if include_credentials:
            path += "?include=credentials"
        resp = self._client.get(path)
        _raise_for_status(resp)
        return _to_attestation(resp.json())

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

    async def get_attestation(
        self,
        public_id: str,
        *,
        include_credentials: bool = False,
    ) -> AttestationDetails:
        path = f"/api/v1/attestations/{public_id}"
        if include_credentials:
            path += "?include=credentials"
        resp = await self._client.get(path)
        _raise_for_status(resp)
        return _to_attestation(resp.json())

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
