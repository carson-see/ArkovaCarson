"""Typed dataclasses mirroring the TypeScript SDK shape (INT-04 / INT-01)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class AnchorReceipt:
    """Receipt returned by POST /api/v1/anchor.

    Mirrors `AnchorReceipt` in `packages/sdk/src/types.ts`.
    """

    public_id: str
    fingerprint: str
    status: str  # "PENDING" | "BROADCASTING" | "SUBMITTED" | "SECURED"
    created_at: str
    record_uri: Optional[str] = None


@dataclass(frozen=True)
class VerificationResult:
    """Result returned by GET /api/v1/verify/{publicId}.

    `verified` is the single boolean a verifier should branch on. The other
    fields are display metadata. Mirrors `VerificationResult` in
    `packages/sdk/src/types.ts`.
    """

    verified: bool
    public_id: str
    fingerprint: str
    status: str
    anchor_timestamp: str
    credential_type: Optional[str] = None
    issuer_org_name: Optional[str] = None
    chain_tx_id: Optional[str] = None
    block_height: Optional[int] = None
    revoked_at: Optional[str] = None
