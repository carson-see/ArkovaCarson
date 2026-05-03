from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


SearchType = Literal["all", "org", "record", "fingerprint", "document"]
SearchResultType = Literal["org", "record", "fingerprint", "document"]


class ArkovaModel(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class ProblemDetail(ArkovaModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    type: str
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None


class SearchResult(ArkovaModel):
    type: SearchResultType
    public_id: str
    score: float
    snippet: str
    metadata: dict[str, Any] | None = None


class SearchResponse(ArkovaModel):
    results: list[SearchResult]
    next_cursor: str | None = None


class FingerprintVerification(ArkovaModel):
    verified: bool
    status: str
    fingerprint: str
    public_id: str | None = None
    title: str | None = None
    issuer_name: str | None = None
    credential_type: str | None = None
    sub_type: str | None = None
    description: str | None = None
    anchor_timestamp: str | None = None
    network_receipt_id: str | None = None
    record_uri: str | None = None
    compliance_controls: dict[str, Any] | None = None
    chain_confirmations: int | None = None
    parent_public_id: str | None = None
    version_number: int | None = None
    revocation_tx_id: str | None = None
    revocation_block_height: int | None = None
    file_mime: str | None = None
    file_size: int | None = None
    confidence_scores: dict[str, Any] | None = None


class Anchor(ArkovaModel):
    public_id: str
    verified: bool
    status: str
    record_uri: str
    issuer_name: str | None = None
    credential_type: str | None = None
    sub_type: str | None = None
    description: str | None = None
    issued_date: str | None = None
    expiry_date: str | None = None
    anchor_timestamp: str | None = None
    network_receipt_id: str | None = None
    jurisdiction: str | None = None
    compliance_controls: dict[str, Any] | None = None
    chain_confirmations: int | None = None
    parent_public_id: str | None = None
    version_number: int | None = None
    revocation_tx_id: str | None = None
    revocation_block_height: int | None = None
    file_mime: str | None = None
    file_size: int | None = None
    confidence_scores: dict[str, Any] | None = None


class Org(ArkovaModel):
    public_id: str | None = None
    display_name: str
    domain: str | None = None
    website_url: str | None = None
    verification_status: str | None = None


class OrgList(ArkovaModel):
    organizations: list[Org] = Field(default_factory=list)


class OrganizationDetail(Org):
    description: str | None = None
    industry_tag: str | None = None
    org_type: str | None = None
    location: str | None = None
    logo_url: str | None = None


class RecordDetail(ArkovaModel):
    public_id: str | None = None
    verified: bool
    status: str
    fingerprint: str | None = None
    title: str | None = None
    description: str | None = None
    issuer_name: str | None = None
    credential_type: str | None = None
    sub_type: str | None = None
    issued_date: str | None = None
    expiry_date: str | None = None
    anchor_timestamp: str | None = None
    network_receipt_id: str | None = None
    record_uri: str | None = None
    compliance_controls: dict[str, Any] | None = None
    chain_confirmations: int | None = None
    parent_public_id: str | None = None
    version_number: int | None = None
    revocation_tx_id: str | None = None
    revocation_block_height: int | None = None


class FingerprintDetail(RecordDetail):
    fingerprint: str
    file_mime: str | None = None
    file_size: int | None = None


class DocumentDetail(RecordDetail):
    file_mime: str | None = None
    file_size: int | None = None
