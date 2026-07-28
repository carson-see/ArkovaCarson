from __future__ import annotations

import asyncio
import email.utils
import hashlib
import time
from collections.abc import Callable, Mapping, Sequence
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version
from typing import Any, TypeVar
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from .errors import ArkovaError
from .models import (
    Anchor,
    AnchorReceipt,
    BulkAnchorDuplicateStrategy,
    BulkAnchorInput,
    BulkAnchorResponse,
    DocumentDetail,
    FingerprintDetail,
    FingerprintVerification,
    MerkleProofResponse,
    OrganizationDetail,
    OrgList,
    ProblemDetail,
    RecordDetail,
    SearchResponse,
    SearchType,
    VerificationResult,
)

DEFAULT_BASE_URL = "https://api.arkova.ai/v2"
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}

# Maximum rows per `anchor_bulk()` call. Mirrors the worker's
# `BulkAnchorRequestSchema.anchors` cap in
# `services/worker/src/api/v1/anchor-bulk.ts` (`.max(1000)`), which bounds
# validation cost (O(n^2) intra-batch duplicate detection) server-side.
#
# The SDK raises client-side rather than auto-chunking: chunking would split
# duplicate detection across requests (a fingerprint repeated across chunk
# boundaries would only be caught by the slower DB-side check, not the
# cheaper intra-batch check) and would deduct credits per chunk with no
# atomicity across the whole logical batch. Same posture as the TypeScript
# SDK's `anchorBulk()` / `verifyBatch()`.
BULK_ANCHOR_MAX_ROWS = 1000

try:
    _VERSION = _package_version("arkova")
except PackageNotFoundError:  # running from a source tree without an install
    _VERSION = "unknown"
T = TypeVar("T")


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": f"arkova-python/{_VERSION}",
    }


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            parsed = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        return max(0.0, parsed.timestamp() - time.time()) if parsed else None


def _problem(response: httpx.Response) -> ProblemDetail | None:
    content_type = response.headers.get("content-type", "")
    if "application/problem+json" not in content_type:
        return None
    try:
        return ProblemDetail.model_validate(response.json())
    except (ValueError, ValidationError):
        return None


def _plain_error_body(response: httpx.Response) -> dict[str, Any] | None:
    """Best-effort parse of a non-RFC-7807 JSON error body.

    v1 write-path endpoints (``/api/v1/anchor``, ``/api/v1/anchor/bulk``, ...)
    return plain ``{"error": "...", "message": "..."}`` JSON, not
    ``application/problem+json``. Returns ``None`` on any parse failure or
    non-dict body so callers can fall back to a generic message.
    """
    try:
        body = response.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _raise_for_error(response: httpx.Response) -> None:
    if response.status_code < 400:
        return

    problem = _problem(response)
    retry_after = _retry_after(response.headers.get("Retry-After"))

    if problem is not None:
        message = problem.detail or problem.title
        # Mirrors the TS SDK: `problem.type.split('/').pop()` as a fallback code.
        code = problem.type.rstrip("/").rsplit("/", 1)[-1] if problem.type else None
        raise ArkovaError(
            message,
            status_code=response.status_code,
            code=code,
            problem=problem,
            retry_after=retry_after,
        )

    body = _plain_error_body(response) or {}
    raw_code = body.get("error")
    code = raw_code if isinstance(raw_code, str) else None
    raw_message = body.get("message")
    message = (
        raw_message
        if isinstance(raw_message, str) and raw_message
        else code or f"Arkova API error {response.status_code}"
    )
    raise ArkovaError(
        message,
        status_code=response.status_code,
        code=code,
        retry_after=retry_after,
    )


def _parse_json(response: httpx.Response, model: type[T]) -> T:
    try:
        return model.model_validate(response.json())  # type: ignore[attr-defined]
    except (ValueError, ValidationError) as exc:
        raise ArkovaError("Arkova API returned an unexpected response shape") from exc


def _versioned_path(base_url: str, version: str, path: str) -> str:
    if not path.startswith("/"):
        path = f"/{path}"

    url = httpx.URL(base_url)
    segments = tuple(segment for segment in url.path.split("/") if segment)
    if segments and segments[-1] in {"v1", "v2"}:
        prefix_segments = (*segments[:-1], version)
        return str(url.copy_with(path=f"/{'/'.join(prefix_segments)}{path}"))

    return f"/api/{version}{path}"


def _compute_fingerprint(data: str | bytes) -> str:
    """Compute a SHA-256 fingerprint of ``data``, in-process.

    Identical algorithm to ``integrations/shared/src/fingerprint.ts`` / the
    TypeScript SDK's ``Arkova.fingerprint()``: SHA-256 of the UTF-8-encoded
    string (or raw bytes as given), returned as 64 lowercase hex characters.
    """
    buffer = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(buffer).hexdigest()


def _resolve_anchor_fingerprint(*, data: str | bytes | None, fingerprint: str | None) -> str:
    if (fingerprint is None) == (data is None):
        raise ArkovaError(
            "anchor() requires exactly one of `data` or `fingerprint`, "
            + ("not both." if fingerprint is not None else "but neither was given."),
            status_code=400,
            code="invalid_request",
        )
    return fingerprint if fingerprint is not None else _compute_fingerprint(data)  # type: ignore[arg-type]


def _empty_bulk_response(*, batch_id: str | None, dry_run: bool | None) -> BulkAnchorResponse:
    return BulkAnchorResponse(
        batch_id=batch_id,
        validated=0,
        queued=0,
        duplicates=[],
        errors=[],
        dry_run=bool(dry_run),
        anchors=[],
    )


def _build_bulk_anchor_row(item: BulkAnchorInput, index: int) -> dict[str, Any]:
    """Shape one `anchor_bulk()` input into the wire (snake_case) row shape,
    fingerprinting `data` rows client-side. Shared by `Arkova` and `AsyncArkova`
    — no I/O, so no async variant is needed.
    """
    has_fingerprint = item.fingerprint is not None
    has_data = item.data is not None
    if has_fingerprint == has_data:
        raise ArkovaError(
            f"anchor_bulk row {index}: provide exactly one of `fingerprint` or `data`"
            + (" (both were given)." if has_fingerprint else " (neither was given)."),
            status_code=400,
            code="invalid_request",
        )

    fp = item.fingerprint if has_fingerprint else _compute_fingerprint(item.data)  # type: ignore[arg-type]

    row: dict[str, Any] = {"fingerprint": fp}
    if item.credential_type is not None:
        row["credential_type"] = item.credential_type
    if item.description is not None:
        row["description"] = item.description
    if item.original_document_date is not None:
        row["original_document_date"] = item.original_document_date
    if item.document_type is not None:
        row["document_type"] = item.document_type
    if item.matter_or_case_ref is not None:
        row["matter_or_case_ref"] = item.matter_or_case_ref
    if item.external_id is not None:
        row["external_id"] = item.external_id
    return row


def _build_bulk_anchor_payload(
    inputs: Sequence[BulkAnchorInput],
    *,
    dry_run: bool | None,
    duplicate_strategy: BulkAnchorDuplicateStrategy | None,
    batch_id: str | None,
) -> dict[str, Any]:
    if len(inputs) > BULK_ANCHOR_MAX_ROWS:
        raise ArkovaError(
            f"anchor_bulk accepts at most {BULK_ANCHOR_MAX_ROWS} rows per call. "
            "Split into multiple calls (each with its own or a shared batch_id "
            "to correlate them in audit events).",
            status_code=400,
            code="batch_too_large",
        )

    payload: dict[str, Any] = {
        "anchors": [_build_bulk_anchor_row(item, i) for i, item in enumerate(inputs)],
    }
    if dry_run is not None:
        payload["dry_run"] = dry_run
    if duplicate_strategy is not None:
        payload["duplicate_strategy"] = duplicate_strategy
    if batch_id is not None:
        payload["batch_id"] = batch_id
    return payload


class Arkova:
    """Synchronous Arkova API v2 client."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 10.0,
        retries: int = 2,
        sleep: Callable[[float], None] = time.sleep,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._retries = retries
        self._sleep = sleep
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers=_headers(api_key),
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Arkova":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def fingerprint(self, data: str | bytes) -> str:
        """Compute a SHA-256 fingerprint of `data`, in-process (no network call)."""
        return _compute_fingerprint(data)

    def anchor(
        self,
        data: str | bytes | None = None,
        *,
        fingerprint: str | None = None,
    ) -> AnchorReceipt:
        """Anchor a document (HAKI-REQ-02) — `POST /api/v1/anchor`.

        Provide exactly one of `data` (raw content, fingerprinted client-side
        via `self.fingerprint()` before anything is sent) or `fingerprint` (a
        pre-computed 64-char hex SHA-256 you already have).

        The same fingerprint returns the same `public_id` — anchoring
        identical content twice is a no-op.
        """
        fp = _resolve_anchor_fingerprint(data=data, fingerprint=fingerprint)
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor")
        return _parse_json(
            self._request("POST", path, json={"fingerprint": fp}),
            AnchorReceipt,
        )

    def anchor_bulk(
        self,
        inputs: Sequence[BulkAnchorInput],
        *,
        dry_run: bool | None = None,
        duplicate_strategy: BulkAnchorDuplicateStrategy | None = None,
        batch_id: str | None = None,
    ) -> BulkAnchorResponse:
        """Bulk-anchor up to `BULK_ANCHOR_MAX_ROWS` (1000) documents in one
        call (HAKI-REQ-02) — `POST /api/v1/anchor/bulk`.

        Each `BulkAnchorInput` row provides exactly one of `fingerprint` or
        `data` (fingerprinted client-side, same as `anchor()`); mixing both
        forms across rows in one call is supported.

        `dry_run` validates every row (including dedup checks) without
        queuing or deducting credits — the response's `anchors` is `[]` on a
        dry run. `duplicate_strategy` controls what happens when a
        fingerprint already exists in-batch or in your org; the server
        default is `"fail"` (409s the whole batch on any duplicate).

        Raises `ArkovaError(code="batch_too_large")` for more than
        `BULK_ANCHOR_MAX_ROWS` rows, or `code="invalid_request"` for a row
        with neither/both of `fingerprint`/`data` — both checked client-side,
        before any network call.
        """
        if len(inputs) == 0:
            return _empty_bulk_response(batch_id=batch_id, dry_run=dry_run)

        payload = _build_bulk_anchor_payload(
            inputs, dry_run=dry_run, duplicate_strategy=duplicate_strategy, batch_id=batch_id,
        )
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor/bulk")
        return _parse_json(
            self._request("POST", path, json=payload),
            BulkAnchorResponse,
        )

    def search(
        self,
        q: str,
        *,
        type: SearchType = "all",
        cursor: str | None = None,
        limit: int = 50,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": q, "type": type, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        return _parse_json(self._request("GET", "/search", params=params), SearchResponse)

    def verify(self, public_id: str) -> VerificationResult:
        path = _versioned_path(
            str(self._client.base_url),
            "v1",
            f"/verify/{quote(public_id, safe='')}",
        )
        return _parse_json(self._request("GET", path), VerificationResult)

    def get_merkle_proof(self, public_id: str) -> MerkleProofResponse:
        """PROOF-05 (SCRUM-2338): fetch the Merkle proof + additive proof_bundle.

        ``proof_bundle`` is ``None`` when the proof is incomplete.
        """
        path = _versioned_path(
            str(self._client.base_url),
            "v1",
            f"/verify/{quote(public_id, safe='')}/proof",
        )
        return _parse_json(self._request("GET", path), MerkleProofResponse)

    def verify_fingerprint(self, fingerprint: str) -> FingerprintVerification:
        return _parse_json(
            self._request("GET", f"/verify/{fingerprint}"),
            FingerprintVerification,
        )

    def get_anchor(self, public_id: str) -> Anchor:
        return _parse_json(self._request("GET", f"/anchors/{public_id}"), Anchor)

    def list_orgs(self) -> OrgList:
        return _parse_json(self._request("GET", "/orgs"), OrgList)

    # SCRUM-1584 — public-safe v2 detail surfaces.
    def get_organization(self, public_id: str) -> OrganizationDetail:
        return _parse_json(
            self._request("GET", f"/organizations/{public_id}"),
            OrganizationDetail,
        )

    def get_record(self, public_id: str) -> RecordDetail:
        return _parse_json(self._request("GET", f"/records/{public_id}"), RecordDetail)

    def get_fingerprint(self, fingerprint: str) -> FingerprintDetail:
        return _parse_json(
            self._request("GET", f"/fingerprints/{fingerprint}"),
            FingerprintDetail,
        )

    def get_document(self, public_id: str) -> DocumentDetail:
        return _parse_json(self._request("GET", f"/documents/{public_id}"), DocumentDetail)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any | None = None,
    ) -> httpx.Response:
        for attempt in range(self._retries + 1):
            response = self._client.request(method, path, params=params, json=json)
            if response.status_code not in RETRYABLE_STATUSES or attempt >= self._retries:
                _raise_for_error(response)
                return response

            self._sleep(_retry_after(response.headers.get("Retry-After")) or 2**attempt)

        raise ArkovaError("Arkova API request failed after retries")


class AsyncArkova:
    """Asynchronous Arkova API v2 client."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 10.0,
        retries: int = 2,
        sleep: Callable[[float], Any] = asyncio.sleep,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._retries = retries
        self._sleep = sleep
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers=_headers(api_key),
            timeout=timeout,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncArkova":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def fingerprint(self, data: str | bytes) -> str:
        """Compute a SHA-256 fingerprint of `data`, in-process (no network call)."""
        return _compute_fingerprint(data)

    async def anchor(
        self,
        data: str | bytes | None = None,
        *,
        fingerprint: str | None = None,
    ) -> AnchorReceipt:
        """Anchor a document (HAKI-REQ-02) — `POST /api/v1/anchor`.

        Provide exactly one of `data` (raw content, fingerprinted client-side
        via `self.fingerprint()` before anything is sent) or `fingerprint` (a
        pre-computed 64-char hex SHA-256 you already have).
        """
        fp = _resolve_anchor_fingerprint(data=data, fingerprint=fingerprint)
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor")
        return _parse_json(
            await self._request("POST", path, json={"fingerprint": fp}),
            AnchorReceipt,
        )

    async def anchor_bulk(
        self,
        inputs: Sequence[BulkAnchorInput],
        *,
        dry_run: bool | None = None,
        duplicate_strategy: BulkAnchorDuplicateStrategy | None = None,
        batch_id: str | None = None,
    ) -> BulkAnchorResponse:
        """Bulk-anchor up to `BULK_ANCHOR_MAX_ROWS` (1000) documents in one
        call (HAKI-REQ-02) — `POST /api/v1/anchor/bulk`. See the sync
        `Arkova.anchor_bulk()` docstring for the full option/error contract.
        """
        if len(inputs) == 0:
            return _empty_bulk_response(batch_id=batch_id, dry_run=dry_run)

        payload = _build_bulk_anchor_payload(
            inputs, dry_run=dry_run, duplicate_strategy=duplicate_strategy, batch_id=batch_id,
        )
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor/bulk")
        return _parse_json(
            await self._request("POST", path, json=payload),
            BulkAnchorResponse,
        )

    async def search(
        self,
        q: str,
        *,
        type: SearchType = "all",
        cursor: str | None = None,
        limit: int = 50,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": q, "type": type, "limit": limit}
        if cursor:
            params["cursor"] = cursor
        return _parse_json(await self._request("GET", "/search", params=params), SearchResponse)

    async def verify(self, public_id: str) -> VerificationResult:
        path = _versioned_path(
            str(self._client.base_url),
            "v1",
            f"/verify/{quote(public_id, safe='')}",
        )
        return _parse_json(await self._request("GET", path), VerificationResult)

    async def get_merkle_proof(self, public_id: str) -> MerkleProofResponse:
        """PROOF-05 (SCRUM-2338): fetch the Merkle proof + additive proof_bundle.

        ``proof_bundle`` is ``None`` when the proof is incomplete.
        """
        path = _versioned_path(
            str(self._client.base_url),
            "v1",
            f"/verify/{quote(public_id, safe='')}/proof",
        )
        return _parse_json(await self._request("GET", path), MerkleProofResponse)

    async def verify_fingerprint(self, fingerprint: str) -> FingerprintVerification:
        return _parse_json(
            await self._request("GET", f"/verify/{fingerprint}"),
            FingerprintVerification,
        )

    async def get_anchor(self, public_id: str) -> Anchor:
        return _parse_json(await self._request("GET", f"/anchors/{public_id}"), Anchor)

    async def list_orgs(self) -> OrgList:
        return _parse_json(await self._request("GET", "/orgs"), OrgList)

    # SCRUM-1584 — public-safe v2 detail surfaces (async).
    async def get_organization(self, public_id: str) -> OrganizationDetail:
        return _parse_json(
            await self._request("GET", f"/organizations/{public_id}"),
            OrganizationDetail,
        )

    async def get_record(self, public_id: str) -> RecordDetail:
        return _parse_json(await self._request("GET", f"/records/{public_id}"), RecordDetail)

    async def get_fingerprint(self, fingerprint: str) -> FingerprintDetail:
        return _parse_json(
            await self._request("GET", f"/fingerprints/{fingerprint}"),
            FingerprintDetail,
        )

    async def get_document(self, public_id: str) -> DocumentDetail:
        return _parse_json(
            await self._request("GET", f"/documents/{public_id}"),
            DocumentDetail,
        )

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any | None = None,
    ) -> httpx.Response:
        for attempt in range(self._retries + 1):
            response = await self._client.request(method, path, params=params, json=json)
            if response.status_code not in RETRYABLE_STATUSES or attempt >= self._retries:
                _raise_for_error(response)
                return response

            maybe_awaitable = self._sleep(
                _retry_after(response.headers.get("Retry-After")) or 2**attempt
            )
            if hasattr(maybe_awaitable, "__await__"):
                await maybe_awaitable

        raise ArkovaError("Arkova API request failed after retries")
