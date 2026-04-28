"""Typed error class for the Arkova Python SDK."""

from __future__ import annotations

from typing import Any, Optional


class ArkovaError(Exception):
    """Raised on non-2xx responses from the Arkova API.

    Mirrors `ArkovaError` in `packages/sdk/src/errors.ts`. The HTTP status
    code, server-supplied error code, and optional details payload are
    preserved so callers can branch on `error.code == "rate_limited"` rather
    than parsing message strings.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        code: Optional[str] = None,
        details: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details

    def __repr__(self) -> str:
        return (
            f"ArkovaError(message={self.args[0]!r}, status={self.status}, "
            f"code={self.code!r})"
        )
