"""Arkova SDK — Anchor and verify data integrity on Bitcoin."""

from arkova.client import (
    ArkovaClient,
    ArkovaError,
    VERIFY_BATCH_MAX_SIZE,
    VERIFY_BATCH_SYNC_LIMIT,
)
from arkova.types import (
    AnchorProof,
    AnchorReceipt,
    BatchJob,
    BatchVerificationResult,
    NessieCitation,
    NessieContextResult,
    NessieQueryResult,
    NessieResult,
    PaginatedWebhooks,
    VerificationResult,
    WebhookEndpoint,
    WebhookEndpointWithSecret,
    WebhookTestResult,
)

__all__ = [
    "ArkovaClient",
    "ArkovaError",
    "VERIFY_BATCH_MAX_SIZE",
    "VERIFY_BATCH_SYNC_LIMIT",
    "AnchorProof",
    "AnchorReceipt",
    "BatchJob",
    "BatchVerificationResult",
    "NessieCitation",
    "NessieContextResult",
    "NessieQueryResult",
    "NessieResult",
    "PaginatedWebhooks",
    "VerificationResult",
    "WebhookEndpoint",
    "WebhookEndpointWithSecret",
    "WebhookTestResult",
]
__version__ = "0.3.0"
