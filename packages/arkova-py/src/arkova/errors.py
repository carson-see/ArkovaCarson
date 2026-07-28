from __future__ import annotations

from .models import ProblemDetail


class ArkovaError(Exception):
    """Raised for Arkova API errors.

    ``code`` is the machine-readable error code (e.g. ``"insufficient_credits"``,
    ``"duplicate_fingerprints"``, ``"batch_too_large"``, ``"invalid_request"``) —
    populated from the plain-JSON ``error`` field on v1 write-path errors, or
    from the RFC 7807 ``type`` slug when the response is a v2 problem document.
    Client-side validation errors raised before any network call (e.g. an
    over-cap ``anchor_bulk`` input) also set ``code``, with ``status_code``
    set to the status the server would have returned (``400``) even though
    no request was actually made.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
        problem: ProblemDetail | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.problem = problem
        self.retry_after = retry_after
