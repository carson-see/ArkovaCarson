from __future__ import annotations

import asyncio
import email.utils
import hashlib
import re
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version
from typing import Any, Literal, TypeVar
from urllib.parse import quote, urlparse

import httpx
from pydantic import ValidationError

from .errors import ArkovaError
from .models import (
    Agent,
    AgentKeyCreated,
    AgentList,
    AgentRevocation,
    Anchor,
    AnchorImportResponse,
    AnchorImportRow,
    AnchorListResponse,
    AnchorReceipt,
    AnchorSubmissionStatus,
    BulkAnchorDuplicateStrategy,
    BulkAnchorInput,
    BulkAnchorResponse,
    ComputeIdAdmissionResult,
    DocumentDetail,
    FingerprintDetail,
    FingerprintVerification,
    Folder,
    FolderEnvelope,
    FolderList,
    FolderMoveResult,
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
ANCHOR_IMPORT_MAX_ROWS = 100

try:
    _VERSION = _package_version("arkova")
except PackageNotFoundError:  # running from a source tree without an install
    _VERSION = "unknown"
T = TypeVar("T")


class _Unset:
    pass


_UNSET = _Unset()

_AGENT_TYPES = {"llm_agent", "ats_integration", "hr_platform", "compliance_tool", "custom"}
_AGENT_SCOPES = {"read:records", "read:orgs", "read:search", "write:anchors", "admin:rules", "verify", "verify:batch", "usage:read", "keys:manage", "compliance:read", "compliance:write", "oracle:read", "oracle:write", "anchor:write", "anchor:read", "attestations:write", "attestations:read", "webhooks:manage", "agents:manage", "keys:read", "orgs:manage"}
_COMPUTEID_SCOPES = {"verify", "verify:batch", "anchor:write", "write:anchors", "anchor:read", "read:records", "read:search"}
_ZONED_RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$")


def _anchor_list_params(
    since: str | None, until: str | None, tag: str | None,
    tag_scope: Literal["user", "organization"] | None, limit: int,
    cursor: str | None,
) -> dict[str, Any]:
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ArkovaError("limit must be between 1 and 100", status_code=400, code="invalid_anchor_list_query")
    if (tag is None) != (tag_scope is None):
        raise ArkovaError("tag and tag_scope must be provided together", status_code=400, code="invalid_anchor_list_query")
    if tag is not None and (not isinstance(tag, str) or not 1 <= len(tag) <= 64):
        raise ArkovaError("tag must contain 1 to 64 characters", status_code=400, code="invalid_anchor_list_query")
    if tag_scope is not None and tag_scope not in {"user", "organization"}:
        raise ArkovaError("tag_scope must be user or organization", status_code=400, code="invalid_anchor_list_query")
    params: dict[str, Any] = {"limit": limit}
    for field, value in (("since", since), ("until", until)):
        if value is not None:
            if not isinstance(value, str) or not _ZONED_RFC3339.fullmatch(value):
                raise ArkovaError(f"{field} must be an RFC3339 timestamp with a timezone", status_code=400, code="invalid_anchor_list_query")
            try:
                datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ArkovaError(f"{field} must be an RFC3339 timestamp with a timezone", status_code=400, code="invalid_anchor_list_query") from exc
            params[field] = value
    if tag is not None:
        params.update({"tag": tag, "tag_scope": tag_scope})
    if cursor is not None:
        if not isinstance(cursor, str) or not 1 <= len(cursor) <= 2048:
            raise ArkovaError("cursor must be a non-empty string", status_code=400, code="invalid_anchor_list_query")
        params["cursor"] = cursor
    return params


def _validate_agent_values(*, name: str | None = None, agent_type: str | None = None,
                           scopes: Sequence[str] | None = None, callback_url: str | None = None,
                           description: str | None = None, framework: str | None = None,
                           version: str | None = None,
                           allowed_scopes: set[str] = _AGENT_SCOPES) -> None:
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 200):
        raise ArkovaError("Invalid agent name", status_code=400, code="invalid_request")
    if description is not None and (not isinstance(description, str) or len(description) > 1000):
        raise ArkovaError("Invalid agent description", status_code=400, code="invalid_request")
    if framework is not None and (not isinstance(framework, str) or len(framework) > 100):
        raise ArkovaError("Invalid agent framework", status_code=400, code="invalid_request")
    if version is not None and (not isinstance(version, str) or len(version) > 50):
        raise ArkovaError("Invalid agent version", status_code=400, code="invalid_request")
    if agent_type is not None and agent_type not in _AGENT_TYPES:
        raise ArkovaError("Invalid agent type", status_code=400, code="invalid_request")
    if scopes is not None and (not scopes or len(scopes) > 32 or any(scope not in allowed_scopes for scope in scopes)):
        raise ArkovaError("Invalid agent scope", status_code=400, code="invalid_request")
    if callback_url is not None:
        parsed = urlparse(callback_url)
        if parsed.scheme != "https" or not parsed.netloc or any(character.isspace() for character in parsed.netloc):
            raise ArkovaError("Agent callback URL must be a valid HTTPS URL", status_code=400, code="invalid_request")


def _agent_create_body(
    *, name: str, description: str | None, agent_type: str | None,
    allowed_scopes: Sequence[str] | None, framework: str | None,
    version: str | None, callback_url: str | None,
    metadata: Mapping[str, Any] | None,
) -> dict[str, Any]:
    _validate_agent_values(name=name, agent_type=agent_type, scopes=allowed_scopes, callback_url=callback_url,
        description=description, framework=framework, version=version)
    if metadata is not None and "computeid" in metadata:
        raise ArkovaError("metadata.computeid is provider-managed", status_code=400, code="invalid_request")
    return {"name": name, **({"description": description} if description is not None else {}),
        **({"agent_type": agent_type} if agent_type is not None else {}),
        **({"allowed_scopes": list(allowed_scopes)} if allowed_scopes is not None else {}),
        **({"framework": framework} if framework is not None else {}),
        **({"version": version} if version is not None else {}),
        **({"callback_url": callback_url} if callback_url is not None else {}),
        **({"metadata": dict(metadata)} if metadata is not None else {})}


def _agent_update_body(**values: Any) -> dict[str, Any]:
    body = {key: value for key, value in values.items() if not isinstance(value, _Unset)}
    if not body:
        raise ArkovaError("Agent update requires at least one field", status_code=400, code="invalid_request")
    if "allowed_scopes" in body:
        _validate_agent_values(scopes=body["allowed_scopes"])
        body["allowed_scopes"] = list(body["allowed_scopes"])
    if body.get("status") not in (None, "active", "suspended"):
        raise ArkovaError("Invalid agent status", status_code=400, code="invalid_request")
    if "callback_url" in body:
        _validate_agent_values(callback_url=body["callback_url"])
    _validate_agent_values(name=body.get("name"), description=body.get("description"),
        framework=body.get("framework"), version=body.get("version"))
    return body


def _computeid_admission_body(
    *, passport_id: str, verification_receipt: Mapping[str, Any], name: str | None,
    description: str | None, allowed_scopes: Sequence[str] | None,
) -> dict[str, Any]:
    def timestamp(value: Any) -> bool:
        if not isinstance(value, str) or not 1 <= len(value) <= 64:
            return False
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
            return True
        except ValueError:
            return False

    status = verification_receipt.get("status")
    signature_valid = verification_receipt.get("signature_valid")
    if (not isinstance(passport_id, str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}", passport_id)
            or str(verification_receipt.get("passport_id", "")).lower() != passport_id.lower()
            or not isinstance(status, str) or not 1 <= len(status) <= 32
            or signature_valid is not None and not isinstance(signature_valid, bool)
            or not timestamp(verification_receipt.get("issued_at")) or not timestamp(verification_receipt.get("expires_at"))
            or not isinstance(verification_receipt.get("key_id"), str) or not re.fullmatch(r"[0-9a-f]{16}", verification_receipt["key_id"])
            or not isinstance(verification_receipt.get("receipt_signature"), str) or not 1 <= len(verification_receipt["receipt_signature"]) <= 4096
            or not isinstance(verification_receipt.get("receipt_algorithm"), str) or not 1 <= len(verification_receipt["receipt_algorithm"]) <= 32
            or not isinstance(verification_receipt.get("receipt_payload"), str) or not 2 <= len(verification_receipt["receipt_payload"]) <= 16_384):
        raise ArkovaError("Invalid ComputeID admission receipt", status_code=400, code="invalid_request")
    _validate_agent_values(name=name, description=description, scopes=allowed_scopes, allowed_scopes=_COMPUTEID_SCOPES)
    return {"passport_id": passport_id, "verification_receipt": dict(verification_receipt),
        **({"name": name} if name is not None else {}),
        **({"description": description} if description is not None else {}),
        **({"allowed_scopes": list(allowed_scopes)} if allowed_scopes is not None else {})}


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


def _scope_error_details(source: dict[str, Any]) -> dict[str, Any]:
    """Bounded permission details; never turn a malformed list into partial authority."""
    def is_scope(value: object) -> bool:
        return isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9:._-]{1,80}", value) is not None

    details: dict[str, Any] = {}
    if is_scope(source.get("required")):
        details["required"] = source["required"]
    for field in ("granted", "missing", "permitted"):
        scopes = source.get(field)
        if isinstance(scopes, list) and len(scopes) <= 32 and all(is_scope(value) for value in scopes):
            details[field] = scopes
    return details


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
    nested_raw = raw_code if isinstance(raw_code, dict) else None
    nested = ({key: value for key in ("code", "message", "reason", "agent_id")
        if isinstance((value := nested_raw.get(key)), str)} if nested_raw is not None else None)
    scope_details = _scope_error_details(nested_raw if nested_raw is not None else body)
    if scope_details:
        nested = {**(nested or {}), **scope_details}
    code = raw_code if isinstance(raw_code, str) else (
        nested.get("code") if nested and isinstance(nested.get("code"), str) else None
    )
    raw_message = body.get("message")
    nested_message = nested.get("message") if nested else None
    message = (
        nested_message
        if isinstance(nested_message, str) and nested_message
        else raw_message
        if isinstance(raw_message, str) and raw_message
        else code or f"Arkova API error {response.status_code}"
    )
    raise ArkovaError(
        message,
        status_code=response.status_code,
        code=code,
        retry_after=retry_after,
        details=nested,
    )


def _parse_json(response: httpx.Response, model: type[T]) -> T:
    sensitive = model in (AgentKeyCreated, ComputeIdAdmissionResult)
    try:
        return model.model_validate(response.json())  # type: ignore[attr-defined]
    except (ValueError, ValidationError) as exc:
        if not sensitive:
            raise ArkovaError("Arkova API returned an unexpected response shape", code="unexpected_response") from exc
    # Raise outside the handler so the discarded validation exception is not
    # retained as __context__ with the raw one-time key or signed receipt.
    raise ArkovaError("Arkova API returned an unexpected response shape", code="unexpected_response")


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


def _build_anchor_import_payload(
    rows: Sequence[AnchorImportRow],
    action: Literal["queue", "instant"],
    description: str | None,
    user_tags: Sequence[str],
    organization_tags: Sequence[str],
) -> dict[str, Any]:
    if action not in ("queue", "instant"):
        raise ArkovaError(
            "anchor_import action must be queue or instant",
            status_code=400,
            code="invalid_request",
        )
    if not 1 <= len(rows) <= ANCHOR_IMPORT_MAX_ROWS:
        raise ArkovaError(
            "anchor_import accepts 1-100 rows", status_code=400, code="invalid_request"
        )
    if description is not None and len(description) > 1000:
        raise ArkovaError(
            "anchor_import description exceeds 1000 characters",
            status_code=400,
            code="invalid_request",
        )
    wire_rows: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if (
            len(row.fingerprint) != 64
            or any(char not in "0123456789abcdefABCDEF" for char in row.fingerprint)
            or not 1 <= len(row.filename) <= 255
            or not isinstance(row.fingerprint_provided, bool)
        ):
            raise ArkovaError(
                f"anchor_import row {index} is invalid", status_code=400, code="invalid_request"
            )
        wire = {
            "fingerprint": row.fingerprint.lower(),
            "filename": row.filename,
            "fingerprint_provided": row.fingerprint_provided,
        }
        for key in (
            "file_size",
            "credential_type",
            "metadata",
            "recipient_email",
            "recipient_name",
        ):
            value = getattr(row, key)
            if value is not None:
                wire[key] = value
        wire_rows.append(wire)
    payload: dict[str, Any] = {"action": action, "rows": wire_rows}
    if description is not None:
        payload["description"] = description
    if user_tags or organization_tags:
        payload["private_tags"] = {"user": list(user_tags), "organization": list(organization_tags)}
    return payload


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

    # PYI034 wants `Self`, which is typing.Self (3.11+); this package supports
    # 3.10 and carries no typing_extensions dependency. Returning the concrete
    # class is the correct annotation for the minimum supported interpreter.
    def __enter__(self) -> Arkova:  # noqa: PYI034
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
        description: str | None = None,
        action: Literal["queue", "instant"] = "queue",
        user_tags: Sequence[str] | None = None,
        organization_tags: Sequence[str] | None = None,
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
        body: dict[str, object] = {"fingerprint": fp}
        if action != "queue":
            body["action"] = action
        if description is not None:
            body["description"] = description
        if user_tags is not None or organization_tags is not None:
            body["private_tags"] = {
                "user": list(user_tags or ()),
                "organization": list(organization_tags or ()),
            }
        return _parse_json(
            self._request("POST", path, json=body),
            AnchorReceipt,
        )

    def get_anchor_submission_status(self, public_id: str) -> AnchorSubmissionStatus:
        """Read this API key actor's durable queue/instant submission state."""
        path = _versioned_path(
            str(self._client.base_url),
            "v1",
            f"/anchor/{quote(public_id, safe='')}/submission-status",
        )
        return _parse_json(self._request("GET", path), AnchorSubmissionStatus)

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
            inputs,
            dry_run=dry_run,
            duplicate_strategy=duplicate_strategy,
            batch_id=batch_id,
        )
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor/bulk")
        return _parse_json(
            self._request("POST", path, json=payload),
            BulkAnchorResponse,
        )

    def anchor_import(
        self,
        rows: Sequence[AnchorImportRow],
        *,
        action: Literal["queue", "instant"],
        description: str | None = None,
        user_tags: Sequence[str] = (),
        organization_tags: Sequence[str] = (),
    ) -> AnchorImportResponse:
        payload = _build_anchor_import_payload(
            rows, action, description, user_tags, organization_tags
        )
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor/import")
        response = self._client.request("POST", path, json=payload)
        _raise_for_error(response)
        return _parse_json(response, AnchorImportResponse)

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

    def list_anchors(
        self, *, since: str | None = None, until: str | None = None,
        tag: str | None = None, tag_scope: Literal["user", "organization"] | None = None,
        limit: int = 50, cursor: str | None = None,
    ) -> AnchorListResponse:
        """List private anchors visible to this API key's current organization."""
        params = _anchor_list_params(since, until, tag, tag_scope, limit, cursor)
        path = _versioned_path(str(self._client.base_url), "v1", "/anchors")
        return _parse_json(self._request("GET", path, params=params), AnchorListResponse)

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

    def list_folders(
        self, *, owner_scope: Literal["USER", "ORG"] = "ORG", owner_user_id: str | None = None,
        org_id: str | None = None, context_org_id: str | None = None,
    ) -> FolderList:
        params = {"owner_scope": owner_scope}
        if owner_user_id is not None: params["owner_user_id"] = owner_user_id
        if org_id is not None: params["org_id"] = org_id
        if context_org_id is not None: params["context_org_id"] = context_org_id
        path = _versioned_path(str(self._client.base_url), "v1", "/folders")
        return _parse_json(self._request("GET", path, params=params), FolderList)

    def create_folder(
        self, *, name: str, owner_scope: Literal["USER", "ORG"], org_id: str | None = None,
        context_org_id: str | None = None, parent_folder_id: str | None = None,
    ) -> Folder:
        path = _versioned_path(str(self._client.base_url), "v1", "/folders")
        response = self._request("POST", path, json={"name": name, "owner_scope": owner_scope,
            "org_id": org_id, "context_org_id": context_org_id, "parent_folder_id": parent_folder_id},
            retryable=False)
        return _parse_json(response, FolderEnvelope).folder

    def update_folder(
        self, folder_id: str, *, name: str | None = None,
        parent_folder_id: str | None | _Unset = _UNSET,
    ) -> Folder:
        path = _versioned_path(str(self._client.base_url), "v1", f"/folders/{quote(folder_id, safe='')}")
        body: dict[str, Any] = {}
        if name is not None: body["name"] = name
        if not isinstance(parent_folder_id, _Unset): body["parent_folder_id"] = parent_folder_id
        if not body: raise ArkovaError("Folder update requires name or parent_folder_id", code="invalid_request")
        response = self._request("PATCH", path, json=body, retryable=False)
        return _parse_json(response, FolderEnvelope).folder

    def bind_folder_connector(
        self, folder_id: str, *, provider: Literal["google_drive", "docusign"] | None,
        source_id: str | None, connection_id: str | None,
    ) -> Folder:
        path = _versioned_path(str(self._client.base_url), "v1", f"/folders/{quote(folder_id, safe='')}/connector")
        response = self._request("PUT", path, json={"provider": provider, "source_id": source_id,
            "connection_id": connection_id}, retryable=False)
        return _parse_json(response, FolderEnvelope).folder

    def delete_folder(self, folder_id: str) -> None:
        path = _versioned_path(str(self._client.base_url), "v1", f"/folders/{quote(folder_id, safe='')}")
        self._request("DELETE", path, retryable=False)

    def move_records(self, anchor_ids: Sequence[str], folder_id: str | None) -> FolderMoveResult:
        path = _versioned_path(str(self._client.base_url), "v1", "/folders/bulk-move")
        return _parse_json(self._request("POST", path, json={"anchor_ids": list(anchor_ids),
            "folder_id": folder_id}, retryable=False), FolderMoveResult)

    def move_records_by_public_id(self, record_public_ids: Sequence[str], folder_id: str | None) -> FolderMoveResult:
        path = _versioned_path(str(self._client.base_url), "v1", "/folders/bulk-move")
        return _parse_json(self._request("POST", path, json={"record_public_ids": list(record_public_ids),
            "folder_id": folder_id}, retryable=False), FolderMoveResult)

    def register_agent(self, *, name: str, description: str | None = None, agent_type: str | None = None,
        allowed_scopes: Sequence[str] | None = None, framework: str | None = None,
        version: str | None = None, callback_url: str | None = None,
        metadata: Mapping[str, Any] | None = None) -> Agent:
        path = _versioned_path(str(self._client.base_url), "v1", "/agents")
        body = _agent_create_body(name=name, description=description, agent_type=agent_type,
            allowed_scopes=allowed_scopes, framework=framework, version=version,
            callback_url=callback_url, metadata=metadata)
        return _parse_json(self._request("POST", path, json=body, retryable=False), Agent)

    def list_agents(self) -> AgentList:
        return _parse_json(self._request("GET", _versioned_path(str(self._client.base_url), "v1", "/agents")), AgentList)

    def get_agent(self, agent_id: str) -> Agent:
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}")
        return _parse_json(self._request("GET", path), Agent)

    def update_agent(self, agent_id: str, *, name: str | _Unset = _UNSET,
        description: str | _Unset = _UNSET, allowed_scopes: Sequence[str] | _Unset = _UNSET,
        status: Literal["active", "suspended"] | _Unset = _UNSET, framework: str | _Unset = _UNSET,
        version: str | _Unset = _UNSET, callback_url: str | None | _Unset = _UNSET) -> Agent:
        body = _agent_update_body(name=name, description=description, allowed_scopes=allowed_scopes,
            status=status, framework=framework, version=version, callback_url=callback_url)
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}")
        return _parse_json(self._request("PATCH", path, json=body, retryable=False), Agent)

    def revoke_agent(self, agent_id: str) -> AgentRevocation:
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}")
        return _parse_json(self._request("DELETE", path, retryable=False), AgentRevocation)

    def create_agent_key(self, agent_id: str) -> AgentKeyCreated:
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}/key")
        return _parse_json(self._request("POST", path, retryable=False), AgentKeyCreated)

    def admit_computeid_agent(self, *, passport_id: str, verification_receipt: Mapping[str, Any],
        name: str | None = None, description: str | None = None,
        allowed_scopes: Sequence[str] | None = None) -> ComputeIdAdmissionResult:
        path = _versioned_path(str(self._client.base_url), "v1", "/agents/computeid/admit")
        body = _computeid_admission_body(passport_id=passport_id, verification_receipt=verification_receipt,
            name=name, description=description, allowed_scopes=allowed_scopes)
        return _parse_json(self._request("POST", path, json=body, retryable=False), ComputeIdAdmissionResult)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any | None = None,
        retryable: bool = True,
    ) -> httpx.Response:
        for attempt in range(self._retries + 1):
            response = self._client.request(method, path, params=params, json=json)
            if not retryable or response.status_code not in RETRYABLE_STATUSES or attempt >= self._retries:
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

    # See the `__enter__` note above: `Self` is 3.11+, this package supports 3.10.
    async def __aenter__(self) -> AsyncArkova:  # noqa: PYI034
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
        description: str | None = None,
        action: Literal["queue", "instant"] = "queue",
        user_tags: Sequence[str] | None = None,
        organization_tags: Sequence[str] | None = None,
    ) -> AnchorReceipt:
        """Anchor a document (HAKI-REQ-02) — `POST /api/v1/anchor`.

        Provide exactly one of `data` (raw content, fingerprinted client-side
        via `self.fingerprint()` before anything is sent) or `fingerprint` (a
        pre-computed 64-char hex SHA-256 you already have).
        """
        fp = _resolve_anchor_fingerprint(data=data, fingerprint=fingerprint)
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor")
        body: dict[str, object] = {"fingerprint": fp}
        if action != "queue":
            body["action"] = action
        if description is not None:
            body["description"] = description
        if user_tags is not None or organization_tags is not None:
            body["private_tags"] = {
                "user": list(user_tags or ()),
                "organization": list(organization_tags or ()),
            }
        return _parse_json(
            await self._request("POST", path, json=body),
            AnchorReceipt,
        )

    async def get_anchor_submission_status(self, public_id: str) -> AnchorSubmissionStatus:
        """Read this API key actor's durable queue/instant submission state."""
        path = _versioned_path(
            str(self._client.base_url),
            "v1",
            f"/anchor/{quote(public_id, safe='')}/submission-status",
        )
        return _parse_json(await self._request("GET", path), AnchorSubmissionStatus)

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
            inputs,
            dry_run=dry_run,
            duplicate_strategy=duplicate_strategy,
            batch_id=batch_id,
        )
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor/bulk")
        return _parse_json(
            await self._request("POST", path, json=payload),
            BulkAnchorResponse,
        )

    async def anchor_import(
        self,
        rows: Sequence[AnchorImportRow],
        *,
        action: Literal["queue", "instant"],
        description: str | None = None,
        user_tags: Sequence[str] = (),
        organization_tags: Sequence[str] = (),
    ) -> AnchorImportResponse:
        payload = _build_anchor_import_payload(
            rows, action, description, user_tags, organization_tags
        )
        path = _versioned_path(str(self._client.base_url), "v1", "/anchor/import")
        response = await self._client.request("POST", path, json=payload)
        _raise_for_error(response)
        return _parse_json(response, AnchorImportResponse)

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

    async def list_anchors(
        self, *, since: str | None = None, until: str | None = None,
        tag: str | None = None, tag_scope: Literal["user", "organization"] | None = None,
        limit: int = 50, cursor: str | None = None,
    ) -> AnchorListResponse:
        """List private anchors visible to this API key's current organization."""
        params = _anchor_list_params(since, until, tag, tag_scope, limit, cursor)
        path = _versioned_path(str(self._client.base_url), "v1", "/anchors")
        return _parse_json(await self._request("GET", path, params=params), AnchorListResponse)

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

    async def list_folders(
        self, *, owner_scope: Literal["USER", "ORG"] = "ORG", owner_user_id: str | None = None,
        org_id: str | None = None, context_org_id: str | None = None,
    ) -> FolderList:
        params = {"owner_scope": owner_scope}
        if owner_user_id is not None: params["owner_user_id"] = owner_user_id
        if org_id is not None: params["org_id"] = org_id
        if context_org_id is not None: params["context_org_id"] = context_org_id
        path = _versioned_path(str(self._client.base_url), "v1", "/folders")
        return _parse_json(await self._request("GET", path, params=params), FolderList)

    async def create_folder(
        self, *, name: str, owner_scope: Literal["USER", "ORG"], org_id: str | None = None,
        context_org_id: str | None = None, parent_folder_id: str | None = None,
    ) -> Folder:
        path = _versioned_path(str(self._client.base_url), "v1", "/folders")
        response = await self._request("POST", path, json={"name": name, "owner_scope": owner_scope,
            "org_id": org_id, "context_org_id": context_org_id, "parent_folder_id": parent_folder_id},
            retryable=False)
        return _parse_json(response, FolderEnvelope).folder

    async def update_folder(
        self, folder_id: str, *, name: str | None = None,
        parent_folder_id: str | None | _Unset = _UNSET,
    ) -> Folder:
        path = _versioned_path(str(self._client.base_url), "v1", f"/folders/{quote(folder_id, safe='')}")
        body: dict[str, Any] = {}
        if name is not None: body["name"] = name
        if not isinstance(parent_folder_id, _Unset): body["parent_folder_id"] = parent_folder_id
        if not body: raise ArkovaError("Folder update requires name or parent_folder_id", code="invalid_request")
        response = await self._request("PATCH", path, json=body, retryable=False)
        return _parse_json(response, FolderEnvelope).folder

    async def bind_folder_connector(
        self, folder_id: str, *, provider: Literal["google_drive", "docusign"] | None,
        source_id: str | None, connection_id: str | None,
    ) -> Folder:
        path = _versioned_path(str(self._client.base_url), "v1", f"/folders/{quote(folder_id, safe='')}/connector")
        response = await self._request("PUT", path, json={"provider": provider, "source_id": source_id,
            "connection_id": connection_id}, retryable=False)
        return _parse_json(response, FolderEnvelope).folder

    async def delete_folder(self, folder_id: str) -> None:
        path = _versioned_path(str(self._client.base_url), "v1", f"/folders/{quote(folder_id, safe='')}")
        await self._request("DELETE", path, retryable=False)

    async def move_records(self, anchor_ids: Sequence[str], folder_id: str | None) -> FolderMoveResult:
        path = _versioned_path(str(self._client.base_url), "v1", "/folders/bulk-move")
        return _parse_json(await self._request("POST", path, json={"anchor_ids": list(anchor_ids),
            "folder_id": folder_id}, retryable=False), FolderMoveResult)

    async def move_records_by_public_id(self, record_public_ids: Sequence[str], folder_id: str | None) -> FolderMoveResult:
        path = _versioned_path(str(self._client.base_url), "v1", "/folders/bulk-move")
        return _parse_json(await self._request("POST", path, json={"record_public_ids": list(record_public_ids),
            "folder_id": folder_id}, retryable=False), FolderMoveResult)

    async def register_agent(self, *, name: str, description: str | None = None, agent_type: str | None = None,
        allowed_scopes: Sequence[str] | None = None, framework: str | None = None,
        version: str | None = None, callback_url: str | None = None,
        metadata: Mapping[str, Any] | None = None) -> Agent:
        path = _versioned_path(str(self._client.base_url), "v1", "/agents")
        body = _agent_create_body(name=name, description=description, agent_type=agent_type,
            allowed_scopes=allowed_scopes, framework=framework, version=version,
            callback_url=callback_url, metadata=metadata)
        return _parse_json(await self._request("POST", path, json=body, retryable=False), Agent)

    async def list_agents(self) -> AgentList:
        return _parse_json(await self._request("GET", _versioned_path(str(self._client.base_url), "v1", "/agents")), AgentList)

    async def get_agent(self, agent_id: str) -> Agent:
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}")
        return _parse_json(await self._request("GET", path), Agent)

    async def update_agent(self, agent_id: str, *, name: str | _Unset = _UNSET,
        description: str | _Unset = _UNSET, allowed_scopes: Sequence[str] | _Unset = _UNSET,
        status: Literal["active", "suspended"] | _Unset = _UNSET, framework: str | _Unset = _UNSET,
        version: str | _Unset = _UNSET, callback_url: str | None | _Unset = _UNSET) -> Agent:
        body = _agent_update_body(name=name, description=description, allowed_scopes=allowed_scopes,
            status=status, framework=framework, version=version, callback_url=callback_url)
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}")
        return _parse_json(await self._request("PATCH", path, json=body, retryable=False), Agent)

    async def revoke_agent(self, agent_id: str) -> AgentRevocation:
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}")
        return _parse_json(await self._request("DELETE", path, retryable=False), AgentRevocation)

    async def create_agent_key(self, agent_id: str) -> AgentKeyCreated:
        path = _versioned_path(str(self._client.base_url), "v1", f"/agents/{quote(agent_id, safe='')}/key")
        return _parse_json(await self._request("POST", path, retryable=False), AgentKeyCreated)

    async def admit_computeid_agent(self, *, passport_id: str, verification_receipt: Mapping[str, Any],
        name: str | None = None, description: str | None = None,
        allowed_scopes: Sequence[str] | None = None) -> ComputeIdAdmissionResult:
        path = _versioned_path(str(self._client.base_url), "v1", "/agents/computeid/admit")
        body = _computeid_admission_body(passport_id=passport_id, verification_receipt=verification_receipt,
            name=name, description=description, allowed_scopes=allowed_scopes)
        return _parse_json(await self._request("POST", path, json=body, retryable=False), ComputeIdAdmissionResult)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any | None = None,
        retryable: bool = True,
    ) -> httpx.Response:
        for attempt in range(self._retries + 1):
            response = await self._client.request(method, path, params=params, json=json)
            if not retryable or response.status_code not in RETRYABLE_STATUSES or attempt >= self._retries:
                _raise_for_error(response)
                return response

            maybe_awaitable = self._sleep(
                _retry_after(response.headers.get("Retry-After")) or 2**attempt
            )
            if hasattr(maybe_awaitable, "__await__"):
                await maybe_awaitable

        raise ArkovaError("Arkova API request failed after retries")
