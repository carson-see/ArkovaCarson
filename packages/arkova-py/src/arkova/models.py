from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


SearchType = Literal["all", "org", "record", "fingerprint", "document"]
SearchResultType = Literal["org", "record", "fingerprint", "document"]


class ArkovaModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class ProblemDetail(ArkovaModel):
    type: str
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None


class SearchResult(ArkovaModel):
    type: SearchResultType
    id: str
    public_id: str
    score: float
    snippet: str
    metadata: dict[str, Any] | None = None


class SearchResponse(ArkovaModel):
    results: list[SearchResult]
    next_cursor: str | None = None


class RichVerificationFields(ArkovaModel):
    description: str | None = None
    compliance_controls: dict[str, Any] | None = None
    chain_confirmations: int | None = None
    parent_public_id: str | None = None
    version_number: int | None = None
    revocation_tx_id: str | None = None
    revocation_block_height: int | None = None
    file_mime: str | None = None
    file_size: int | None = None
    confidence_scores: dict[str, Any] | None = None
    sub_type: str | None = None


class FingerprintVerification(RichVerificationFields):
    verified: bool
    status: str
    fingerprint: str
    public_id: str | None = None
    title: str | None = None
    anchor_timestamp: str | None = None
    network_receipt_id: str | None = None
    record_uri: str | None = None


class VerificationResult(RichVerificationFields):
    verified: bool
    status: str | None = None
    issuer_name: str | None = None
    recipient_identifier: str | None = None
    credential_type: str | None = None
    issued_date: str | None = None
    expiry_date: str | None = None
    anchor_timestamp: str | None = None
    bitcoin_block: int | None = None
    network_receipt_id: str | None = None
    merkle_proof_hash: str | None = None
    record_uri: str | None = None
    jurisdiction: str | None = None
    explorer_url: str | None = None
    ferpa_notice: str | None = None
    directory_info_suppressed: bool | None = None
    error: str | None = None


class Anchor(RichVerificationFields):
    public_id: str
    verified: bool
    status: str
    record_uri: str
    issuer_name: str | None = None
    credential_type: str | None = None
    issued_date: str | None = None
    expiry_date: str | None = None
    anchor_timestamp: str | None = None
    network_receipt_id: str | None = None
    jurisdiction: str | None = None


class Org(ArkovaModel):
    id: str
    public_id: str
    display_name: str
    domain: str | None = None
    website_url: str | None = None
    verification_status: str | None = None


class OrgList(ArkovaModel):
    organizations: list[Org] = Field(default_factory=list)
