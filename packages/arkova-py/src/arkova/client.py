from __future__ import annotations

import asyncio
import email.utils
import time
from collections.abc import Callable, Mapping
from typing import Any, TypeVar

import httpx
from pydantic import ValidationError

from .errors import ArkovaError
from .models import (
    Anchor,
    FingerprintVerification,
    OrgList,
    ProblemDetail,
    SearchResponse,
    SearchType,
)

DEFAULT_BASE_URL = "https://api.arkova.ai/v2"
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
T = TypeVar("T")


def _headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "User-Agent": "arkova-python/0.1.0",
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


def _raise_for_error(response: httpx.Response) -> None:
    if response.status_code < 400:
        return

    problem = _problem(response)
    retry_after = _retry_after(response.headers.get("Retry-After"))
    message = (
        problem.detail or problem.title
        if problem
        else f"Arkova API error {response.status_code}"
    )
    raise ArkovaError(
        message,
        status_code=response.status_code,
        problem=problem,
        retry_after=retry_after,
    )


def _parse_json(response: httpx.Response, model: type[T]) -> T:
    try:
        return model.model_validate(response.json())  # type: ignore[attr-defined]
    except (ValueError, ValidationError) as exc:
        raise ArkovaError("Arkova API returned an unexpected response shape") from exc


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

    def verify_fingerprint(self, fingerprint: str) -> FingerprintVerification:
        return _parse_json(
            self._request("GET", f"/verify/{fingerprint}"),
            FingerprintVerification,
        )

    def get_anchor(self, public_id: str) -> Anchor:
        return _parse_json(self._request("GET", f"/anchors/{public_id}"), Anchor)

    def list_orgs(self) -> OrgList:
        return _parse_json(self._request("GET", "/orgs"), OrgList)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        for attempt in range(self._retries + 1):
            response = self._client.request(method, path, params=params)
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

    async def verify_fingerprint(self, fingerprint: str) -> FingerprintVerification:
        return _parse_json(
            await self._request("GET", f"/verify/{fingerprint}"),
            FingerprintVerification,
        )

    async def get_anchor(self, public_id: str) -> Anchor:
        return _parse_json(await self._request("GET", f"/anchors/{public_id}"), Anchor)

    async def list_orgs(self) -> OrgList:
        return _parse_json(await self._request("GET", "/orgs"), OrgList)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        for attempt in range(self._retries + 1):
            response = await self._client.request(method, path, params=params)
            if response.status_code not in RETRYABLE_STATUSES or attempt >= self._retries:
                _raise_for_error(response)
                return response

            maybe_awaitable = self._sleep(
                _retry_after(response.headers.get("Retry-After")) or 2**attempt
            )
            if hasattr(maybe_awaitable, "__await__"):
                await maybe_awaitable

        raise ArkovaError("Arkova API request failed after retries")
