"""Type definitions for Arkova SDK responses."""

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class AnchorReceipt:
    """Receipt returned after submitting data for anchoring."""

    public_id: str
    fingerprint: str
    status: str
    created_at: str
    record_uri: str


@dataclass(frozen=True)
class VerificationResult:
    """Result of verifying a public_id or fingerprint."""

    verified: bool
    status: Optional[str] = None
    issuer_name: Optional[str] = None
    credential_type: Optional[str] = None
    anchor_timestamp: Optional[str] = None
    bitcoin_block: Optional[int] = None
    network_receipt_id: Optional[str] = None
    record_uri: Optional[str] = None
    explorer_url: Optional[str] = None
    description: Optional[str] = None
    error: Optional[str] = None
