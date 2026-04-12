"""Type definitions for Arkova SDK responses.

All types use frozen dataclasses for immutability and hashability.
"""

from dataclasses import dataclass, field
from typing import List, Optional


# ── Anchor & Verification ─────────────────────────────────────────────

@dataclass(frozen=True)
class AnchorReceipt:
    """Receipt returned after submitting data for anchoring."""

    public_id: str
    fingerprint: str
    status: str  # PENDING | SUBMITTED | SECURED
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
    issued_date: Optional[str] = None
    expiry_date: Optional[str] = None
    error: Optional[str] = None


# ── Webhooks ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class WebhookEndpoint:
    """Webhook endpoint metadata."""

    id: str
    url: str
    events: List[str]
    is_active: bool
    description: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass(frozen=True)
class WebhookEndpointWithSecret(WebhookEndpoint):
    """Webhook endpoint with signing secret — returned only at creation time."""

    secret: str = ""
    warning: str = ""


@dataclass(frozen=True)
class PaginatedWebhooks:
    """Paginated list of webhook endpoints."""

    webhooks: List[WebhookEndpoint] = field(default_factory=list)
    total: int = 0
    limit: int = 50
    offset: int = 0


@dataclass(frozen=True)
class WebhookTestResult:
    """Result of sending a test webhook event."""

    success: bool
    status_code: int
    event_id: str


# ── Nessie Intelligence ───────────────────────────────────────────────

@dataclass(frozen=True)
class AnchorProof:
    """Chain anchor proof for a public record."""

    chain_tx_id: Optional[str] = None
    content_hash: str = ""


@dataclass(frozen=True)
class NessieResult:
    """A single result from Nessie RAG retrieval."""

    record_id: str
    source: str
    source_url: str
    record_type: str
    title: Optional[str] = None
    relevance_score: float = 0.0
    anchor_proof: Optional[AnchorProof] = None


@dataclass(frozen=True)
class NessieQueryResult:
    """Nessie RAG retrieval response."""

    results: List[NessieResult] = field(default_factory=list)
    count: int = 0
    query: str = ""


@dataclass(frozen=True)
class NessieCitation:
    """A citation from Nessie context mode."""

    record_id: str
    source: str
    source_url: str
    title: Optional[str] = None
    relevance_score: float = 0.0
    excerpt: str = ""
    anchor_proof: Optional[AnchorProof] = None


@dataclass(frozen=True)
class NessieContextResult:
    """Nessie verified context response."""

    answer: str = ""
    citations: List[NessieCitation] = field(default_factory=list)
    confidence: float = 0.0
    model: str = ""
    query: str = ""
