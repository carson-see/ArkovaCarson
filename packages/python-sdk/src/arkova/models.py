"""Typed dataclasses mirroring the TypeScript SDK shape (INT-04 / INT-01)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


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


@dataclass(frozen=True)
class AttestationEvidence:
    """Evidence item returned by GET /api/v1/attestations/{publicId}."""

    public_id: str
    evidence_type: str
    fingerprint: str
    created_at: str
    description: Optional[str] = None
    mime: Optional[str] = None
    size: Optional[int] = None


@dataclass(frozen=True)
class AttestorCredential:
    """Credential lineage item returned when include_credentials=True."""

    public_id: str
    status: str
    record_uri: str
    credential_type: Optional[str] = None
    fingerprint: Optional[str] = None
    version_number: Optional[int] = None
    parent_public_id: Optional[str] = None
    is_current: bool = False
    chain_proof: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class AttestationDetails:
    """Public attestation detail response.

    Evidence is always available when the API returns it. Attestor credentials
    are populated only when callers request include_credentials=True.
    """

    public_id: str
    attestation_type: str
    status: str
    subject_type: str
    subject_identifier: str
    attester_name: str
    attester_type: str
    claims: List[dict]
    evidence: List[AttestationEvidence]
    evidence_count: int
    verify_url: str
    attester_title: Optional[str] = None
    summary: Optional[str] = None
    jurisdiction: Optional[str] = None
    fingerprint: Optional[str] = None
    evidence_fingerprint: Optional[str] = None
    chain_proof: Optional[Dict[str, Any]] = None
    linked_credential: Optional[Dict[str, Any]] = None
    attestor_credentials: Optional[List[AttestorCredential]] = None
    issued_at: Optional[str] = None
    expires_at: Optional[str] = None
    revoked_at: Optional[str] = None
    revocation_reason: Optional[str] = None
    created_at: Optional[str] = None
