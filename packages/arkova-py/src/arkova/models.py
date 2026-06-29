from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
    public_id: str
    score: float
    snippet: str
    metadata: dict[str, Any] | None = None

    @model_validator(mode="before")
    @classmethod
    def strip_internal_id(cls, values: Any) -> Any:
        if isinstance(values, dict):
            values = dict(values)
            values.pop("id", None)
        return values


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


class MerkleProofEntry(ArkovaModel):
    hash: str
    position: Literal["left", "right"]


class ProofBundleSignature(ArkovaModel):
    """PROOF-05 (SCRUM-2338): inline Ed25519 envelope metadata.

    Present only when the proof was fetched signed; ``None`` otherwise.
    """

    alg: str
    signing_key_id: str


class ProofBundle(ArkovaModel):
    """PROOF-05 (SCRUM-2338): self-contained two-layer proof bundle.

    Carries only cryptographic evidence (never raw document content or PII).
    The parent ``MerkleProofResponse.proof_bundle`` is ``None`` when the proof
    is incomplete — never fabricated. The API emits it only when ALL fields are
    present + well-formed: receipt tx_id/block_height/block_timestamp, 160-hex
    block_header, 64-hex block_hash, canonical ARKV op_return_payload, and BOTH
    merkle_index AND leaf_count (which together arm the CVE-2012-2459 guard).

    Canonical op_return_payload shape: "ARKV" (41524b56) + 32-byte app root
    (64 hex), NO version byte, optional trailing metadata hash.
    """

    fingerprint: str
    merkle_root: str
    merkle_proof: list[MerkleProofEntry]
    merkle_index: int | None = None
    # Total leaves in the batch tree this proof belongs to. Always present in a
    # complete (non-None) bundle; with merkle_index it arms the CVE-2012-2459
    # duplicate-leaf guard during local verification.
    leaf_count: int = 0
    tx_id: str | None = None
    block_height: int | None = None
    block_hash: str | None = None
    block_header: str | None = None
    op_return_payload: str | None = None
    block_timestamp: str | None = None
    proof_schema_version: int = 1
    # RESERVED — always None today; the signed envelope is the outer
    # ?format=signed response wrapper, not an inline bundle field.
    signature: ProofBundleSignature | None = None


class MerkleProofResponse(ArkovaModel):
    """PROOF-05 (SCRUM-2338): GET /api/v1/verify/{public_id}/proof.

    Frozen top-level fields plus the additive, nullable ``proof_bundle``.
    """

    public_id: str
    fingerprint: str
    merkle_root: str
    merkle_proof: list[MerkleProofEntry]
    tx_id: str | None = None
    block_height: int | None = None
    block_timestamp: str | None = None
    batch_id: str | None = None
    verified: bool
    proof_bundle: ProofBundle | None = None


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
    public_id: str
    display_name: str
    domain: str | None = None
    website_url: str | None = None
    verification_status: str | None = None

    @model_validator(mode="before")
    @classmethod
    def strip_internal_id(cls, values: Any) -> Any:
        if isinstance(values, dict):
            values = dict(values)
            values.pop("id", None)
        return values


class OrgList(ArkovaModel):
    organizations: list[Org] = Field(default_factory=list)


# SCRUM-1584 — public-safe v2 detail envelopes returned by the
# /api/v2/{organizations|records|fingerprints|documents}/{id} routes.
# Mirrors the worker's mapAnchorDetail shape; never carries internal
# id/org_id/user_id/record_id columns.

class OrganizationDetail(ArkovaModel):
    # The v2 /api/v2/organizations/{public_id} response is intentionally
    # public-safe: no internal `id` UUID. We do NOT inherit from Org here
    # because `Org.id` is required, which would fail Pydantic validation
    # on every successful response.
    public_id: str
    display_name: str
    domain: str | None = None
    website_url: str | None = None
    verification_status: str | None = None
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


class FingerprintDetail(RecordDetail):
    fingerprint: str  # type: ignore[assignment]


class DocumentDetail(RecordDetail):
    pass
