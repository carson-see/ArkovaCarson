from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SearchType = Literal["all", "org", "record", "fingerprint", "document"]
SearchResultType = Literal["org", "record", "fingerprint", "document"]

# Discriminator emitted by every v2 anchor-detail route. `mapAnchorDetail()` in
# services/worker/src/api/v2/resourceDetails.ts takes it as an argument and is
# called with exactly these three values — one per route.
ResourceDetailType = Literal["record", "fingerprint", "document"]

# Mirrors the worker's CREDENTIAL_TYPES enum in
# services/worker/src/api/v1/anchor-bulk.ts. Keep in sync; the server is
# authoritative and rejects unknown values.
BulkAnchorCredentialType = Literal[
    "DEGREE", "LICENSE", "CERTIFICATE", "TRANSCRIPT", "PROFESSIONAL", "CPE", "CLE",
    "BADGE", "ATTESTATION", "FINANCIAL", "LEGAL", "INSURANCE", "SEC_FILING", "PATENT",
    "REGULATION", "PUBLICATION", "CHARITY", "ACCREDITATION", "FINANCIAL_ADVISOR",
    "BUSINESS_ENTITY", "RESUME", "MEDICAL", "MILITARY", "IDENTITY",
    "CONTRACT_PRESIGNING", "CONTRACT_POSTSIGNING", "OTHER",
]

# How the server should handle a fingerprint that already exists (in-batch or in-org).
BulkAnchorDuplicateStrategy = Literal["skip", "supersede", "link", "fail"]


class ArkovaModel(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class ProblemDetail(ArkovaModel):
    """RFC 7807 problem document — emitted by the **v2 API only**.

    `client._problem()` builds one only for an `application/problem+json`
    response, which is the v2 error surface. The v1 endpoints this SDK also
    calls (`/api/v1/anchor`, `/api/v1/anchor/bulk`, `/api/v1/verify/...`) emit
    plain JSON in one of three shapes instead — `{error}`,
    `{error, message, details}`, or `{error: {code, message}}` — so
    `ArkovaError.problem` is `None` for every v1 failure. Read
    `ArkovaError.code` / `.status_code` rather than `.problem` if the call
    might hit a v1 route.

    Those plain shapes are handled by `client._plain_error_body()`. Note the
    nested `{error: {code, message}}` form yields `ArkovaError.code = None`
    (the `error` value is a dict, not a string) and a status-derived message;
    it raises correctly but carries no machine-readable code.
    """

    type: str
    title: str
    status: int
    detail: str | None = None
    instance: str | None = None


class SearchResult(ArkovaModel):
    """One row of a v2 search response.

    ``score`` carries NO relevance signal. All four mappers in
    ``services/worker/src/api/v2/search.ts`` (org / record / fingerprint /
    document) build ``score: 1.0`` as a literal; the file contains no ranking
    function of any kind. Every result therefore ties, and sorting or
    thresholding on ``score`` is meaningless — result order comes from the
    query's own ``.order()`` clause, not from this field.

    It is kept because the v2 response shape is frozen (CLAUDE.md §1.8):
    removing a published field would be the breaking change, and the SDK
    cannot invent a relevance number the API does not compute.
    """

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
    # SCRUM-2227 / BUG-2026-08-12-007: the API emits this as a LIST of control-ID
    # strings. Declared dict-only, pydantic raised ValidationError on a real
    # payload and failed the whole verify() call — proof the dict form had no
    # working consumer. `compliance_controls_note` states what these identifiers
    # do NOT assert and is present whenever controls are.
    #
    # `None` here means OMITTED, which is what the wire actually does:
    # `sanitizeStoredComplianceControls` returns `string[] | null` (never an
    # object, never `[]`), and `buildVerificationResult` then skips the key for a
    # null/empty value AND for any record that is not a current anchored
    # credential. So the field is a NON-EMPTY list or absent — never null, never
    # an object. The `| None` covers absence and, defensively, the `nullable:
    # true` the published OpenAPI schema still declares.
    compliance_controls: list[str] | None = None
    compliance_controls_note: str | None = None
    chain_confirmations: int | None = None
    parent_public_id: str | None = None
    version_number: int | None = None
    revocation_tx_id: str | None = None
    revocation_block_height: int | None = None
    file_mime: str | None = None
    file_size: int | None = None
    confidence_scores: dict[str, Any] | None = None
    sub_type: str | None = None
    # R19 (SCRUM-2481): evidence class for how `fingerprint` was computed —
    # 'document_bytes' or 'issuer_record_attestation'; omitted when unclassified.
    # Part of the same API-RICH key loop as the fields above.
    #
    # `str`, NOT `Literal`. Over-narrow typing built from an API snapshot is the
    # exact defect BUG-2026-08-12-007 records, and this column is bare `text`
    # with no CHECK constraint. A value we have not seen must not raise inside a
    # consumer's verify() call. Same reasoning for `proof_availability` below.
    fingerprint_source: str | None = None


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
    # SCRUM-2575: whether a per-document proof can actually be retrieved for this
    # record ('per_document') or only the on-chain commitment exists
    # ('root_only'). Emitted ONLY by GET /api/v1/verify/{public_id}, and only
    # when the branch question was measured on a settled status that carries a
    # chain receipt — so it lives here rather than on RichVerificationFields.
    # Batch and oracle responses omit the pair entirely (they measure nothing).
    #
    # `proof_availability_note` is emitted exactly when `proof_availability` is:
    # the class never travels without its measured / asserted / NOT-asserted
    # statement (§1.5). Read them as a pair.
    #
    # `str` rather than `Literal`, for the reason on `fingerprint_source`.
    proof_availability: str | None = None
    proof_availability_note: str | None = None
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

    # strict=True so a wrong-typed member (e.g. leaf_count="4") is REJECTED, not
    # silently coerced — parity with the TS SDK's typeof checks (CodeRabbit). The
    # real wire form carries proper JSON numbers/strings, so strict does not
    # over-reject valid bundles. populate_by_name kept for camel/snake tolerance.
    model_config = ConfigDict(extra="allow", populate_by_name=True, strict=True)

    # CodeRabbit (SCRUM-2338): every required member is NON-nullable with NO
    # default. A complete (non-None) bundle must satisfy the
    # ``proof_bundle is not None ⇒ independently verifiable`` contract, so a
    # malformed payload (missing/wrong-typed member, or an empty merkle_proof)
    # must NOT validate into a valid-looking bundle. The parent response coerces
    # any such failure to ``proof_bundle = None`` (see the validator below)
    # rather than defaulting members to None/0/1.
    fingerprint: str
    merkle_root: str
    merkle_proof: list[MerkleProofEntry] = Field(min_length=1)
    merkle_index: int
    # Total leaves in the batch tree this proof belongs to; with merkle_index it
    # arms the CVE-2012-2459 duplicate-leaf guard during local verification.
    leaf_count: int
    tx_id: str
    block_height: int
    block_hash: str
    block_header: str
    op_return_payload: str
    block_timestamp: str
    proof_schema_version: int
    # RESERVED — always None today; the signed envelope is the outer
    # ?format=signed response wrapper, not an inline bundle field. The one
    # legitimately-nullable member of the bundle.
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

    @model_validator(mode="before")
    @classmethod
    def _fail_closed_proof_bundle(cls, values: Any) -> Any:
        """Coerce a malformed non-null ``proof_bundle`` to ``None`` (fail closed).

        CodeRabbit (SCRUM-2338): defaulting missing/wrong-typed required members
        would manufacture a valid-looking — but unverifiable — bundle from
        malformed JSON. Since ``ProofBundle`` now requires every member, a
        malformed payload raises ``ValidationError``; we catch that here and drop
        the bundle to ``None`` so the rest of the (frozen) response still parses
        and the ``proof_bundle is not None ⇒ verifiable`` contract holds.
        """
        if isinstance(values, dict):
            raw = values.get("proof_bundle")
            if raw is not None and not isinstance(raw, ProofBundle):
                try:
                    ProofBundle.model_validate(raw)
                # Blind by design (081a4b74, PROOF-05/SCRUM-2338): ANY failure to
                # construct a bundle must fail closed to `None` rather than take
                # the whole (frozen) response down with it. Today every malformed
                # input surfaces as `ValidationError`; the broad catch is what
                # keeps the contract holding if that ever stops being true.
                except Exception:  # noqa: BLE001
                    values = dict(values)
                    values["proof_bundle"] = None
        return values


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
    """Response of ``GET /api/v2/organizations/{public_id}``.

    The handler in ``resourceDetails.ts`` does not spread the row — it names
    six keys explicitly in its ``res.json({...})``, and those six are exactly
    the fields below.

    Removed in 2.3.0: ``industry_tag``, ``org_type``, ``location`` and
    ``logo_url``. None of the four are selected from the ``organizations``
    row, let alone emitted, so no code path could ever have set them; they
    read ``None`` on every response since the model was written.
    """

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


class RecordDetail(ArkovaModel):
    """Response of ``GET /api/v2/records/{public_id}``.

    All three anchor-detail routes share one mapper (``mapAnchorDetail``), so
    this model, `FingerprintDetail` and `DocumentDetail` share one field set
    and differ only in the `type` discriminator each route emits.

    Removed in 2.3.0: ``issuer_name``. ``mapAnchorDetail`` has no such key —
    the issuer reaches clients through ``metadata["issuer"]`` instead
    (``issuer`` is one of the ten keys ``safeMetadata()`` allow-lists).
    """

    # Always emitted; identifies which of the three routes answered. Declared
    # as the full union on the base and narrowed per-subclass below.
    type: ResourceDetailType
    public_id: str | None = None
    verified: bool
    status: str
    fingerprint: str | None = None
    title: str | None = None
    description: str | None = None
    credential_type: str | None = None
    sub_type: str | None = None
    issued_date: str | None = None
    expiry_date: str | None = None
    anchor_timestamp: str | None = None
    network_receipt_id: str | None = None
    record_uri: str | None = None
    # `safeMetadata()` filters the row's metadata to a ten-key allow-list and
    # returns `undefined` when nothing survives, which drops the key from the
    # JSON entirely — so absent means empty, never null.
    metadata: dict[str, Any] | None = None


class FingerprintDetail(RecordDetail):
    # Narrowed from the base union: this route always emits "fingerprint".
    # Same override pattern (and same reason for the ignore) as `fingerprint`.
    type: Literal["fingerprint"]  # type: ignore[assignment]
    fingerprint: str  # type: ignore[assignment]


class DocumentDetail(RecordDetail):
    type: Literal["document"]  # type: ignore[assignment]


# ── Write path (anchor / anchor_bulk) ────────────────────────────────────
# HAKI-REQ-02 (SCRUM-1171): POST /api/v1/anchor and /api/v1/anchor/bulk.
# Response shape is distinct from the read-only `Anchor` model above (no
# `verified` — that only exists once the anchor is looked up).


class AnchorReceipt(ArkovaModel):
    """Response of ``POST /api/v1/anchor``.

    Five keys, all unconditional: the endpoint's two emit sites — the
    idempotent duplicate hit (200) and the fresh insert (201) — build the same
    object literal, and `interface AnchorReceipt` in ``anchor-submit.ts``
    declares every member non-optional.

    Removed in 2.3.0: ``chain_tx_id``. The endpoint has never emitted it, and
    structurally cannot: the receipt is issued at creation with
    ``status='PENDING'``, before any batch drain has anchored the fingerprint,
    so there is no transaction id in existence yet. Read it from
    ``verify()``'s ``network_receipt_id`` once the anchor settles.
    """

    public_id: str
    fingerprint: str
    # Plain `str`, not `Literal["PENDING"]`: the endpoint only sends PENDING
    # today, but pinning an API snapshot as a hard constraint is the defect
    # BUG-2026-08-12-007 records. A new status must surface, not raise.
    status: str
    created_at: str
    # The caller's link to the verification page. Always emitted — both sites
    # build it via `buildVerifyUrl()`, which returns a string unconditionally.
    record_uri: str


@dataclass
class BulkAnchorInput:
    """One row for :meth:`arkova.client.Arkova.anchor_bulk` /
    :meth:`arkova.client.AsyncArkova.anchor_bulk`.

    Provide exactly one of ``fingerprint`` (a pre-computed 64-char hex
    SHA-256) or ``data`` (raw content — fingerprinted client-side via the
    same algorithm as ``Arkova.fingerprint()``, so the document body never
    leaves this process for that row).
    """

    fingerprint: str | None = None
    data: str | bytes | None = None
    credential_type: BulkAnchorCredentialType | None = None
    description: str | None = None
    original_document_date: str | None = None
    document_type: str | None = None
    matter_or_case_ref: str | None = None
    external_id: str | None = None


class BulkAnchorDuplicate(ArkovaModel):
    row: int
    fingerprint: str
    scope: Literal["in_batch", "in_db"]
    decision: BulkAnchorDuplicateStrategy


class BulkAnchorRowError(ArkovaModel):
    """One per-row failure from ``POST /api/v1/anchor/bulk``.

    ``code`` is one of exactly two values today — ``insert_failed`` (the row's
    database insert failed; a ``23505`` unique violation is reported as a
    conflict message) and ``unexpected_error`` (the insert threw). Those are
    documented here rather than enforced as a ``Literal`` for the same reason
    ``AnchorReceipt.status`` is a plain ``str``.

    Row-level *schema* problems never appear in this array: a malformed row
    fails Zod validation for the whole request, which returns 400 with a
    ``details[]`` list — a different shape on a different response, surfaced
    as ``ArkovaError(code="invalid_request")``.

    Removed in 2.3.0: ``field``. The worker's ``RowError`` interface declares
    ``field?: string``, but neither ``errors.push()`` site assigns it, so it
    never reaches the wire.
    """

    row: int
    code: str
    message: str


class BulkAnchorResultRow(ArkovaModel):
    public_id: str
    fingerprint: str
    status: str
    original_document_date: str | None = None
    document_type: str | None = None
    matter_or_case_ref: str | None = None
    external_id: str | None = None
    anchored_at: str


class BulkAnchorResponse(ArkovaModel):
    """Response of ``POST /api/v1/anchor/bulk``."""

    batch_id: str | None = None
    validated: int
    queued: int
    duplicates: list[BulkAnchorDuplicate] = Field(default_factory=list)
    errors: list[BulkAnchorRowError] = Field(default_factory=list)
    dry_run: bool
    # Omitted by the server on dry runs.
    anchors: list[BulkAnchorResultRow] | None = None
