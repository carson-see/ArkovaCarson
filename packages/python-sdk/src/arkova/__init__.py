"""
Arkova Python SDK — INT-04 (Doc 1: Integration Strategy v2).

Mirrors the @arkova/sdk TypeScript surface so cross-language consumers see the
same shape for anchor / verify / verifyBatch.
"""

from .client import Arkova, AsyncArkova
from .errors import ArkovaError
from .models import AnchorReceipt, VerificationResult

__all__ = [
    "Arkova",
    "AsyncArkova",
    "ArkovaError",
    "AnchorReceipt",
    "VerificationResult",
]

__version__ = "0.1.0"
