from __future__ import annotations

from .models import ProblemDetail


class ArkovaError(Exception):
    """Raised for Arkova API errors."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        problem: ProblemDetail | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.problem = problem
        self.retry_after = retry_after
