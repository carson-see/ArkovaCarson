/**
 * OpenAPI Documentation (P4.5-TS-04)
 *
 * Serves Swagger UI at /api/docs with the full Verification API spec.
 * Accessible without authentication.
 */

import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { API_KEY_SCOPES } from '../apiScopes.js';
import { VALID_WEBHOOK_EVENTS } from './webhooks-schemas.js';
import { EXPIRING_SOON_WINDOW_DAYS, MAX_EXPIRES_IN_DAYS } from './keyExpiryStatus.js';
// SCRUM-4507: the source-provider vocabulary, taken from the SAME closed
// marker set the verify endpoint gates on (constants/connectorFingerprint.ts).
// Imported from the constants module rather than from `verify.ts` on purpose:
// `verify.ts` pulls in the db client and config at module scope, and this
// module is imported by tests that deliberately do not stand those up. Both
// surfaces therefore reference ONE frozen, already-ordered array rather than
// each materialising its own — see the constant's own header for why the
// order is stated and the array is frozen.
import { CONNECTOR_FETCH_SOURCE_MARKERS_SORTED } from '../../constants/connectorFingerprint.js';
import { ANCHOR_CREDENTIAL_TYPES } from '../../lib/credential-evidence.js';

const router = Router();

// OpenAPI enum that mirrors the runtime CRUD allowlist. Referenced three
// times below (POST /webhooks request body, PATCH /webhooks/{id} request
// body, WebhookEndpoint response schema). Inlining the literal three times
// is exactly the drift pattern SCRUM-1794 was filed to clean up.
const WEBHOOK_EVENT_ENUM = [...VALID_WEBHOOK_EVENTS];

const ANCHOR_SUBMIT_REQUEST_BODY = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['fingerprint'],
        properties: {
          fingerprint: { type: 'string', description: 'SHA-256 document fingerprint (64-char hex)', pattern: '^[a-f0-9]{64}$' },
          description: { type: 'string', maxLength: 1000, description: 'Public document description included in verification responses' },
          credential_type: { type: 'string', enum: [...ANCHOR_CREDENTIAL_TYPES] },
          action: { type: 'string', enum: ['queue', 'instant'], default: 'queue', description: 'Queue for batch anchoring or reserve one anchor credit to start now' },
          private_tags: {
            type: 'object',
            description: 'Private tags; never included in public records or webhook payloads',
            properties: {
              user: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 64 } },
              organization: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 64 } },
            },
          },
          metadata: { type: 'object', description: 'PII-stripped metadata fields', additionalProperties: true },
        },
      },
    },
  },
} as const;

const ANCHOR_RECEIPT_SCHEMA = {
  type: 'object',
  required: ['public_id', 'fingerprint', 'status', 'created_at', 'record_uri', 'action', 'credit_state', 'instant_status', 'idempotent'],
  properties: {
    public_id: { type: 'string' },
    fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    status: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    record_uri: { type: 'string', format: 'uri' },
    action: { type: 'string', enum: ['queue', 'instant'] },
    credit_state: { type: 'string', enum: ['pending', 'spent', 'refunded'], nullable: true },
    instant_status: { type: 'string', enum: ['QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD', 'SUBMITTED', 'FAILED'], nullable: true },
    idempotent: { type: 'boolean' },
  },
} as const;

const ANCHOR_SUBMIT_RESPONSES = {
  '200': { description: 'Existing caller-owned submission (idempotent)', content: { 'application/json': { schema: ANCHOR_RECEIPT_SCHEMA } } },
  '201': { description: 'Anchor created', content: { 'application/json': { schema: ANCHOR_RECEIPT_SCHEMA } } },
  '400': { $ref: '#/components/responses/BadRequest' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
  '403': {
    description: 'The authenticated caller lacks anchor write scope, cannot act for the selected organization, or the selected organization is suspended.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  },
  '409': {
    description: 'The fingerprint already belongs to another scope for this actor, supplied private tags differ from the immutable tags on an idempotent submission, or anchor creation encountered a generic uniqueness conflict.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', enum: ['submission_metadata_conflict', 'fingerprint_conflict', 'anchor_creation_conflict'] },
            message: { type: 'string' },
          },
        },
      },
    },
  },
  '429': {
    description: 'The route-wide request-rate limit was exceeded, or the exact organization exhausted its daily anchor-creation quota. X-Org-Quota-* headers are present only for the organization-quota variant.',
    headers: {
      'Retry-After': { schema: { type: 'integer', minimum: 1 }, description: 'Seconds until the active limit permits another request' },
      'X-RateLimit-Limit': { schema: { type: 'integer' }, description: 'Active request or quota limit' },
      'X-RateLimit-Remaining': { schema: { type: 'integer', enum: [0] }, description: 'Remaining capacity in the active limit window' },
      'X-RateLimit-Reset': { schema: { type: 'integer' }, description: 'Active limit-window reset as Unix epoch seconds' },
      'X-Org-Quota-Anchors-Limit': { schema: { type: 'integer' }, description: 'Daily anchor quota limit' },
      'X-Org-Quota-Anchors-Remaining': { schema: { type: 'integer' }, description: 'Daily anchor quota remaining' },
      'X-Org-Quota-Anchors-Reset': { schema: { type: 'string', format: 'date-time' }, description: 'Daily quota reset time' },
      'X-Org-Quota-Anchors-Created-Limit': { schema: { type: 'integer' }, description: 'Compatibility alias for the daily anchor quota limit' },
      'X-Org-Quota-Anchors-Created-Remaining': { schema: { type: 'integer' }, description: 'Compatibility alias for daily anchor quota remaining' },
      'X-Org-Quota-Anchors-Created-Reset': { schema: { type: 'string', format: 'date-time' }, description: 'Compatibility alias for the daily quota reset time' },
    },
    content: {
      'application/json': {
        schema: {
          oneOf: [
            {
              type: 'object',
              required: ['error', 'retry_after'],
              properties: {
                error: { type: 'string', enum: ['Too many requests'] },
                retry_after: { type: 'integer', minimum: 1 },
              },
            },
            {
              type: 'object',
              required: ['error'],
              properties: {
                error: {
                  type: 'object',
                  required: ['code', 'message', 'quota_type', 'current', 'limit', 'reset_at'],
                  properties: {
                    code: { type: 'string', enum: ['ORG_QUOTA_EXCEEDED'] },
                    message: { type: 'string' },
                    quota_type: { type: 'string', enum: ['anchors_created'] },
                    current: { type: 'integer', minimum: 0 },
                    limit: { type: 'integer', minimum: 0 },
                    reset_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  '500': {
    description: 'Anchor creation failed without exposing database or provider details.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', enum: ['anchor_creation_failed', 'Internal server error'] },
            message: { type: 'string' },
          },
        },
      },
    },
  },
  '503': {
    description: 'Submission, organization, quota, metadata, or instant-processing state is temporarily unavailable.',
    content: {
      'application/json': {
        schema: {
          oneOf: [
            { $ref: '#/components/schemas/ApiError' },
            {
              type: 'object',
              required: ['error'],
              properties: {
                error: {
                  type: 'object',
                  required: ['code', 'message'],
                  properties: {
                    code: { type: 'string', enum: ['quota_check_failed'] },
                    message: { type: 'string' },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
} as const;

const ANCHOR_IMPORT_PROPERTIES = {
  org_id: { type: 'string', format: 'uuid', nullable: true, description: 'JWT transport only: selected caller-owned organization, or null for personal import. API-key transport derives this from the key.' },
  action: { type: 'string', enum: ['queue', 'instant'] },
  description: { type: 'string', maxLength: 1000 },
  private_tags: {
    type: 'object',
    description: 'Import-wide private tags; never public or included in webhooks',
    properties: {
      user: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 64 } },
      organization: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 64 } },
    },
  },
  rows: {
    type: 'array', minItems: 1, maxItems: 100,
    items: {
      type: 'object', required: ['fingerprint', 'filename', 'fingerprint_provided'], additionalProperties: false,
      properties: {
        fingerprint: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        filename: { type: 'string', minLength: 1, maxLength: 255 },
        file_size: { type: 'integer', minimum: 1 },
        credential_type: { type: 'string', enum: [...ANCHOR_CREDENTIAL_TYPES] },
        metadata: { type: 'object', additionalProperties: true, description: 'PII-stripped extraction/source metadata. Reserved private keys and underscore-prefixed keys are dropped; invalid public evidence claims are rejected per row.' },
        fingerprint_provided: { type: 'boolean', description: 'True only when the imported fingerprint was computed from document bytes; false remains unclassified.' },
        recipient_email: { type: 'string', format: 'email', maxLength: 254, description: 'Optional recipient assignment. Assigns the record to that third party and can cause an activation email to be sent to that address. Requires owner/admin authority for the selected organization; without it the row is still anchored and reports recipient_provisioning_forbidden.' },
        recipient_name: { type: 'string', minLength: 1, maxLength: 255 },
      },
    },
  },
} as const;

const ANCHOR_IMPORT_RESPONSE = {
  type: 'object', required: ['total', 'created', 'skipped', 'failed', 'results'],
  properties: {
    total: { type: 'integer', minimum: 1, maximum: 100 },
    created: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    // Additive (§1.8): rows counted here are ALSO counted in `created` or
    // `skipped`, so `created + skipped + failed` still equals `total`.
    recipient_link_failed: {
      type: 'integer', minimum: 0,
      description: 'Rows whose anchor committed but whose recipient did not resolve. Already included in created/skipped; never in failed. Counts rows whose recipient was never linked AND rows that were linked but whose invitation did not go out - see each row reason.',
    },
    results: { type: 'array', maxItems: 100, items: { type: 'object', required: ['fingerprint', 'status'], properties: {
      fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      status: {
        type: 'string',
        enum: ['created', 'skipped', 'failed', 'created_recipient_failed', 'skipped_recipient_failed'],
        description: 'The *_recipient_failed values mean the anchor exists and must not be re-submitted; the recipient did not resolve. The status does not say whether the recipient was linked - the reason code does. The anchor_recipients link commits before the activation email is sent, so recipient_activation_* reasons mean the recipient WAS linked and only the invitation did not go out (or its delivery is unknown), while reasons thrown at or before the link insert mean it was not linked. recipient_provisioning_forbidden means the caller may not assign recipients at all.',
      },
      public_id: { type: 'string' },
      reason: { type: 'string', description: 'Bounded machine-readable failure code' },
      instant_status: { type: 'string', enum: ['QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD', 'SUBMITTED', 'FAILED'] },
    } } },
  },
} as const;

/**
 * SCRUM-3971 — sub-organization management over an organization API key.
 *
 * Additive under §1.8: six new paths, no existing shape touched. Every
 * response here is PUBLIC-ID ONLY; the internal organization uuid is never
 * emitted, and sending one as `org_public_id` is a 400 (`use_public_id`)
 * rather than a silent 404.
 *
 * OpenAPI 3.0.3: `nullable: true`, never `type: 'null'` and never a type array
 * — those are 3.1 spellings that make this served document invalid for every
 * 3.0 consumer (the defect class pinned by `docs.test.ts`).
 */
const SUB_ORG_SELECTOR_PROPERTY = {
  type: 'string',
  minLength: 2,
  maxLength: 128,
  description: 'Public identifier of the affiliated organization. NOT the internal uuid — sending one returns 400 use_public_id.',
  example: 'k7mqx3ptr9wz',
} as const;

const SUB_ORG_AMBIGUOUS_CALLER_409 = {
  description:
    'ambiguous_caller — the request presented both a verified session and an API key. Neither credential may be allowed to pick which organization is acting, so the request is refused rather than resolved.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
} as const;

const SUB_ORG_COMMON_RESPONSES = {
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': {
    description:
      'Refused, named by a machine code in `error`: `insufficient_scope` (the key lacks orgs:manage), `acting_org_not_found` (the key\'s own organization no longer exists), or `sub_org_cannot_manage_sub_orgs` (the key belongs to an affiliated organization, which cannot administer affiliates of its own).',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  },
  '404': {
    description:
      'No affiliated organization the caller may address answers to this public id. Deliberately indistinguishable from "belongs to another parent", "not approved yet" and "suspended" — this endpoint is not an existence oracle.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  },
  '429': { $ref: '#/components/responses/RateLimited' },
  '502': {
    description:
      'The underlying database function refused the call with a code this API version does not name. `error` carries that code verbatim. Not a 500: the request was answered, not dropped.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  },
  '503': {
    description:
      'A required lookup or RPC was unavailable, named by a machine code in `error`: `org_lookup_unavailable` (the acting-organization read failed), `sub_org_lookup_unavailable`, `sub_org_list_unavailable`, `rollup_projection_unavailable`, `credit_allocation_unavailable`, `credit_rollup_unavailable`, `balance_lookup_unavailable`, `suspend_unavailable`, `offboard_unavailable`, `cap_check_unavailable`, or `api_key_principal_unresolved` (the key is authorized but the principal it must stamp on the row could not be resolved). Never returned in place of a definitive answer.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  },
} as const;

const SUB_ORG_SELECTOR_BODY = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['org_public_id'],
        properties: { org_public_id: SUB_ORG_SELECTOR_PROPERTY },
      },
    },
  },
} as const;

/**
 * Stated on every path below because it is a real consequence of the mount and
 * there is no exemption mechanism to hide behind: these routes are inside the
 * v1 chain, so each request increments the key's monthly usage counter and a
 * free-tier key can be 429'd by administration traffic alone. An organization
 * whose payment state has lapsed cannot reach them at all
 * (`requirePaymentCurrent` sits ahead of the whole /api/v1 prefix).
 */
const SUB_ORG_MOUNT_NOTE =
  ' Counts against the API key monthly usage quota (no exemption exists for administration routes) and requires the organization payment state to be current.';

/**
 * The affiliation lifecycle, stated once and referenced from each operation.
 * The predicate that enforces it is `orgSubOrgsCaller.ts`'s `ChildPredicate`;
 * this string is the published half of the same rule.
 */
const SUB_ORG_LIFECYCLE_NOTE =
  ' Lifecycle: a child requests affiliation (dashboard) and becomes PENDING; approve moves PENDING to APPROVED;'
  + ' credits move only while the affiliate is APPROVED and not suspended; offboard reclaims the remaining credits'
  + ' and suspends the affiliate, in any status; revoke ends the relationship from APPROVED or PENDING.'
  + ' offboard then revoke and revoke then offboard are both supported - offboard never requires APPROVED and'
  + ' revoke never refuses a suspended affiliate.';

const CLE_CREDIT_ROW_SCHEMA = {
  type: 'object',
  properties: {
    public_id: { type: 'string', nullable: true },
    course_title: { type: 'string', nullable: true },
    provider_name: { type: 'string', nullable: true },
    credit_hours: { type: 'number' },
    credit_category: { type: 'string' },
    delivery_method: { type: 'string', nullable: true },
    completion_date: { type: 'string', nullable: true },
    jurisdiction: { type: 'string' },
    anchor_status: { type: 'string', nullable: true },
    anchored_at: { type: 'string', nullable: true },
  },
};

const CLE_ATTESTATION_ROW_SCHEMA = {
  type: 'object',
  properties: {
    public_id: { type: 'string', nullable: true },
    attestation_type: { type: 'string', nullable: true },
    status: { type: 'string', nullable: true },
    created_at: { type: 'string', nullable: true },
  },
};

/** OpenAPI 3.0 specification for the Verification API */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const openApiSpec: Record<string, any> = {
  openapi: '3.0.3',
  info: {
    title: 'Arkova Verification API',
    version: '1.0.0',
    description:
      'Programmatic credential verification API. Verify credentials anchored on the Bitcoin network.',
    contact: {
      name: 'Arkova Support',
      url: 'https://arkova.ai',
    },
  },
  servers: [
    {
      url: '/api/v1',
      description: 'Verification API v1',
    },
  ],
  security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
  paths: {
    '/verify/{publicId}': {
      get: {
        summary: 'Verify a credential',
        description:
          'Verify a single credential by its public ID. Returns the frozen verification response schema.',
        operationId: 'verifyCredential',
        tags: ['Verification'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        parameters: [
          {
            name: 'publicId',
            in: 'path',
            required: true,
            description: 'The public ID of the credential (e.g., ARK-2026-TEST-001)',
            schema: { type: 'string', minLength: 3 },
          },
        ],
        responses: {
          '200': {
            description: 'Verification result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerificationResult' },
                example: {
                  verified: true,
                  status: 'ACTIVE',
                  issuer_name: 'University of Michigan',
                  credential_type: 'DIPLOMA',
                  issued_date: '2026-01-15T00:00:00Z',
                  expiry_date: null,
                  anchor_timestamp: '2026-03-12T10:30:00Z',
                  bitcoin_block: 204567,
                  network_receipt_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
                  record_uri: 'https://app.arkova.ai/verify/ARK-2026-TEST-001',
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    // pentest-prep (API contract audit): was mounted and live but missing
    // from the served spec — a pentester enumerating from this document
    // would never have found it.
    '/verify/{publicId}/proof': {
      get: {
        summary: 'Get Merkle inclusion proof',
        description:
          'Returns the Merkle inclusion proof for a batch-anchored credential: the proof path, batch root, and the on-chain transaction it was committed in. `verified` is computed by locally recomputing the root from the proof — never trusted from stored status. Pass `?format=signed` to receive the bundle wrapped in a signed envelope bound to the issuer DID (requires PROOF_SIGNING_KEY_PEM/PROOF_SIGNING_KEY_ID to be configured; otherwise 503).',
        operationId: 'getMerkleProof',
        tags: ['Verification'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        parameters: [
          {
            name: 'publicId',
            in: 'path',
            required: true,
            description: 'The public ID of the credential',
            schema: { type: 'string', minLength: 3 },
          },
          {
            name: 'format',
            in: 'query',
            required: false,
            description: 'Pass `signed` to receive a DID-bound signed proof envelope instead of the raw bundle.',
            schema: { type: 'string', enum: ['signed'] },
          },
        ],
        responses: {
          '200': {
            description: 'Merkle inclusion proof',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    public_id: { type: 'string' },
                    fingerprint: { type: 'string' },
                    merkle_root: { type: 'string', nullable: true },
                    merkle_proof: { type: 'array', items: { type: 'string' }, nullable: true },
                    tx_id: { type: 'string', nullable: true },
                    block_height: { type: 'integer', nullable: true },
                    block_timestamp: { type: 'string', format: 'date-time', nullable: true },
                    batch_id: { type: 'string', nullable: true },
                    verified: { type: 'boolean', description: 'Recomputed locally from the proof path — never trusted from stored anchor status.' },
                    verdict: { type: 'string', enum: ['valid', 'invalid', 'unverifiable'], description: 'R3: the same computation as `verified`, as three states. `invalid` means a check RAN and FAILED (an alarm; equivalent to verified=false). `unverifiable` means a check could not be completed — the duplicate-node structural guard was not exercised, either because the record carries no merkle_index/leaf_count or because the stored branch length does not match the tree its leaf_count describes — and is NOT an alarm. `valid` and `unverifiable` partition the old verified=true bucket; `verified` is unchanged and not deprecated.' },
                    verdict_note: { type: 'string', description: 'The measured / asserted / NOT-asserted statement for `verdict` (Constitution §1.5). Always accompanies `verdict`.' },
                    proof_bundle: { type: 'object', nullable: true, additionalProperties: true, description: 'PROOF-05: self-contained bundle (block header, OP_RETURN payload, schema version, and — R1 — the tx_inclusion_branch + tx_block_index that let a verifier confirm transaction inclusion in the block locally) when the confirmation layer has been populated; null otherwise. The two R1 fields are additive and nullable (no schema-version bump) and are null on records populated before migration 0427.' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { description: 'Record not found, or no Merkle proof available (not batch-anchored)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
          '500': {
            description:
              'Stored proof data is malformed, OR the proof is batch-linked but its exact leaf_count could not be determined (fail-closed: the CVE-2012-2459 structural guard cannot honestly run, so the request is not downgraded to a weaker verdict). Only the leaf_count body carries `verdict`.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                    verdict: { type: 'string', enum: ['unverifiable'], description: 'R3: present ONLY on the indeterminate-leaf_count body, where a verification was attempted and could not be completed. Absent on the malformed-proof-data body (that fails during extraction, before any verification), and absent on 400/404/503. Consumers MUST fall back to `error` / the HTTP status when it is absent.' },
                    verdict_note: { type: 'string', description: 'The measured / asserted / NOT-asserted statement for `verdict` (Constitution §1.5). Present exactly when `verdict` is.' },
                  },
                },
              },
            },
          },
          '503': { description: 'Signed-format requested but signing is not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/credentials/{publicId}/ctdl': {
      get: {
        summary: 'Get CTDL JSON-LD for a credential',
        description:
          'Returns the public Credential Transparency Description Language JSON-LD projection for a publishable Arkova credential.',
        operationId: 'getCredentialCtdl',
        tags: ['Verification'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        parameters: [
          {
            name: 'publicId',
            in: 'path',
            required: true,
            description: 'The public ID of the credential (e.g., ARK-2026-TEST-001)',
            schema: { type: 'string', minLength: 3, maxLength: 128 },
          },
        ],
        responses: {
          '200': {
            description: 'CTDL JSON-LD document for an active credential',
            content: {
              'application/ld+json': {
                schema: { $ref: '#/components/schemas/CtdlCredential' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { $ref: '#/components/responses/NotFound' },
          '410': {
            description: 'CTDL JSON-LD document for a revoked credential',
            content: {
              'application/ld+json': {
                schema: { $ref: '#/components/schemas/CtdlCredential' },
              },
            },
          },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/verify/batch': {
      post: {
        summary: 'Batch verify credentials',
        description:
          'Verify multiple credentials in a single request. Synchronous for ≤20 items, async for >20 (returns job_id).',
        operationId: 'batchVerifyCredentials',
        tags: ['Verification'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['public_ids'],
                properties: {
                  public_ids: {
                    type: 'array',
                    items: { type: 'string', minLength: 3 },
                    minItems: 1,
                    maxItems: 100,
                    description: 'Array of credential public IDs to verify',
                  },
                },
              },
              example: {
                public_ids: ['ARK-2026-TEST-001', 'ARK-2026-TEST-002'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Synchronous batch results (≤20 items)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BatchResponse' },
              },
            },
          },
          '202': {
            description: 'Async job created (>20 items)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    job_id: { type: 'string', format: 'uuid' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/jobs/{jobId}': {
      get: {
        summary: 'Get batch job status',
        description: 'Poll the status of an async batch verification job.',
        operationId: 'getJobStatus',
        tags: ['Jobs'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [
          {
            name: 'jobId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Job status',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JobStatusResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/usage': {
      get: {
        summary: 'Get API usage',
        description: "Returns current month's API usage aggregated across all org API keys.",
        operationId: 'getUsage',
        tags: ['Usage'],
        'x-arkova-required-scopes': ['usage:read'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        responses: {
          '200': {
            description: 'Usage statistics',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UsageResponse' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/keys': {
      get: {
        summary: 'List API keys',
        description: "List all API keys for the authenticated user's organization.",
        operationId: 'listApiKeys',
        tags: ['Key Management'],
        security: [{ SupabaseJWT: [] }],
        responses: {
          '200': {
            description: 'List of API keys (masked)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    keys: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ApiKeyMasked' },
                    },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        summary: 'Create API key',
        description:
          'Create a new API key. The raw key is returned only once in the response — store it securely.',
        operationId: 'createApiKey',
        tags: ['Key Management'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
	                  name: { type: 'string', minLength: 1, maxLength: 100 },
	                  scopes: {
	                    type: 'array',
	                    items: { type: 'string' },
	                    'x-arkova-canonical-scopes': API_KEY_SCOPES,
	                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'API key created (raw key shown once)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiKeyCreated' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/keys/{keyId}': {
      patch: {
        summary: 'Update API key',
        description:
          "Update the name or scopes of an existing API key, revoke it, or change its expiry. Expiry is set with expires_in_days (a duration from now; null removes it) — expires_at is not settable. An expiry sent alongside a revoke (is_active: false) is dropped and the revoke is honoured; an expiry cannot be combined with reactivating a key.",
        operationId: 'updateApiKey',
        tags: ['Key Management'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'keyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
	                  name: { type: 'string' },
	                  scopes: {
	                    type: 'array',
	                    items: { type: 'string' },
	                    'x-arkova-canonical-scopes': API_KEY_SCOPES,
	                  },
                  // SCRUM-5023. Expiry is set by DURATION, never by timestamp:
                  // the server holds the clock, and an accepted client
                  // timestamp could write an already-past expiry.
                  //
                  // `nullable: true` (NOT `type: 'null'`) — this document
                  // declares OpenAPI 3.0.3, where the only JSON types are
                  // string/number/integer/boolean/array/object. `type: 'null'`
                  // is 3.1 syntax and is invalid here; see the structural
                  // check in docs.openapi30.test.ts.
                  expires_in_days: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_EXPIRES_IN_DAYS,
                    nullable: true,
                    description:
                      'Set the expiry this many days from now, or null to remove the expiry entirely. REPLACES any existing expiry — it does not add to it — so a value earlier than the current expiry is refused with 409 api_key_expiry_would_shorten unless allow_shorten is true.',
                  },
                  allow_shorten: {
                    type: 'boolean',
                    default: false,
                    description: 'Acknowledge that expires_in_days moves the expiry EARLIER (or gives an unexpiring key an expiry). Required for such a change; ignored otherwise.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Key updated' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': {
            description:
              'api_key_already_revoked — revocation is terminal, so the key cannot be reactivated or extended; or api_key_expiry_would_shorten — the requested expiry is earlier than the current one and allow_shorten was not set; or api_key_changed — expiry or revocation changed concurrently, so refresh before retrying.',
          },
        },
      },
      delete: {
        summary: 'Revoke API key',
        description: 'Revoke an API key. Optionally provide a reason.',
        operationId: 'revokeApiKey',
        tags: ['Key Management'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'keyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Key revoked' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // ── AI Intelligence Endpoints (P8) ──────────────────────────────────
    '/ai/extract': {
      post: {
        summary: 'Extract credential metadata',
        description:
          'Extract structured metadata from PII-stripped text using AI. Costs 1 AI credit per request. Gated by ENABLE_AI_EXTRACTION flag.',
        operationId: 'aiExtractMetadata',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ExtractionRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Extracted metadata fields',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ExtractionResponse' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '402': { description: 'Insufficient AI credits', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/ai/search': {
      get: {
        summary: 'Semantic credential search',
        description:
          'Search credentials using natural language via pgvector similarity. Costs 1 AI credit. Gated by ENABLE_SEMANTIC_SEARCH flag.',
        operationId: 'aiSearchCredentials',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Natural language search query' },
          { name: 'threshold', in: 'query', schema: { type: 'number', minimum: 0, maximum: 1, default: 0.7 }, description: 'Similarity threshold (0-1)' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 }, description: 'Max results to return' },
        ],
        responses: {
          '200': { description: 'Search results with similarity scores', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '402': { description: 'Insufficient AI credits', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/ai/usage': {
      get: {
        summary: 'Get AI credit usage',
        description: 'Returns AI credit balance and recent usage events for the authenticated user.',
        operationId: 'aiGetUsage',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        responses: {
          '200': { description: 'AI credit balance and usage history', content: { 'application/json': { schema: { $ref: '#/components/schemas/AIUsageResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/ai/embed': {
      post: {
        summary: 'Generate credential embedding',
        description: 'Generate a 768-dim embedding for a credential and store in pgvector. Costs 1 AI credit.',
        operationId: 'aiGenerateEmbedding',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/EmbedRequest' } } },
        },
        responses: {
          '201': { description: 'Embedding generated and stored' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '402': { description: 'Insufficient AI credits', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          // pentest-prep: this prefix passes through aiExtractionGate()
          // (ENABLE_AI_EXTRACTION) at the router.ts mount — was missing 503.
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    // pentest-prep (API contract audit): mounted and live, missing from the
    // served spec.
    '/ai/embed/batch': {
      post: {
        summary: 'Re-embed credentials in batch',
        description: 'Re-generates embeddings for up to 100 credentials owned by the caller\'s org in one request. Costs 1 AI credit per credential embedded.',
        operationId: 'aiBatchGenerateEmbedding',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['anchorIds'],
                properties: {
                  anchorIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', format: 'uuid' } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Batch embedding result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    succeeded: { type: 'integer' },
                    failed: { type: 'integer' },
                    errors: { type: 'array', items: { type: 'object', additionalProperties: true } },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/ai/feedback': {
      post: {
        summary: 'Submit extraction feedback',
        description: 'Submit corrections for AI extraction results. Improves future extraction accuracy. Costs 1 AI credit.',
        operationId: 'aiSubmitFeedback',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/FeedbackRequest' } } },
        },
        responses: {
          '200': { description: 'Feedback recorded' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    // pentest-prep (API contract audit): mounted and live, missing from the
    // served spec.
    '/ai/feedback/accuracy': {
      get: {
        summary: 'Get extraction accuracy stats',
        description: "Aggregate accuracy stats derived from stored feedback, scoped to the caller's org.",
        operationId: 'aiGetFeedbackAccuracy',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'credentialType', in: 'query', schema: { type: 'string' }, description: 'Filter to a single credential type' },
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 90, default: 30 }, description: 'Lookback window in days' },
        ],
        responses: {
          '200': { description: 'Accuracy stats for the requested window', content: { 'application/json': { schema: { type: 'object', properties: { stats: { type: 'object', additionalProperties: true }, days: { type: 'integer' } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/ai/feedback/analysis': {
      get: {
        summary: 'Analyze feedback for prompt-improvement suggestions',
        description: 'Cross-org aggregate analysis of stored extraction feedback, used to tune extraction prompts. ORG_ADMIN only.',
        operationId: 'aiGetFeedbackAnalysis',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 90, default: 30 }, description: 'Lookback window in days' },
        ],
        responses: {
          '200': { description: 'Prompt-improvement analysis report', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Admin access required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/ai/integrity/compute': {
      post: {
        summary: 'Compute integrity score',
        description: 'Compute a fraud/integrity score for a credential. Scores below 60 are auto-flagged for review. Gated by ENABLE_AI_FRAUD flag.',
        operationId: 'aiComputeIntegrity',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['anchorId'], properties: { anchorId: { type: 'string', format: 'uuid' } } } } },
        },
        responses: {
          '200': { description: 'Integrity score with breakdown', content: { 'application/json': { schema: { $ref: '#/components/schemas/IntegrityResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    // pentest-prep (API contract audit): the prior '/ai/integrity' entry
    // (no sub-path) never matched the actual mount — the real route is
    // POST /ai/integrity/compute (above). This GET entry was entirely
    // missing.
    '/ai/integrity/{anchorId}': {
      get: {
        summary: 'Get a stored integrity score',
        description: "Retrieve a previously-computed integrity score for an anchor. Returns 404 if none has been computed yet, or if the anchor does not belong to the caller's org (existence is not leaked).",
        operationId: 'aiGetIntegrityScore',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'anchorId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Stored integrity score', content: { 'application/json': { schema: { $ref: '#/components/schemas/IntegrityResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/ai/review': {
      get: {
        summary: 'List review queue items',
        description: 'Get flagged credentials awaiting admin review. Org-admin only.',
        operationId: 'aiListReviewQueue',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        responses: {
          '200': { description: 'Review queue items', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReviewQueueResponse' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          // pentest-prep: this whole prefix passes through aiFraudGate()
          // (ENABLE_AI_FRAUD) at the router.ts mount — was missing 503.
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    // pentest-prep (API contract audit): mounted and live, missing from the
    // served spec.
    '/ai/review/stats': {
      get: {
        summary: 'Get review queue statistics',
        description: 'Counts of review-queue items by status for the caller\'s org. Org-admin only.',
        operationId: 'aiGetReviewQueueStats',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        responses: {
          '200': {
            description: 'Review queue counts by status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    pending: { type: 'integer' },
                    investigating: { type: 'integer' },
                    escalated: { type: 'integer' },
                    approved: { type: 'integer' },
                    dismissed: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Admin access required to view review queue stats', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/ai/review/{itemId}': {
      patch: {
        summary: 'Apply a review-queue action',
        description: 'Approve, escalate, investigate, or dismiss a flagged review item. Org-admin only.',
        operationId: 'aiApplyReviewAction',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['APPROVE', 'INVESTIGATE', 'ESCALATE', 'DISMISS'] },
                  notes: { type: 'string', maxLength: 2000 },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Review action applied', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, itemId: { type: 'string' }, action: { type: 'string' } } } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Admin access required to review items', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    // ── Phase 1.5 Paid API Endpoints ──────────────────────────────────
    '/anchor': {
      post: {
        summary: 'Submit credential for anchoring',
        description: 'Submit a credential fingerprint for Bitcoin anchoring. Idempotent: returns 200 if fingerprint already exists. Requires an API key with anchor:write or write:anchors.',
        operationId: 'submitAnchor',
        tags: ['Anchoring'],
        'x-arkova-required-scopes': ['anchor:write', 'write:anchors'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: ANCHOR_SUBMIT_REQUEST_BODY,
        responses: ANCHOR_SUBMIT_RESPONSES,
      },
    },
    '/anchor/submit': {
      post: {
        summary: 'Submit credential for anchoring',
        description: 'Compatibility alias for POST /anchor. New integrations should use POST /anchor.',
        operationId: 'submitAnchorAlias',
        tags: ['Anchoring'],
        'x-arkova-alias-for': '/anchor',
        'x-arkova-required-scopes': ['anchor:write', 'write:anchors'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: ANCHOR_SUBMIT_REQUEST_BODY,
        responses: ANCHOR_SUBMIT_RESPONSES,
      },
    },
    '/anchor/import': {
      post: {
        summary: 'Import up to 100 document fingerprints',
        description: 'API-key transport for canonical queue or instant submission. Every row uses the same idempotency, quota, credit, tag, metadata, and recipient-linking rules as single submit. The organization is derived from the authenticated key; caller-supplied cross-tenant org_id is rejected. Recipient assignment requires owner/admin authority: without it every row is still anchored and the recipient-bearing rows report recipient_provisioning_forbidden, rather than the request being rejected.',
        operationId: 'importAnchors',
        tags: ['Anchoring'],
        'x-arkova-required-scopes': ['anchor:write', 'write:anchors'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['action', 'rows'], additionalProperties: false, properties: ANCHOR_IMPORT_PROPERTIES,
        } } } },
        responses: {
          '200': { description: 'Every row created or idempotently skipped', content: { 'application/json': { schema: ANCHOR_IMPORT_RESPONSE } } },
          '207': { description: 'Bounded partial result; at least one row failed while successful rows remain committed and retry-safe', content: { 'application/json': { schema: ANCHOR_IMPORT_RESPONSE } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { description: 'Import request rate limit exceeded' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/anchor-self-service/bulk': {
      post: {
        summary: 'Import up to 100 document fingerprints from the dashboard',
        description: 'JWT bridge for the same canonical import orchestration. The selected personal or organization scope is re-derived from the authenticated caller. Recipient assignment requires owner/admin authority for that organization; a caller without it still gets every anchor, and only the recipient-bearing rows report recipient_provisioning_forbidden.',
        operationId: 'importAnchorsSelfService',
        tags: ['Anchoring'],
        security: [{ SupabaseJWT: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['org_id', 'action', 'rows'], additionalProperties: false, properties: ANCHOR_IMPORT_PROPERTIES,
        } } } },
        responses: {
          '200': { description: 'Every row created or idempotently skipped', content: { 'application/json': { schema: ANCHOR_IMPORT_RESPONSE } } },
          '207': { description: 'Bounded partial result; at least one row failed', content: { 'application/json': { schema: ANCHOR_IMPORT_RESPONSE } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '429': { description: 'Batch-tier rate limit exceeded' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/anchor/{publicId}/submission-status': {
      get: {
        summary: 'Get the caller-scoped durable submission status',
        description: 'Returns queue or instant processing and credit state for an anchor owned by this exact API-key actor and organization scope. Missing and cross-tenant records both return 404. Private tags, internal identifiers, debit reasons, and metadata are never returned.',
        operationId: 'getAnchorSubmissionStatus',
        tags: ['Anchoring'],
        'x-arkova-required-scopes': ['anchor:write', 'write:anchors'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [{ name: 'publicId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Current durable submission status', content: { 'application/json': { schema: { type: 'object', required: ['public_id', 'action', 'anchor_status', 'credit_state', 'instant_status', 'retryable', 'updated_at'], properties: {
            public_id: { type: 'string' },
            action: { type: 'string', enum: ['queue', 'instant'] },
            anchor_status: { type: 'string', enum: ['PENDING', 'BROADCASTING', 'SUBMITTED', 'SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED', 'PENDING_RESOLUTION'] },
            credit_state: { type: 'string', enum: ['pending', 'spent', 'refunded'], nullable: true },
            instant_status: { type: 'string', enum: ['QUEUED', 'PROCESSING', 'NEEDS_CREDIT', 'RETRYABLE', 'HELD', 'SUBMITTED', 'FAILED'], nullable: true },
            retryable: { type: 'boolean', description: 'True only when explicit instant resubmission is eligible to re-arm a never-debited NEEDS_CREDIT intent.' },
            updated_at: { type: 'string', format: 'date-time' },
          } } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { description: 'Submission absent or outside the caller tenant' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/anchor-self-service/{publicId}/submission-status': {
      get: {
        summary: 'Get dashboard submission status for an explicit personal or organization scope',
        description: 'JWT bridge to the canonical caller-scoped status lookup. Supply exactly one of org_id or scope=user. Organization membership is re-derived server-side; absent and cross-tenant submissions are not exposed.',
        operationId: 'getAnchorSelfServiceSubmissionStatus',
        tags: ['Anchoring'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'publicId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'org_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['user'] } },
        ],
        responses: {
          '200': { description: 'Same bounded shape as the API-key submission-status route' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { description: 'Submission absent or outside the selected scope' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
        },
      },
    },
    '/anchor-credits/status': {
      get: {
        summary: 'Get anchor-credit capability and exact selected-pool balance',
        operationId: 'getAnchorCreditStatus',
        tags: ['Anchoring'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'org_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Selected organization or sub-organization pool; membership is checked exactly' },
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['user'] }, description: 'Use the caller personal pool' },
        ],
        responses: {
          '200': { description: 'Current capability and balance', content: { 'application/json': { schema: { type: 'object', properties: { canSecureInstantly: { type: 'boolean' }, creditBalance: { type: 'integer' }, instantSecureCost: { type: 'integer', enum: [1] }, scope: { type: 'string', enum: ['user', 'organization'] }, canPurchase: { type: 'boolean' }, purchaseGuidance: { type: 'string', nullable: true } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Caller cannot access the selected credit pool' },
        },
      },
    },
    '/anchor-credits/purchase': {
      post: {
        summary: 'Purchase anchor credits for the selected pool',
        description: 'Creates a card-only one-time Checkout session at $2 USD per anchor credit. Organization purchases require administrator authority for that exact organization or sub-organization.',
        operationId: 'purchaseAnchorCredits',
        tags: ['Anchoring'],
        security: [{ SupabaseJWT: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer', minimum: 1, maximum: 1000 }, org_id: { type: 'string', format: 'uuid', nullable: true, description: 'Exact target organization pool, or null for the caller personal pool' } } } } } },
        responses: {
          '200': { description: 'Checkout session created', content: { 'application/json': { schema: { type: 'object', properties: { sessionId: { type: 'string' }, url: { type: 'string', format: 'uri' }, quantity: { type: 'integer' }, unitPriceCents: { type: 'integer', enum: [200] }, currency: { type: 'string', enum: ['usd'] }, scope: { type: 'string', enum: ['user', 'organization'] } } } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Organization administrator authority is required for the selected pool' },
        },
      },
    },
    '/attestations': {
      post: {
        summary: 'Create attestation',
        description: 'Create a new public attestation with optional evidence metadata. Collision retry (3x). Requires JWT or API key.',
        operationId: 'createAttestation',
        tags: ['Attestations'],
        security: [{ SupabaseJWT: [] }, { ApiKeyBearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['attestation_type', 'attester_name', 'subject_identifier', 'claims'],
                properties: {
                  anchor_id: { type: 'string', format: 'uuid', description: 'Optional linked anchor UUID for owned credentials' },
                  subject_type: { type: 'string', enum: ['credential', 'entity', 'process', 'asset'], default: 'credential' },
                  subject_identifier: { type: 'string', description: 'Public ID or stable external identifier for the attestation subject' },
                  attestation_type: { type: 'string', enum: ['VERIFICATION', 'ENDORSEMENT', 'AUDIT', 'APPROVAL', 'WITNESS', 'COMPLIANCE', 'SUPPLY_CHAIN', 'IDENTITY', 'CUSTOM'] },
                  attester_name: { type: 'string' },
                  attester_type: { type: 'string', enum: ['INSTITUTION', 'CORPORATION', 'INDIVIDUAL', 'REGULATORY', 'THIRD_PARTY'], default: 'INSTITUTION' },
                  attester_title: { type: 'string' },
                  claims: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 50,
                    items: {
                      type: 'object',
                      required: ['claim'],
                      properties: {
                        claim: { type: 'string' },
                        evidence: { type: 'string' },
                      },
                    },
                  },
                  summary: { type: 'string' },
                  jurisdiction: { type: 'string' },
                  evidence_fingerprint: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
                  evidence: {
                    type: 'array',
                    maxItems: 10,
                    description: 'Evidence metadata only. Arkova stores public metadata and fingerprints, not document bytes.',
                    items: { $ref: '#/components/schemas/AttestationEvidenceInput' },
                  },
                  expires_at: { type: 'string', format: 'date-time', nullable: true },
                  metadata: { $ref: '#/components/schemas/AttestationMetadataInput' },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Attestation created', content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateAttestationResponse' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
      get: {
        summary: 'List attestations',
        description: 'List attestations. Supports cursor-based pagination.',
        operationId: 'listAttestations',
        tags: ['Attestations'],
        security: [],
        parameters: [
          { name: 'anchor_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Filter by linked anchor UUID for owned credentials' },
          { name: 'subject_identifier', in: 'query', schema: { type: 'string' }, description: 'Filter by subject public ID or external identifier' },
          { name: 'attestation_type', in: 'query', schema: { type: 'string' }, description: 'Filter by attestation type' },
          { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Filter by status' },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Pagination cursor (opaque string from previous response)' },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1, minimum: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, minimum: 1, maximum: 100 } },
        ],
        responses: {
          '200': { description: 'Paginated attestation list', content: { 'application/json': { schema: { type: 'object', properties: { attestations: { type: 'array', items: { $ref: '#/components/schemas/Attestation' } }, next_cursor: { type: 'string', nullable: true }, has_more: { type: 'boolean' } } } } } },
        },
      },
    },
    '/attestations/{publicId}': {
      get: {
        summary: 'Get attestation',
        description: 'Retrieve a single public attestation. Omit include to receive the default response shape; pass include=credentials to add a bounded attestor credential chain.',
        operationId: 'getAttestation',
        tags: ['Attestations'],
        security: [],
        parameters: [
          { name: 'publicId', in: 'path', required: true, schema: { type: 'string', minLength: 3 } },
          {
            name: 'include',
            in: 'query',
            required: false,
            style: 'form',
            explode: false,
            schema: { type: 'array', items: { type: 'string', enum: ['credentials'] } },
            description: 'Optional comma-separated include list. Use credentials to include attestor_credentials, capped at the current linked credential plus two parent levels.',
          },
        ],
        responses: {
          '200': { description: 'Attestation details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Attestation' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/attestations/{publicId}/revoke': {
      patch: {
        summary: 'Revoke attestation',
        description: 'Revoke an attestation. Requires ownership (JWT or API key that created it).',
        operationId: 'revokeAttestation',
        tags: ['Attestations'],
        security: [{ SupabaseJWT: [] }, { ApiKeyBearer: [] }],
        parameters: [
          { name: 'publicId', in: 'path', required: true, schema: { type: 'string', minLength: 3 } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { reason: { type: 'string' } } },
            },
          },
        },
        responses: {
          '200': { description: 'Attestation revoked' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '409': { description: 'Already revoked', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    // pentest-prep (API contract audit): batch-create and batch-verify were
    // mounted and live but missing from the served spec.
    '/attestations/batch-create': {
      post: {
        summary: 'Create attestations in batch',
        description: 'Create up to 100 attestations in one request. Requires JWT. Each item is inserted individually (public_id collision retry, 3x); a per-item failure does not fail the batch. Costs no AI credits — metadata is only available when ENABLE_AI_EXTRACTION is on (503 if any item carries metadata while the flag is off).',
        operationId: 'batchCreateAttestations',
        tags: ['Attestations'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['attestations'],
                properties: {
                  attestations: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 100,
                    items: {
                      type: 'object',
                      required: ['attestation_type', 'attester_name', 'subject_identifier', 'claims'],
                      description: 'Same shape as the POST /attestations request body.',
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Batch processed (per-item success/failure — HTTP 201 even with partial failures)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          public_id: { type: 'string' },
                          status: { type: 'string' },
                          fingerprint: { type: 'string' },
                          evidence_count: { type: 'integer' },
                          warning: { type: 'string' },
                          error: { type: 'string' },
                        },
                      },
                    },
                    summary: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        created: { type: 'integer' },
                        failed: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '503': { description: 'Attestation metadata supplied while ENABLE_AI_EXTRACTION is off', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/attestations/batch-verify': {
      post: {
        summary: 'Verify attestations in batch',
        description: 'Look up verification status for up to 100 public IDs in one request. Requires an API key with verify:batch scope.',
        operationId: 'batchVerifyAttestations',
        tags: ['Attestations'],
        'x-arkova-required-scopes': ['verify:batch'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['public_ids'],
                properties: {
                  public_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 3 } },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Per-ID verification results with a summary tally',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          public_id: { type: 'string' },
                          found: { type: 'boolean' },
                          status: { type: 'string' },
                          attestation_type: { type: 'string' },
                          subject_identifier: { type: 'string' },
                          attester: { type: 'object', nullable: true, properties: { name: { type: 'string' }, type: { type: 'string' } } },
                          issued_at: { type: 'string', format: 'date-time', nullable: true },
                          expires_at: { type: 'string', format: 'date-time', nullable: true },
                          chain_proof: {
                            type: 'object',
                            nullable: true,
                            properties: {
                              tx_id: { type: 'string' },
                              block_height: { type: 'integer', nullable: true },
                              timestamp: { type: 'string', format: 'date-time', nullable: true },
                              explorer_url: { type: 'string', nullable: true },
                            },
                          },
                        },
                      },
                    },
                    summary: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        verified: { type: 'integer' },
                        not_found: { type: 'integer' },
                        expired: { type: 'integer' },
                        revoked: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/verify/entity': {
      get: {
        summary: 'Entity verification',
        description: 'Search for an entity across all public records and credentials. x402 payment gate.',
        operationId: 'verifyEntity',
        tags: ['Verification'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        parameters: [
          { name: 'name', in: 'query', required: true, schema: { type: 'string' }, description: 'Entity name to search' },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['person', 'organization', 'any'] }, description: 'Entity type filter' },
        ],
        responses: {
          '200': { description: 'Entity verification results', content: { 'application/json': { schema: { type: 'object', properties: { entity: { type: 'string' }, matches: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } } } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/compliance/check': {
      post: {
        summary: 'Compliance check',
        description: 'Check an entity against SEC filings, Federal Register regulatory actions, and public attestations for a heuristic compliance risk score. x402 payment gate.',
        operationId: 'complianceCheck',
        tags: ['Compliance'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['entity_name'],
                properties: {
                  entity_name: { type: 'string', minLength: 1, maxLength: 200 },
                  // pentest-prep: was documented as ['person','organization'];
                  // the actual Zod enum is ['individual','organization'].
                  entity_type: { type: 'string', enum: ['individual', 'organization'], default: 'organization' },
                  check_types: {
                    type: 'array',
                    default: ['all'],
                    items: { type: 'string', enum: ['sec_filings', 'sanctions', 'regulatory_actions', 'attestations', 'all'] },
                  },
                  jurisdiction: { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Compliance check results with risk score',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    entity: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        type: { type: 'string', enum: ['individual', 'organization'] },
                        jurisdiction: { type: 'string', description: 'Echoes the request jurisdiction; omitted when not supplied.' },
                      },
                    },
                    compliance_status: { type: 'string', enum: ['clear', 'review_required'] },
                    risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
                    total_findings: { type: 'integer' },
                    findings_by_severity: {
                      type: 'object',
                      properties: { critical: { type: 'integer' }, warning: { type: 'integer' }, info: { type: 'integer' } },
                    },
                    findings: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          category: { type: 'string', enum: ['sec_filing', 'regulatory_action', 'attestation'] },
                          severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
                          source: { type: 'string' },
                          title: { type: 'string' },
                          date: { type: 'string', format: 'date-time', nullable: true },
                          source_url: { type: 'string', nullable: true },
                          anchor_status: { type: 'string', nullable: true },
                        },
                      },
                    },
                    checked_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/regulatory/lookup': {
      get: {
        summary: 'Regulatory record lookup',
        description: 'Search public regulatory records (EDGAR, Federal Register, DAPIP, OpenAlex). x402 payment gate.',
        operationId: 'regulatoryLookup',
        tags: ['Compliance'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' },
          { name: 'source', in: 'query', schema: { type: 'string', enum: ['edgar', 'federal_register', 'dapip', 'openAlex', 'all'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: {
          '200': { description: 'Regulatory record search results' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/cle/verify': {
      get: {
        summary: 'CLE verification lookup',
        description: 'Verify Continuing Legal Education credits. Responses use a public-safe allowlist and omit bar numbers, attorney names, raw metadata, internal IDs, filenames, claims, and chain transaction IDs. x402 payment gate.',
        operationId: 'cleVerify',
        tags: ['Compliance'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        parameters: [
          { name: 'bar_number', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'jurisdiction', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Public-safe CLE verification results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jurisdiction: { type: 'string' },
                    compliance_status: { type: 'string', enum: ['compliant', 'deficient', 'unknown'] },
                    summary: {
                      type: 'object',
                      properties: {
                        total_cle_hours: { type: 'number' },
                        ethics_hours: { type: 'number' },
                        credits_by_category: { type: 'object', additionalProperties: { type: 'number' } },
                        total_anchored_records: { type: 'integer' },
                        total_attestations: { type: 'integer' },
                      },
                    },
                    records: {
                      type: 'array',
                      items: CLE_CREDIT_ROW_SCHEMA,
                    },
                    attestations: {
                      type: 'array',
                      items: CLE_ATTESTATION_ROW_SCHEMA,
                    },
                    verified_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/cle/credits': {
      get: {
        summary: 'CLE credit list',
        description: 'List public-safe CLE credit records for a bar number lookup. x402 payment gate.',
        operationId: 'cleCredits',
        tags: ['Compliance'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        parameters: [
          { name: 'bar_number', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'jurisdiction', in: 'query', schema: { type: 'string' } },
          { name: 'period_start', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'period_end', in: 'query', schema: { type: 'string', format: 'date' } },
        ],
        responses: {
          '200': {
            description: 'Public-safe CLE credit rows',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    jurisdiction: { type: 'string' },
                    total_credits: { type: 'integer' },
                    credits: {
                      type: 'array',
                      items: CLE_CREDIT_ROW_SCHEMA,
                    },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/cle/submit': {
      post: {
        summary: 'Submit CLE completion',
        description: 'Submit a CLE course completion. x402 payment gate.',
        operationId: 'cleSubmit',
        tags: ['Compliance'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['bar_number', 'course_title', 'provider_name', 'credit_hours', 'credit_category', 'jurisdiction', 'completion_date'],
                properties: {
                  bar_number: { type: 'string' },
                  attorney_name: { type: 'string' },
                  course_title: { type: 'string' },
                  provider_name: { type: 'string' },
                  provider_accreditation_number: { type: 'string' },
                  credit_hours: { type: 'number' },
                  credit_category: { type: 'string' },
                  delivery_method: { type: 'string' },
                  jurisdiction: { type: 'string' },
                  completion_date: { type: 'string', format: 'date' },
                  course_number: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'CLE completion submitted with public_id only; no internal anchor id or attorney identifier is returned',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['public_id', 'status', 'message', 'credit'],
                  properties: {
                    public_id: { type: 'string' },
                    status: { type: 'string', enum: ['PENDING'] },
                    message: { type: 'string' },
                    credit: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['course_title', 'credit_hours', 'credit_category', 'jurisdiction', 'completion_date'],
                      properties: {
                        course_title: { type: 'string' },
                        credit_hours: { type: 'number' },
                        credit_category: { type: 'string' },
                        jurisdiction: { type: 'string' },
                        completion_date: { type: 'string', format: 'date' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { description: 'Organization attribution unavailable — the submitter\'s organization could not be confirmed; no record was created; retryable', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    // pentest-prep (API contract audit): mounted and live, missing from the
    // served spec. The handler itself is unauthenticated static reference
    // data, but the /cle prefix mounts the same x402 payment-gate middleware
    // as its sibling routes (see /cle/verify, /cle/credits, /cle/submit) —
    // a 402 is possible if ENABLE_X402_PAYMENTS is on and no key/payment
    // is presented, same as the rest of this prefix.
    '/cle/requirements': {
      get: {
        summary: 'List CLE requirements by jurisdiction',
        description: 'Returns the built-in reference table of continuing legal education requirements per US jurisdiction (general-practitioner defaults; newly-admitted/specialist/pro-bono exemptions may apply).',
        operationId: 'getCleRequirements',
        tags: ['Compliance'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }, {}],
        responses: {
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '200': {
            description: 'CLE requirements by jurisdiction',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total_jurisdictions: { type: 'integer' },
                    jurisdictions: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: true,
                        properties: { jurisdiction: { type: 'string' } },
                      },
                    },
                    note: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/nessie/query': {
      post: {
        summary: 'RAG query (Nessie)',
        description: 'Retrieval-augmented generation query against the Arkova knowledge base. Requires JWT + x402 payment.',
        operationId: 'nessieQuery',
        tags: ['AI Intelligence'],
        security: [{ SupabaseJWT: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['query'],
                properties: {
                  query: { type: 'string', minLength: 1, maxLength: 2000, description: 'Natural language question' },
                  max_sources: { type: 'integer', default: 5, maximum: 20, description: 'Max sources to include in response' },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'RAG response with cited sources', content: { 'application/json': { schema: { type: 'object', properties: { answer: { type: 'string' }, sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, relevance: { type: 'number' } } } }, tokens_used: { type: 'integer' } } } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '402': { description: 'Payment required (x402)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    // ── Webhook CRUD (INT-09) ─────────────────────────────────────────────
    '/organizations/sub-orgs': {
      get: {
        summary: 'List affiliated organizations',
        description:
          'List the organizations affiliated with the calling key\'s organization, by public id. Requires the read:orgs scope; orgs:manage also satisfies it. Returns the platform cap and the current count alongside.'
          + SUB_ORG_LIFECYCLE_NOTE
          + SUB_ORG_MOUNT_NOTE,
        operationId: 'listSubOrganizations',
        tags: ['Organizations'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        responses: {
          '200': {
            description: 'Affiliated organizations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sub_orgs', 'count'],
                  properties: {
                    sub_orgs: { type: 'array', items: { $ref: '#/components/schemas/SubOrganization' } },
                    max_sub_orgs: { type: 'integer', nullable: true, description: 'Platform cap on affiliates for this organization; null means the default applies.' },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          '409': SUB_ORG_AMBIGUOUS_CALLER_409,
          ...SUB_ORG_COMMON_RESPONSES,
        },
      },
    },
    '/organizations/sub-orgs/approve': {
      post: {
        summary: 'Approve a pending affiliation',
        description:
          'Approve an organization that has requested affiliation with the calling key\'s organization. Requires the orgs:manage scope. Subject to the platform affiliate cap (409).'
          + SUB_ORG_LIFECYCLE_NOTE
          + SUB_ORG_MOUNT_NOTE,
        operationId: 'approveSubOrganization',
        tags: ['Organizations'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: SUB_ORG_SELECTOR_BODY,
        responses: {
          '200': {
            description: 'Affiliation approved',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SubOrganizationStatus' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '409': {
            description:
              'A state conflict, named by a machine code in `error`: `already_approved`, `sub_org_limit_reached` (the affiliate cap), or `affiliation_changed` (the affiliation moved under the request — re-read and retry). Also `409 ambiguous_caller`: the request presented both a verified session and an API key, and neither credential may be allowed to pick which organization is acting. Send exactly one.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '500': {
            description:
              'audit_write_failed — the affiliation status WAS changed and the audit row could not be written. The two are separate statements, so the change cannot be rolled back from here; the error names the audit write rather than pretending the action failed. A retry is safe and answers 409 already_approved / already_revoked.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '422': { description: 'Request body failed validation', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          ...SUB_ORG_COMMON_RESPONSES,
        },
      },
    },
    '/organizations/sub-orgs/revoke': {
      post: {
        summary: 'Revoke an affiliation',
        description:
          'Revoke the affiliation of an organization affiliated with the calling key\'s organization. Requires the orgs:manage scope. Revocation severs the affiliation; it does not reclaim credits or suspend the organization — use /offboard for that.'
          + SUB_ORG_LIFECYCLE_NOTE
          + SUB_ORG_MOUNT_NOTE,
        operationId: 'revokeSubOrganization',
        tags: ['Organizations'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: SUB_ORG_SELECTOR_BODY,
        responses: {
          '200': {
            description: 'Affiliation revoked',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SubOrganizationStatus' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '409': {
            description:
              'A state conflict, named by a machine code in `error`: `already_revoked` or `affiliation_changed` (the affiliation moved under the request — re-read and retry). Also `409 ambiguous_caller`: the request presented both a verified session and an API key, and neither credential may be allowed to pick which organization is acting. Send exactly one.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '500': {
            description:
              'audit_write_failed — the affiliation status WAS changed and the audit row could not be written. The two are separate statements, so the change cannot be rolled back from here; the error names the audit write rather than pretending the action failed. A retry is safe and answers 409 already_approved / already_revoked.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '422': { description: 'Request body failed validation', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          ...SUB_ORG_COMMON_RESPONSES,
        },
      },
    },
    '/organizations/sub-orgs/credits': {
      post: {
        summary: 'Allocate or reclaim affiliate credits',
        description:
          'Move credits between the calling key\'s organization and one of its approved affiliates. A positive amount allocates, a negative amount reclaims. Requires the orgs:manage scope. The transfer is a single database transaction that re-verifies the affiliation under a row lock.'
          + SUB_ORG_LIFECYCLE_NOTE
          + SUB_ORG_MOUNT_NOTE,
        operationId: 'allocateSubOrganizationCredits',
        tags: ['Organizations'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['org_public_id', 'amount'],
                properties: {
                  org_public_id: SUB_ORG_SELECTOR_PROPERTY,
                  amount: { type: 'integer', description: 'Whole credits. Positive allocates to the affiliate, negative reclaims to the parent. Never zero.', example: 100 },
                  note: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Transfer applied',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['parent_balance', 'child_balance', 'amount'],
                  properties: {
                    parent_balance: { type: 'integer' },
                    child_balance: { type: 'integer' },
                    amount: { type: 'integer' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '409': {
            description: 'insufficient_parent_balance or insufficient_child_balance. A conflict with the current balance, not a payment prompt — nothing here is purchasable in the moment. Also `409 ambiguous_caller`: the request presented both a verified session and an API key, and neither credential may be allowed to pick which organization is acting. Send exactly one.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '422': { description: 'Request body failed validation', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          ...SUB_ORG_COMMON_RESPONSES,
        },
      },
      get: {
        summary: 'Affiliate credit rollup',
        description:
          'Balances for the calling key\'s organization and each of its affiliates. Requires the orgs:manage scope — balances are money data, and the underlying function requires that grant in SQL, so read:orgs alone would publish a contract the database refuses. Balances ONLY: a parent sees what its affiliates spend, never what they secured.'
          + SUB_ORG_LIFECYCLE_NOTE
          + SUB_ORG_MOUNT_NOTE,
        operationId: 'getSubOrganizationCreditRollup',
        tags: ['Organizations'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        responses: {
          '200': {
            description: 'Credit rollup',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['parent_balance', 'children'],
                  properties: {
                    parent_balance: { type: 'integer' },
                    children: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['public_id', 'balance', 'monthly_allocation'],
                        properties: {
                          public_id: { type: 'string' },
                          balance: { type: 'integer' },
                          monthly_allocation: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '409': SUB_ORG_AMBIGUOUS_CALLER_409,
          ...SUB_ORG_COMMON_RESPONSES,
        },
      },
    },
    '/organizations/sub-orgs/offboard': {
      post: {
        summary: 'Offboard an affiliate',
        description:
          'Reclaim an affiliate\'s remaining credits to the parent and then suspend it. Requires the orgs:manage scope. Reclaim, suspension and their audit records commit together in one transaction. A failed transaction rolls back the reclaim; a transport failure does not establish whether it committed. Retrying is safe and never moves the same credits twice. The affiliate\'s anchored records are NOT touched — they stay verifiable after the relationship ends.'
          + SUB_ORG_LIFECYCLE_NOTE
          + SUB_ORG_MOUNT_NOTE,
        operationId: 'offboardSubOrganization',
        tags: ['Organizations'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['org_public_id'],
                properties: {
                  org_public_id: SUB_ORG_SELECTOR_PROPERTY,
                  reason: { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Offboarded',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reclaimed', 'suspended'],
                  properties: {
                    reclaimed: { type: 'integer', description: 'Credits returned to the parent by this call. Zero on a retry that already reclaimed.' },
                    suspended: { type: 'boolean' },
                    already_suspended: { type: 'boolean', description: 'True when the affiliate was already suspended before this call.' },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '409': {
            description: '`409 ambiguous_caller`: the request presented both a verified session and an API key, and neither credential may be allowed to pick which organization is acting. Send exactly one.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '422': { description: 'Request body failed validation', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          ...SUB_ORG_COMMON_RESPONSES,
        },
      },
    },
    '/webhooks': {
      post: {
        summary: 'Register a webhook endpoint',
        description:
          'Register a new webhook endpoint programmatically. Returns the HMAC signing secret ONCE — save it immediately, it cannot be retrieved later. The URL must be HTTPS and is validated against private/internal/cloud-metadata IPs (SSRF protection) with full DNS resolution. Pass `verify: true` to require a synchronous verification ping (the endpoint must echo a challenge token before registration succeeds).',
        operationId: 'createWebhookEndpoint',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', format: 'uri', example: 'https://api.example.com/webhooks/arkova' },
                  events: {
                    type: 'array',
                    items: { type: 'string', enum: WEBHOOK_EVENT_ENUM },
                    default: ['anchor.secured', 'anchor.revoked'],
                  },
                  description: { type: 'string', maxLength: 500, example: 'Production HR system' },
                  verify: { type: 'boolean', description: 'Send a verification ping before persisting' },
                  scope: {
                    type: 'string',
                    enum: ['self', 'self_and_descendants'],
                    default: 'self',
                    description: "Delivery scope (SCRUM-3972). 'self' (default) delivers only this organization's own events. 'self_and_descendants' additionally delivers events owned by organizations whose parent is this organization and whose affiliation is APPROVED — one hop, never upward; such cross-organization payloads always carry org_public_id. Additive and nullable-safe per CLAUDE.md §1.8: omitting it preserves the pre-existing behaviour exactly. The cross-organization delivery it enables is behind a server-side gate that is currently OFF, so an endpoint set to 'self_and_descendants' today behaves exactly like 'self'.",
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Webhook endpoint registered. Secret returned ONCE.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookEndpointWithSecret' },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`), or the key actor is not an ORG_ADMIN.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
      get: {
        summary: 'List webhook endpoints',
        description: "List all webhook endpoints registered to the API key's organization. Paginated. Secrets are never returned.",
        operationId: 'listWebhookEndpoints',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: {
          '200': {
            description: 'List of webhook endpoints',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    webhooks: { type: 'array', items: { $ref: '#/components/schemas/WebhookEndpoint' } },
                    total: { type: 'integer' },
                    limit: { type: 'integer' },
                    offset: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/webhooks/{id}': {
      get: {
        summary: 'Get a webhook endpoint',
        description: 'Retrieve metadata for a single webhook endpoint. Secrets are never returned.',
        operationId: 'getWebhookEndpoint',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'Webhook endpoint metadata',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEndpoint' } } },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      patch: {
        summary: 'Update a webhook endpoint',
        description: 'Partially update a webhook endpoint. Provide any subset of {url, events, description, is_active, scope}. Updating the URL re-validates SSRF protection. An omitted field is left unchanged — in particular an omitted `scope` preserves the stored value. The signing secret cannot be rotated via this endpoint — delete and re-register instead.',
        operationId: 'updateWebhookEndpoint',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri' },
                  events: {
                    type: 'array',
                    items: { type: 'string', enum: WEBHOOK_EVENT_ENUM },
                  },
                  description: { type: 'string', maxLength: 500, nullable: true },
                  is_active: { type: 'boolean' },
                  scope: {
                    type: 'string',
                    enum: ['self', 'self_and_descendants'],
                    description: "Delivery scope (SCRUM-3972). 'self' (default) delivers only this organization's own events. 'self_and_descendants' additionally delivers events owned by organizations whose parent is this organization and whose affiliation is APPROVED — one hop, never upward; such cross-organization payloads always carry org_public_id. Additive and nullable-safe per CLAUDE.md §1.8: omitting it preserves the pre-existing behaviour exactly. The cross-organization delivery it enables is behind a server-side gate that is currently OFF, so an endpoint set to 'self_and_descendants' today behaves exactly like 'self'.",
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Updated webhook endpoint',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEndpoint' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`), or the key actor is not an ORG_ADMIN.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        summary: 'Delete a webhook endpoint',
        description: 'Permanently delete a webhook endpoint. Cascades to delivery logs.',
        operationId: 'deleteWebhookEndpoint',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '204': { description: 'Webhook endpoint deleted' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`), or the key actor is not an ORG_ADMIN.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    // ── Webhook Management ────────────────────────────────────────────────
    '/webhooks/test': {
      post: {
        summary: 'Test webhook endpoint',
        description: 'Send a synthetic test event to a webhook endpoint to verify configuration. The payload includes test: true so consumers can distinguish test from real events.',
        operationId: 'testWebhook',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['endpoint_id'], properties: { endpoint_id: { type: 'string', format: 'uuid' } } } } },
        },
        responses: {
          '200': { description: 'Test delivery result', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, status_code: { type: 'integer' }, response_body: { type: 'string' }, event_id: { type: 'string' } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/webhooks/deliveries': {
      get: {
        summary: 'List webhook deliveries',
        description: 'View recent webhook delivery attempts for self-service debugging. Filter by endpoint_id.',
        operationId: 'listWebhookDeliveries',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [
          { name: 'endpoint_id', in: 'query', schema: { type: 'string', format: 'uuid' }, description: 'Filter by endpoint ID' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 100 } },
        ],
        responses: {
          '200': { description: 'Delivery log entries', content: { 'application/json': { schema: { type: 'object', properties: { deliveries: { type: 'array', items: { $ref: '#/components/schemas/WebhookDelivery' } }, total: { type: 'integer' } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    // pentest-prep (API contract audit): replay + DLQ self-service were
    // mounted and live but missing from the served spec (SCRUM-1172 /
    // HAKI-REQ-03 AC3).
    '/webhooks/deliveries/{id}/replay': {
      post: {
        summary: 'Replay a webhook delivery',
        description: 'Re-fires a previously-attempted delivery using its original payload, signed with a fresh timestamp. Inserts a new delivery log row (idempotency_key=`replay-{id}-{ts}`) — the original attempt is preserved for audit. Cross-org access returns 404.',
        operationId: 'replayWebhookDelivery',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'The delivery log ID to replay' }],
        responses: {
          '200': {
            description: 'Replay attempted (ok reflects whether the retried delivery itself succeeded)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    replayed: { type: 'boolean' },
                    ok: { type: 'boolean' },
                    delivery_id: { type: 'string', format: 'uuid', nullable: true },
                    status_code: { type: 'integer', nullable: true },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'Either the API key does not hold the `webhooks:manage` scope (`insufficient_scope`), or the endpoint URL now targets a private network (SSRF protection re-validated on replay).', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Delivery not found or does not belong to your organization', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'Cannot replay to a disabled webhook endpoint', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/webhooks/dlq': {
      get: {
        summary: 'List dead-lettered webhook deliveries',
        description: 'Self-service dead-letter queue: deliveries that exhausted all retry attempts. ORG_ADMIN only.',
        operationId: 'listWebhookDlq',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, minimum: 1, maximum: 100 } },
        ],
        responses: {
          '200': { description: 'Dead-letter queue entries', content: { 'application/json': { schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`), or the key actor is not an ORG_ADMIN.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/webhooks/dlq/{id}/resolve': {
      post: {
        summary: 'Resolve a dead-lettered webhook delivery',
        description: 'Marks a dead-letter queue entry as resolved (acknowledged). Mutates delivery evidence, so ORG_ADMIN only.',
        operationId: 'resolveWebhookDlqEntry',
        tags: ['Webhooks'],
        'x-arkova-required-scopes': ['webhooks:manage'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'The DLQ entry ID' }],
        responses: {
          '200': { description: 'DLQ entry resolved', content: { 'application/json': { schema: { type: 'object', properties: { resolved: { type: 'boolean' }, id: { type: 'string', format: 'uuid' } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'The API key does not hold the `webhooks:manage` scope (`insufficient_scope`), or the key actor is not an ORG_ADMIN.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'DLQ entry not found or does not belong to your organization', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/folders': {
      get: {
        summary: 'List canonical record folders', operationId: 'listFolders', tags: ['Folders'],
        'x-arkova-required-scopes': ['anchor:read'], security: [{ ApiKeyHeader: [] }, { SupabaseJWT: [] }],
        description: 'Lists one USER or ORG folder tree. Global personal folders are private to their owner. A personal folder with context_org_id is visible to authorized administrators of that approved organization hierarchy. Organization API keys can access only their key organization context.',
        parameters: [
          { name: 'owner_scope', in: 'query', schema: { type: 'string', enum: ['USER', 'ORG'] } },
          { name: 'owner_user_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'org_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'context_org_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: { '200': { description: 'Folder tree rows', content: { 'application/json': { schema: { type: 'object', required: ['folders'], properties: { folders: { type: 'array', items: { $ref: '#/components/schemas/Folder' } } } } } } }, '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' } },
      },
      post: {
        summary: 'Create a folder or subfolder', operationId: 'createFolder', tags: ['Folders'],
        'x-arkova-required-scopes': ['anchor:write'], security: [{ ApiKeyHeader: [] }, { SupabaseJWT: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'owner_scope'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, owner_scope: { type: 'string', enum: ['USER', 'ORG'] }, org_id: { type: 'string', format: 'uuid', nullable: true }, context_org_id: { type: 'string', format: 'uuid', nullable: true }, parent_folder_id: { type: 'string', format: 'uuid', nullable: true } } } } } },
        responses: { '201': { description: 'Folder created', content: { 'application/json': { schema: { type: 'object', properties: { folder: { $ref: '#/components/schemas/Folder' } } } } } }, '400': { $ref: '#/components/responses/BadRequest' }, '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' } },
      },
    },
    '/folders/member-context': {
      get: {
        summary: 'Read an authorized organization member context', operationId: 'getFolderMemberContext', tags: ['Folders'],
        security: [{ SupabaseJWT: [] }],
        description: 'Internal dashboard drill-down. Requires an AAL2 user session and exact or approved-ancestor organization administration. API keys are rejected. Membership is derived from org_members; a profiles.org_id value alone never grants access.',
        parameters: [
          { name: 'owner_user_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'context_org_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': { description: 'Bounded member identity in the requested membership context' },
          '400': { $ref: '#/components/responses/BadRequest' }, '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' }, '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/folders/member-contexts': {
      get: { summary: 'List authorized organization member contexts', operationId: 'listFolderMemberContexts', tags: ['Folders'],
        security: [{ SupabaseJWT: [] }], description: 'Internal AAL2 dashboard roster derived from exact org_members rows. API keys are rejected.',
        parameters: [{ name: 'context_org_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Bounded exact-membership roster' }, '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' }, '403': { $ref: '#/components/responses/Forbidden' } } },
    },
    '/folders/{folderId}': {
      patch: {
        summary: 'Rename or reparent a folder', operationId: 'updateFolder', tags: ['Folders'],
        'x-arkova-required-scopes': ['anchor:write'], security: [{ ApiKeyHeader: [] }, { SupabaseJWT: [] }],
        parameters: [{ name: 'folderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, parent_folder_id: { type: 'string', format: 'uuid', nullable: true } } } } } },
        responses: { '200': { description: 'Folder updated', content: { 'application/json': { schema: { type: 'object', properties: { folder: { $ref: '#/components/schemas/Folder' } } } } } }, '400': { $ref: '#/components/responses/BadRequest' }, '404': { $ref: '#/components/responses/NotFound' } },
      },
      delete: {
        summary: 'Delete an empty folder', operationId: 'deleteFolder', tags: ['Folders'],
        'x-arkova-required-scopes': ['anchor:write'], security: [{ ApiKeyHeader: [] }, { SupabaseJWT: [] }],
        parameters: [{ name: 'folderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '204': { description: 'Folder deleted; its records become Unfiled' }, '404': { $ref: '#/components/responses/NotFound' }, '409': { description: 'Folder still has child folders' } },
      },
    },
    '/folders/{folderId}/connector': {
      put: {
        summary: 'Bind or clear a connector auto-sort destination', operationId: 'bindFolderConnector', tags: ['Folders'],
        'x-arkova-required-scopes': ['anchor:write'], security: [{ ApiKeyHeader: [] }, { SupabaseJWT: [] }],
        description: 'The connection must be active, owned by the same organization or contextual member, and match the provider. Set all three properties to null to clear the binding.',
        parameters: [{ name: 'folderId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['provider', 'source_id', 'connection_id'], properties: { provider: { type: 'string', enum: ['google_drive', 'docusign'], nullable: true }, source_id: { type: 'string', minLength: 1, maxLength: 500, nullable: true }, connection_id: { type: 'string', format: 'uuid', nullable: true } } } } } },
        responses: { '200': { description: 'Connector destination updated', content: { 'application/json': { schema: { type: 'object', properties: { folder: { $ref: '#/components/schemas/Folder' } } } } } }, '403': { $ref: '#/components/responses/Forbidden' }, '404': { $ref: '#/components/responses/NotFound' }, '409': { description: 'Connector source already has a canonical destination' } },
      },
    },
    '/folders/bulk-move': {
      post: {
        summary: 'Move up to 100 records with partial results', operationId: 'bulkMoveFolderRecords', tags: ['Folders'],
        'x-arkova-required-scopes': ['anchor:write'], security: [{ ApiKeyHeader: [] }, { SupabaseJWT: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['folder_id'], oneOf: [{ required: ['anchor_ids'] }, { required: ['record_public_ids'] }], properties: { anchor_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', format: 'uuid' }, description: 'Internal UUID compatibility input for dashboard clients.' }, record_public_ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', pattern: '^ARK-' }, description: 'API-visible record public ids. Outcomes preserve these identifiers.' }, folder_id: { type: 'string', format: 'uuid', nullable: true, description: 'Null moves records to Unfiled.' } } } } } },
        responses: { '200': { description: 'Every record moved', content: { 'application/json': { schema: { $ref: '#/components/schemas/FolderMoveResult' } } } }, '207': { description: 'Authorized records moved; rejected rows are listed independently', content: { 'application/json': { schema: { $ref: '#/components/schemas/FolderMoveResult' } } } }, '400': { $ref: '#/components/responses/BadRequest' }, '401': { $ref: '#/components/responses/Unauthorized' } },
      },
    },
    '/verify/search': {
      get: {
        summary: 'Agentic verification search',
        description:
          'Search returning frozen verification schema results. Designed for AI agents, ATS systems, and background check integrations. Requires API key (not JWT). '
          + 'SCRUM-3906: this route now answers with EITHER a semantic (embedding + cosine-similarity) match OR a lexical (ILIKE substring) match — `search_mode` on '
          + 'the response says which. Semantic is used when ENABLE_SEMANTIC_SEARCH is on and the embed+match RPC succeeds; the route falls back to lexical, never a 503, '
          + 'when the flag is off or that RPC/embedding call fails. Only the semantic path costs an AI credit or emits `similarity`; `issuer_name`, `issued_date`, `expiry_date` '
          + 'and `anchor_timestamp` are omitted (never null) on a lexical result — that path does not query them.',
        operationId: 'agenticVerifySearch',
        tags: ['AI Intelligence', 'Verification'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } },
          { name: 'threshold', in: 'query', schema: { type: 'number', default: 0.75 }, description: 'Semantic-path only; ignored on a lexical-path request.' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 5, maximum: 20 } },
        ],
        responses: {
          '200': {
            description: 'Verification results. `search_mode` (`semantic_vector` | `lexical_substring`) tells the caller which path answered — see the operation description.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                    results: { type: 'array', items: { $ref: '#/components/schemas/VerificationResult' } },
                    count: { type: 'integer' },
                    threshold: { type: 'number', description: 'Echoes the request threshold; not applied on the lexical path.' },
                    search_mode: { type: 'string', enum: ['semantic_vector', 'lexical_substring'] },
                  },
                },
              },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '402': { description: 'No AI credits remaining for the semantic path (flag on, RPC not yet attempted). Retry to get a lexical result instead is NOT automatic on this status — insufficient credits is a distinct condition from a semantic RPC failure.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { description: 'ENABLE_VERIFICATION_API is off (worker-wide gate, applies to all of /api/v1/*). No longer returned for ENABLE_SEMANTIC_SEARCH off — see the operation description.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/integrations/google_drive/folders': {
      get: {
        summary: 'List a Google Drive folder\'s child folders',
        description:
          'Connectors page folder picker (My Drive only — shared drives are not supported). ' +
          'Session-authenticated (Supabase JWT), org-admin only; NOT reachable with an API key. ' +
          'Metadata-only: never returns file content. `hasChildren` is always `null` (unknown) — ' +
          'Drive has no cheap "has subfolders" signal, so every folder renders as expandable.',
        operationId: 'listGoogleDriveFolders',
        tags: ['Integrations'],
        security: [{ SupabaseJWT: [] }],
        parameters: [
          { name: 'org_id', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          {
            name: 'parent',
            in: 'query',
            schema: { type: 'string', default: 'root' },
            description: 'Drive folder id to list, or the literal "root" for My Drive.',
          },
          { name: 'page_token', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Child folders of the requested parent',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    folders: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          hasChildren: { type: 'boolean', nullable: true, description: 'Always null in v1 — unknown.' },
                          driveId: { type: 'string', nullable: true, description: 'Always null in v1 — My Drive only.' },
                        },
                      },
                    },
                    nextPageToken: { type: 'string', description: 'Omitted when there is no further page.' },
                  },
                },
              },
            },
          },
          '400': { description: '`drive=` (shared drive) query param is not supported in v1, or the query failed validation', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { description: 'Google Drive is not connected for this organization (`not_connected`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'The stored OAuth grant cannot list folders (`insufficient_drive_scope`) or the connection needs to be re-authorized (`reconnect_required`)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
          '502': { description: 'Google Drive is unavailable (`drive_unavailable`) — may carry `Retry-After`', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/referrals': {
      get: {
        summary: 'Partner referral code and attributed organizations',
        description:
          'Returns the calling organization\'s active referral code, the link to share, and the organizations that code introduced. '
          + 'The organization is derived from the API key — there is no organization parameter. '
          + 'Identifiers are public ids only. `organization_public_id` is omitted for an organization that has no public id. '
          + 'MEASURED: which organizations presented this code at creation, and when. '
          + 'NOT ASSERTED: any commission, payout, discount or revenue share. No field here feeds billing.',
        operationId: 'listReferrals',
        tags: ['Organizations'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        responses: {
          '200': {
            description: 'Referral code and attributed organizations. An organization with no minted code returns `referral_code: null` and an empty list, not a 404.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['referral_code', 'share_url', 'referred', 'total'],
                  properties: {
                    referral_code: { type: 'string', nullable: true, description: '8 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789, or null when none has been minted.' },
                    share_url: { type: 'string', nullable: true, description: 'Null exactly when referral_code is null.' },
                    referred: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['display_name', 'referred_at', 'verification_status'],
                        properties: {
                          organization_public_id: { type: 'string', description: 'Omitted when the referred organization has no public id.' },
                          display_name: { type: 'string' },
                          referred_at: { type: 'string', format: 'date-time' },
                          verification_status: { type: 'string' },
                        },
                      },
                    },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { description: 'API key lacks the read:orgs scope', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '429': { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key as Bearer token: `Authorization: Bearer ak_live_...`',
      },
      ApiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key via header: `X-API-Key: ak_live_...`',
      },
      SupabaseJWT: {
        type: 'http',
        scheme: 'bearer',
        description: 'Supabase JWT for key management endpoints',
      },
    },
    schemas: {
      Folder: {
        type: 'object', required: ['id', 'public_id', 'name', 'owner_scope', 'created_at', 'updated_at'],
        properties: {
          id: { type: 'string', format: 'uuid' }, public_id: { type: 'string', pattern: '^FLD-[A-F0-9]{16}$' },
          name: { type: 'string' }, owner_scope: { type: 'string', enum: ['USER', 'ORG'] },
          user_id: { type: 'string', format: 'uuid', nullable: true }, org_id: { type: 'string', format: 'uuid', nullable: true },
          context_org_id: { type: 'string', format: 'uuid', nullable: true }, parent_folder_id: { type: 'string', format: 'uuid', nullable: true },
          connector_provider: { type: 'string', enum: ['google_drive', 'docusign'], nullable: true },
          connector_source_id: { type: 'string', nullable: true }, connector_connection_id: { type: 'string', format: 'uuid', nullable: true },
          created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
        },
      },
      FolderMoveResult: {
        type: 'object', required: ['moved', 'failed'], properties: {
          moved: { type: 'array', items: { oneOf: [
            { type: 'string', format: 'uuid' }, { type: 'string', pattern: '^ARK-' },
          ] } },
          failed: { type: 'array', items: { type: 'object', required: ['anchor_id', 'code'], properties: {
            anchor_id: { oneOf: [
              { type: 'string', format: 'uuid' }, { type: 'string', pattern: '^ARK-' },
            ] }, code: { type: 'string' },
          } } },
        },
      },
      VerificationResult: {
        type: 'object',
        description: 'Frozen verification response schema (v1). Fields cannot be removed or changed.',
        required: ['verified'],
        properties: {
          verified: { type: 'boolean' },
          status: { type: 'string', enum: ['ACTIVE', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'PENDING', 'SUBMITTED'] },
          issuer_name: { type: 'string' },
          recipient_identifier: { type: 'string', description: 'Hashed identifier, never raw PII' },
          credential_type: { type: 'string' },
          issued_date: { type: 'string', format: 'date-time', nullable: true },
          expiry_date: { type: 'string', format: 'date-time', nullable: true },
          anchor_timestamp: {
            type: 'string',
            format: 'date-time',
            description:
              'Network Observed Time: the moment the Bitcoin network observed this ' +
              'anchor. Measured from the confirmed block, NOT the time the record was ' +
              'created in Arkova (the two differ by the confirmation interval). ' +
              'Omitted, never null, when no observed time has been measured yet — ' +
              'for example while the anchor is PENDING. Not asserted: anything about ' +
              'the content, authenticity, or legal effect of the underlying document.',
          },
          bitcoin_block: { type: 'integer', nullable: true },
          network_receipt_id: { type: 'string', nullable: true },
          merkle_proof_hash: { type: 'string', nullable: true },
          record_uri: { type: 'string', format: 'uri' },
          jurisdiction: { type: 'string', description: 'Omitted when null, never returned as null' },
          description: { type: 'string', description: 'Immutable credential description, omitted when not present' },
          proof_availability: {
            type: 'string',
            enum: ['per_document', 'root_only'],
            description:
              'SCRUM-2575. Whether a per-document proof can actually be retrieved '
              + 'for this record. `per_document` = a per-document inclusion branch '
              + 'is stored and GET /verify/{publicId}/proof returns it. `root_only` '
              + '= no per-document branch is stored; the fingerprint is committed '
              + 'on-chain via the referenced anchor receipt, but no self-contained '
              + 'offline proof bundle is available. Measured from stored proof data '
              + '— never derived from status. Omitted (never null) for records that '
              + 'have not reached a settled on-chain state (PENDING / SUBMITTED). '
              + 'Additive field (Constitution 1.8); no API version change.',
          },
          proof_availability_note: {
            type: 'string',
            description:
              'SCRUM-2575. Omitted when not applicable, never returned as null. '
              + 'Present exactly when proof_availability is. States what is '
              + 'measured, what is asserted, and what is NOT asserted for that '
              + 'class (Constitution 1.5) — in particular, for root_only records, '
              + 'that no self-contained per-document offline proof is available, '
              + 'and that its absence is not evidence the record is invalid.',
          },
          source: {
            // SCRUM-4507. Enum members are the runtime recognised-marker set
            // itself — the same array `verify.ts` re-exports as
            // VERIFICATION_SOURCE_PROVIDERS — so the served spec can never
            // document a value the endpoint would refuse to emit, or omit one
            // it emits.
            type: 'object',
            properties: {
              provider: {
                type: 'string',
                enum: CONNECTOR_FETCH_SOURCE_MARKERS_SORTED,
                description:
                  'The connected system this record\'s document was retrieved from.',
              },
            },
            description:
              'SCRUM-4507. Which connected document source this record originated '
              + 'from. OMITTED (never null, never an empty object) when the record '
              + 'carries no recognised connector marker — absence means "not '
              + 'stated", NOT "uploaded by a person". '
              + 'Carries the provider label and NOTHING ELSE: no file, folder, '
              + 'shared-drive or revision identifier and no deep link into the '
              + 'source system. This endpoint answers anonymously, so a source '
              + 'identifier here would let any holder of a public record id probe '
              + 'the source system for that object; those identifiers are shown '
              + 'only to the record owner on the authenticated record page. '
              + 'Not asserted: that the document still exists in the source '
              + 'system, is unchanged there, or is reachable by the caller — see '
              + 'fingerprint_rederivability for what the fingerprint does and does '
              + 'not commit. Additive field (Constitution 1.8); no API version '
              + 'change.',
          },
          compliance_controls: {
            // SCRUM-2227: this was declared `type: object`, but the field has
            // always been emitted as a JSON array of control-ID strings. The
            // object form had no working consumer (both first-party SDKs
            // dropped it), so the spec now describes only what is emitted.
            type: 'array',
            items: { type: 'string' },
            nullable: true,
            example: ['SOC2-CC6.1', 'GDPR-5.1f', 'FERPA-99.31'],
            description:
              'API-RICH-01 regulatory control IDs mapped to this anchor. Informational '
              + 'metadata only — see compliance_controls_note, which is always present '
              + 'alongside this field and states what these identifiers do NOT assert. '
              + 'OMITTED for records that are not a current anchored credential '
              + '(REVOKED / EXPIRED / SUPERSEDED / not yet anchored): these identifiers '
              + 'describe a live compliance posture, so listing them for such a record '
              + 'would assert something Arkova does not hold (BUG-2026-06-24-007). '
              + 'Absence is not a statement that the record was never anchored — the '
              + 'anchor receipt fields are unaffected.',
          },
          compliance_controls_note: {
            type: 'string',
            description:
              'SCRUM-2227. Omitted when not applicable, never returned as null. '
              + 'Present whenever compliance_controls is present, absent '
              + 'otherwise. States that control identifiers are a credential-type '
              + 'mapping and NOT an audit, certification, conformity assessment, or '
              + 'attestation — in particular that no identifier asserts qualified '
              + 'status under eIDAS. Additive nullable field (Constitution 1.8); no '
              + 'API version change.',
          },
          chain_confirmations: {
            type: 'integer',
            nullable: true,
            description: 'API-RICH-01 Bitcoin block confirmations at anchor time.',
          },
          parent_public_id: {
            type: 'string',
            nullable: true,
            description: 'API-RICH-01 public ID of the parent anchor; internal UUIDs are never exposed.',
          },
          version_number: {
            type: 'integer',
            nullable: true,
            minimum: 1,
            description: 'API-RICH-01 version in this anchor lineage; omitted when equal to 1.',
          },
          revocation_tx_id: {
            type: 'string',
            nullable: true,
            description: 'API-RICH-01 Bitcoin transaction ID of the revocation when status is REVOKED.',
          },
          revocation_block_height: {
            type: 'integer',
            nullable: true,
            description: 'API-RICH-01 Bitcoin block height at which revocation was anchored.',
          },
          file_mime: {
            type: 'string',
            nullable: true,
            description: 'API-RICH-01 source document MIME type.',
          },
          file_size: {
            type: 'integer',
            nullable: true,
            minimum: 0,
            description: 'API-RICH-01 source document size in bytes.',
          },
          confidence_scores: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
            description: 'API-RICH-02 per-field confidence scores from the latest extraction manifest.',
          },
          sub_type: {
            type: 'string',
            nullable: true,
            description: 'API-RICH-02 fine-grained credential subtype from anchors.sub_type.',
          },
          error: { type: 'string' },
        },
      },
      CtdlCredential: {
        type: 'object',
        description: 'Public CTDL JSON-LD credential projection.',
        required: [
          '@context',
          '@type',
          'ceterms:name',
          'ceterms:offeredBy',
          'ceterms:credentialStatusType',
          'ceterms:dateEffective',
          'ceterms:verificationServiceProfile',
          'ceterms:identifier',
        ],
        additionalProperties: true,
        properties: {
          '@context': {
            type: 'string',
            enum: ['https://credreg.net/ctdl/schema/context/json'],
          },
          '@type': {
            type: 'string',
            pattern: '^ceterms:[A-Za-z][A-Za-z]*$',
          },
          'ceterms:name': { type: 'string' },
          'ceterms:ctid': {
            type: 'string',
            pattern: '^ce-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          },
          'ceterms:offeredBy': {
            type: 'object',
            required: ['@type', 'ceterms:name'],
            additionalProperties: true,
            properties: {
              '@type': { type: 'string', enum: ['ceterms:Organization'] },
              'ceterms:name': { type: 'string' },
              'ceterms:ctid': {
                type: 'string',
                pattern: '^ce-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
              },
              'ceterms:subjectWebpage': { type: 'string', format: 'uri' },
            },
          },
          'ceterms:credentialStatusType': {
            type: 'string',
            enum: ['ceterms:Active', 'ceterms:Revoked', 'ceterms:Expired', 'ceterms:Superseded'],
          },
          'ceterms:dateEffective': { type: 'string', format: 'date-time' },
          'ceterms:verificationServiceProfile': {
            type: 'object',
            required: ['@type', 'ceterms:name', 'ceterms:verificationService'],
            additionalProperties: true,
            properties: {
              '@type': { type: 'string', enum: ['ceterms:VerificationServiceProfile'] },
              'ceterms:name': { type: 'string' },
              'ceterms:verificationService': { type: 'string', format: 'uri' },
            },
          },
          'ceterms:identifier': {
            type: 'object',
            required: ['ceterms:identifierType', 'ceterms:identifierValue'],
            additionalProperties: false,
            properties: {
              'ceterms:identifierType': { type: 'string' },
              'ceterms:identifierValue': { type: 'string' },
            },
          },
          'ceterms:description': { type: 'string' },
          'ceterms:expirationDate': { type: 'string', format: 'date-time' },
          'ceterms:revocationDate': { type: 'string', format: 'date-time' },
          'ceterms:revocationReason': { type: 'string' },
        },
      },
      BatchResponse: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              allOf: [
                { $ref: '#/components/schemas/VerificationResult' },
                { type: 'object', properties: { public_id: { type: 'string' } } },
              ],
            },
          },
          job_id: { type: 'string', format: 'uuid' },
          total: { type: 'integer' },
        },
      },
      JobStatusResponse: {
        type: 'object',
        required: ['job_id', 'status', 'total', 'created_at'],
        properties: {
          job_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['submitted', 'processing', 'complete', 'failed'] },
          total: { type: 'integer' },
          results: { type: 'array', items: { type: 'object' } },
          error_message: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          completed_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      UsageResponse: {
        type: 'object',
        required: ['used', 'limit', 'remaining', 'reset_date', 'month', 'keys'],
        properties: {
          used: { type: 'integer' },
          limit: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['unlimited'] }] },
          remaining: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['unlimited'] }] },
          reset_date: { type: 'string', format: 'date-time' },
          month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
          keys: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key_prefix: { type: 'string' },
                name: { type: 'string' },
                used: { type: 'integer' },
              },
            },
          },
        },
      },
      ApiKeyMasked: {
        type: 'object',
        properties: {
          key_id: { type: 'string', format: 'uuid' },
          key_prefix: { type: 'string' },
	          name: { type: 'string' },
	          scopes: {
	            type: 'array',
	            items: { type: 'string' },
	            'x-arkova-canonical-scopes': API_KEY_SCOPES,
	          },
          is_active: { type: 'boolean' },
          last_used_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          expires_at: { type: 'string', format: 'date-time', nullable: true },
          // SCRUM-5023, §1.8 additive. `is_active` is a stored column and
          // stays exactly what it was — it is TRUE on keys the auth middleware
          // already refuses. `status` is the server's own answer to "is this
          // key usable?", and is the field a client should render.
          status: {
            type: 'string',
            enum: ['active', 'expiring_soon', 'expired', 'revoked'],
            description:
              `Server-derived usability. Prefer this over is_active/expires_at: is_active is a stored flag that stays true on an expired key, while authentication rejects it. expiring_soon means live and expiring within ${EXPIRING_SOON_WINDOW_DAYS} days.`,
          },
          days_until_expiry: {
            type: 'integer',
            nullable: true,
            description:
              'Whole days until expiry — 0 on the final day, negative once past, null when the key does not expire. Deliberately NOT named expires_in_days: that is the REQUEST field on POST/PATCH and means a duration to set, not a countdown to read.',
          },
        },
      },
      ApiKeyCreated: {
        type: 'object',
        properties: {
          key_id: { type: 'string', format: 'uuid' },
          raw_key: { type: 'string', description: 'Shown only once — store it securely' },
          key_prefix: { type: 'string' },
	          name: { type: 'string' },
	          scopes: {
	            type: 'array',
	            items: { type: 'string' },
	            'x-arkova-canonical-scopes': API_KEY_SCOPES,
	          },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ApiError: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
        },
      },
      AttestationEvidenceInput: {
        type: 'object',
        additionalProperties: false,
        required: ['evidence_type', 'fingerprint'],
        properties: {
          evidence_type: { type: 'string', maxLength: 60, default: 'document' },
          fingerprint: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'SHA-256 evidence artifact fingerprint' },
          mime: { type: 'string', nullable: true, maxLength: 255 },
          size: { type: 'integer', minimum: 0, nullable: true },
          filename: { type: 'string', nullable: true, maxLength: 255, description: 'Public-safe evidence filename metadata only' },
          description: { type: 'string', nullable: true, maxLength: 500, description: 'Public-safe evidence description metadata only' },
        },
      },
      AttestationMetadataInput: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional PII-stripped metadata. Accepted only when ENABLE_AI_EXTRACTION is enabled.',
        properties: {
          template: { type: 'string', maxLength: 80 },
          credential_type: { type: 'string', maxLength: 100 },
          credential_sub_type: { type: 'string', maxLength: 100 },
          document_type: { type: 'string', maxLength: 100 },
          issuer_name: { type: 'string', maxLength: 200 },
          issuing_jurisdiction: { type: 'string', maxLength: 100 },
          issued_date: { type: 'string', maxLength: 40 },
          expiration_date: { type: 'string', maxLength: 40 },
          extraction_provider: { type: 'string', maxLength: 80 },
          extraction_confidence: { type: 'number', minimum: 0, maximum: 1 },
          metadata_fingerprint: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        },
      },
      AttestationEvidence: {
        type: 'object',
        required: ['id', 'public_id', 'evidence_type', 'fingerprint', 'created_at'],
        properties: {
          id: { type: 'string', pattern: '^AEV-[A-F0-9]{32}$', description: 'v1 back-compat alias for public_id; never an internal UUID' },
          public_id: { type: 'string', pattern: '^AEV-[A-F0-9]{32}$' },
          evidence_type: { type: 'string' },
          description: { type: 'string', nullable: true },
          fingerprint: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
          mime: { type: 'string', nullable: true },
          size: { type: 'integer', minimum: 0, nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AttestorCredential: {
        type: 'object',
        required: ['public_id', 'status', 'is_current', 'chain_proof', 'record_uri'],
        properties: {
          public_id: { type: 'string' },
          credential_type: { type: 'string', nullable: true },
          status: { type: 'string' },
          fingerprint: { type: 'string', nullable: true },
          version_number: { type: 'integer', nullable: true },
          parent_public_id: { type: 'string', nullable: true },
          is_current: { type: 'boolean' },
          chain_proof: {
            type: 'object',
            nullable: true,
            properties: {
              tx_id: { type: 'string' },
              block_height: { type: 'integer', nullable: true },
              timestamp: { type: 'string', format: 'date-time', nullable: true },
              explorer_url: { type: 'string', format: 'uri', nullable: true },
            },
          },
          record_uri: { type: 'string', format: 'uri' },
        },
      },
      CreateAttestationResponse: {
        type: 'object',
        required: ['public_id', 'attestation_id', 'attestation_type', 'status', 'fingerprint', 'created_at', 'verify_url'],
        properties: {
          public_id: { type: 'string' },
          attestation_id: { type: 'string', description: 'v1 back-compat alias for public_id; never an internal UUID' },
          attestation_type: { type: 'string' },
          status: { type: 'string', enum: ['PENDING'] },
          fingerprint: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
          created_at: { type: 'string', format: 'date-time' },
          verify_url: { type: 'string', format: 'uri' },
          evidence_count: { type: 'integer', minimum: 0 },
          warning: { type: 'string' },
        },
      },
      Attestation: {
        type: 'object',
        required: ['public_id', 'attestation_type', 'status', 'subject_type', 'subject_identifier', 'attester', 'claims', 'evidence', 'evidence_count', 'created_at', 'verify_url'],
        properties: {
          public_id: { type: 'string' },
          attestation_type: { type: 'string', enum: ['VERIFICATION', 'ENDORSEMENT', 'AUDIT', 'APPROVAL', 'WITNESS', 'COMPLIANCE', 'SUPPLY_CHAIN', 'IDENTITY', 'CUSTOM'] },
          status: { type: 'string' },
          subject_type: { type: 'string', enum: ['credential', 'entity', 'process', 'asset'] },
          subject_identifier: { type: 'string' },
          subject: {
            type: 'object',
            deprecated: true,
            description: 'Deprecated v1 compatibility object mirroring subject_type and subject_identifier.',
            properties: {
              type: { type: 'string', enum: ['credential', 'entity', 'process', 'asset'] },
              identifier: { type: 'string' },
            },
          },
          attester: {
            type: 'object',
            required: ['name', 'type'],
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['INSTITUTION', 'CORPORATION', 'INDIVIDUAL', 'REGULATORY', 'THIRD_PARTY'] },
              title: { type: 'string', nullable: true },
            },
          },
          claims: {
            type: 'array',
            items: {
              type: 'object',
              required: ['claim'],
              properties: {
                claim: { type: 'string' },
                evidence: { type: 'string' },
              },
            },
          },
          summary: { type: 'string', nullable: true },
          jurisdiction: { type: 'string', description: 'Omitted when null, never returned as null' },
          fingerprint: { type: 'string', nullable: true, pattern: '^[a-fA-F0-9]{64}$' },
          evidence_fingerprint: { type: 'string', nullable: true, pattern: '^[a-fA-F0-9]{64}$' },
          evidence: { type: 'array', items: { $ref: '#/components/schemas/AttestationEvidence' } },
          evidence_count: { type: 'integer', minimum: 0 },
          chain_proof: {
            type: 'object',
            nullable: true,
            properties: {
              tx_id: { type: 'string' },
              block_height: { type: 'integer', nullable: true },
              timestamp: { type: 'string', format: 'date-time', nullable: true },
              explorer_url: { type: 'string', format: 'uri', nullable: true },
            },
          },
          anchored_at: { type: 'string', format: 'date-time', nullable: true, description: 'Deprecated v1 alias for chain_proof.timestamp' },
          merkle_root: { type: 'string', nullable: true, description: 'Deprecated v1 alias for the chain Merkle root when available' },
          linked_credential: {
            type: 'object',
            nullable: true,
            properties: {
              public_id: { type: 'string' },
              credential_type: { type: 'string', nullable: true },
              verification_status: { type: 'string' },
              verify_url: { type: 'string', format: 'uri' },
            },
          },
          attestor_credentials: {
            type: 'array',
            description: 'Present only with include=credentials. Capped at the current linked credential plus two parent levels.',
            items: { $ref: '#/components/schemas/AttestorCredential' },
          },
          issued_at: { type: 'string', format: 'date-time', nullable: true },
          expires_at: { type: 'string', format: 'date-time', nullable: true },
          revoked_at: { type: 'string', format: 'date-time', nullable: true },
          revocation_reason: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          verify_url: { type: 'string', format: 'uri' },
        },
      },
      WebhookDelivery: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          endpoint_id: { type: 'string', format: 'uuid' },
          event_type: { type: 'string' },
          event_id: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'success', 'retrying', 'failed'] },
          response_status: { type: 'integer', nullable: true },
          error_message: { type: 'string', nullable: true },
          attempt_number: { type: 'integer' },
          delivered_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          next_retry_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      WebhookEndpoint: {
        type: 'object',
        description: 'Webhook endpoint metadata. Signing secret is never returned on read.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          url: { type: 'string', format: 'uri' },
          events: {
            type: 'array',
            items: { type: 'string', enum: WEBHOOK_EVENT_ENUM },
          },
          is_active: { type: 'boolean' },
          description: { type: 'string', nullable: true },
          scope: {
            type: 'string',
            enum: ['self', 'self_and_descendants'],
            description: "Delivery scope (SCRUM-3972). 'self' (default) delivers only this organization's own events. 'self_and_descendants' additionally delivers events owned by organizations whose parent is this organization and whose affiliation is APPROVED — one hop, never upward; such cross-organization payloads always carry org_public_id. Additive and nullable-safe per CLAUDE.md §1.8: omitting it preserves the pre-existing behaviour exactly. The cross-organization delivery it enables is behind a server-side gate that is currently OFF, so an endpoint set to 'self_and_descendants' today behaves exactly like 'self'.",
          },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      WebhookEndpointWithSecret: {
        type: 'object',
        description: 'Webhook endpoint with the HMAC signing secret. Returned ONLY by POST /webhooks at creation time. The secret cannot be retrieved later.',
        allOf: [
          { $ref: '#/components/schemas/WebhookEndpoint' },
          {
            type: 'object',
            properties: {
              secret: {
                type: 'string',
                description: '64-char hex HMAC-SHA256 signing secret. Save it now — it is shown once.',
              },
              warning: { type: 'string' },
            },
          },
        ],
      },
      // ── AI Intelligence Schemas (P8) ────────────────────────────────────
      ExtractionRequest: {
        type: 'object',
        required: ['strippedText', 'credentialType', 'fingerprint'],
        properties: {
          strippedText: { type: 'string', description: 'PII-stripped text from client-side OCR (never raw document text)' },
          credentialType: { type: 'string', enum: ['DIPLOMA', 'CERTIFICATE', 'LICENSE', 'BADGE', 'OTHER'] },
          fingerprint: { type: 'string', description: 'SHA-256 document fingerprint' },
        },
      },
      ExtractionResponse: {
        type: 'object',
        properties: {
          fields: {
            type: 'object',
            description: 'Extracted metadata fields (keys vary by credential type)',
            additionalProperties: { type: 'string' },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Extraction confidence score (0-1)' },
          confidenceScores: {
            type: 'object',
            nullable: true,
            additionalProperties: true,
            description: 'API-RICH-02 per-field confidence scores from the extraction manifest.',
          },
          subType: {
            type: 'string',
            nullable: true,
            description: 'API-RICH-02 fine-grained credential subtype when extracted.',
          },
          description: {
            type: 'string',
            nullable: true,
            description: 'API-RICH-02 human-readable credential summary when extracted.',
          },
          fraudSignals: {
            type: 'array',
            nullable: true,
            description: 'Fraud indicators returned by /ai/extract when emitted; /verify does not return fraudSignals today.',
            items: { type: 'object', additionalProperties: true },
          },
          provider: { type: 'string', description: 'AI provider used (e.g., gemini, cloudflare-workers-ai)' },
          creditsRemaining: { type: 'integer', nullable: true, description: 'AI credits remaining after extraction.' },
          manifestHash: { type: 'string', description: 'Hash of the signed extraction manifest.' },
          degraded: { type: 'boolean', description: 'True when extraction ran in fallback/degraded mode.' },
          fallbackReason: { type: 'string', nullable: true, description: 'Reason extraction used fallback behavior, when applicable.' },
        },
      },
      SearchResponse: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                anchor_id: { type: 'string', format: 'uuid' },
                public_id: { type: 'string' },
                label: { type: 'string' },
                credential_type: { type: 'string' },
                issuer_name: { type: 'string' },
                similarity: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
          total: { type: 'integer' },
          query: { type: 'string' },
          threshold: { type: 'number' },
        },
      },
      AIUsageResponse: {
        type: 'object',
        properties: {
          balance: { type: 'integer', description: 'Remaining AI credits' },
          used: { type: 'integer', description: 'Credits used this month' },
          limit: { oneOf: [{ type: 'integer' }, { type: 'string', enum: ['unlimited'] }] },
          recentEvents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                event_type: { type: 'string' },
                credits_used: { type: 'integer' },
                created_at: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      EmbedRequest: {
        type: 'object',
        required: ['anchorId'],
        properties: {
          anchorId: { type: 'string', format: 'uuid', description: 'Anchor ID to generate embedding for' },
          sourceText: { type: 'string', description: 'Optional PII-stripped text to embed (auto-generated from metadata if omitted)' },
        },
      },
      FeedbackRequest: {
        type: 'object',
        required: ['corrections'],
        properties: {
          corrections: {
            type: 'array',
            items: {
              type: 'object',
              required: ['fieldKey', 'originalValue', 'correctedValue'],
              properties: {
                fieldKey: { type: 'string', description: 'Metadata field name' },
                originalValue: { type: 'string', description: 'Original AI-extracted value' },
                correctedValue: { type: 'string', description: 'Human-corrected value' },
              },
            },
          },
        },
      },
      ReviewQueueResponse: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                anchor_id: { type: 'string', format: 'uuid' },
                public_id: { type: 'string' },
                label: { type: 'string' },
                reason: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'investigating', 'escalated', 'approved', 'dismissed'] },
                integrity_score: { type: 'number' },
                created_at: { type: 'string', format: 'date-time' },
              },
            },
          },
          total: { type: 'integer' },
        },
      },
      SubOrganization: {
        type: 'object',
        required: ['public_id', 'display_name', 'suspended', 'docusign_inherited', 'created_at'],
        properties: {
          public_id: { type: 'string', description: 'Public identifier. The internal uuid is never returned.' },
          display_name: { type: 'string' },
          domain: { type: 'string', nullable: true },
          // The `organizations_verification_status_valid` CHECK as widened by
          // migration 0407 (AUDIT-0424-10). The pre-0407 three-value list
          // published here omitted REJECTED and REQUIRES_INPUT, so a partner
          // validating against this schema would have rejected a value the
          // database has been able to store since 0407 landed.
          verification_status: { type: 'string', nullable: true, enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'REQUIRES_INPUT', null] },
          parent_approval_status: { type: 'string', nullable: true, enum: ['PENDING', 'APPROVED', 'REVOKED', null] },
          suspended: { type: 'boolean' },
          docusign_inherited: { type: 'boolean', description: 'Whether this affiliate currently runs on the parent organization DocuSign connection.' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      SubOrganizationStatus: {
        type: 'object',
        required: ['status', 'public_id'],
        properties: {
          status: { type: 'string', enum: ['APPROVED', 'REVOKED'] },
          public_id: { type: 'string' },
        },
      },
      IntegrityResponse: {
        type: 'object',
        properties: {
          anchorId: { type: 'string', format: 'uuid' },
          overallScore: { type: 'number', minimum: 0, maximum: 100, description: 'Overall integrity score (0-100)' },
          flagged: { type: 'boolean', description: 'True if score < 60 (auto-flagged for review)' },
          breakdown: {
            type: 'object',
            properties: {
              duplicateScore: { type: 'number', description: 'Similarity to existing credentials (lower = more unique)' },
              metadataScore: { type: 'number', description: 'Metadata completeness and consistency' },
              issuerScore: { type: 'number', description: 'Issuer verification confidence' },
            },
          },
        },
      },
    },
    responses: {
      BadRequest: {
        description: 'Invalid request',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      Unauthorized: {
        description: 'Authentication required',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      Forbidden: {
        description: 'Insufficient permissions',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      RateLimited: {
        description: 'Rate limit exceeded',
        headers: {
          'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until retry is allowed' },
        },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
      ServiceUnavailable: {
        description: 'API not enabled (feature flag off)',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      },
    },
  },
  tags: [
    { name: 'Verification', description: 'Credential verification endpoints' },
    { name: 'Anchoring', description: 'Bitcoin anchoring for credential integrity' },
    { name: 'Attestations', description: 'Attestation claims (create, verify, revoke)' },
    { name: 'Compliance', description: 'Regulatory lookups, CLE verification, compliance checks' },
    { name: 'Webhooks', description: 'Webhook management, testing, and delivery logs' },
    { name: 'Folders', description: 'Nested personal and organization record folders' },
    { name: 'Organizations', description: 'Sub-organization management over an organization API key (orgs:manage)' },
    { name: 'Jobs', description: 'Async batch job polling' },
    { name: 'Usage', description: 'API usage and quota monitoring' },
    { name: 'Key Management', description: 'API key lifecycle management (requires Supabase JWT)' },
    { name: 'AI Intelligence', description: 'AI-powered extraction, search, and fraud detection (requires Supabase JWT)' },
    { name: 'Integrations', description: 'Third-party connector metadata endpoints (Google Drive, DocuSign) — session-authenticated, not reachable with an API key' },
  ],
};

// Mount Swagger UI — Nordic Vault dark theme
const nordicVaultCss = `
  html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
  body { margin: 0; background: #0a0f1a; }
  .swagger-ui .topbar { display: none; }
  .swagger-ui .download-url-wrapper { display: none; }
  .swagger-ui { color: #c8d6e5; font-family: 'DM Sans', system-ui, sans-serif; }
  .swagger-ui .info .title { color: #e2e8f0; }
  .swagger-ui .info p, .swagger-ui .info li { color: #94a3b8; }
  .swagger-ui .info a { color: #5eead4; }
  .swagger-ui .scheme-container { background: #111827; border-bottom: 1px solid #1e293b; box-shadow: none; }
  .swagger-ui .opblock-tag { color: #e2e8f0; border-bottom: 1px solid #1e293b; }
  .swagger-ui .opblock-tag:hover { color: #5eead4; }
  .swagger-ui .opblock { background: #111827; border: 1px solid #1e293b; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
  .swagger-ui .opblock .opblock-summary { border-bottom: 1px solid #1e293b; }
  .swagger-ui .opblock .opblock-summary-description { color: #94a3b8; }
  .swagger-ui .opblock .opblock-section-header { background: #0f172a; }
  .swagger-ui .opblock .opblock-section-header h4 { color: #e2e8f0; }
  .swagger-ui .opblock.opblock-get { background: rgba(16,185,129,.08); border-color: rgba(16,185,129,.25); }
  .swagger-ui .opblock.opblock-get .opblock-summary { border-color: rgba(16,185,129,.2); }
  .swagger-ui .opblock.opblock-post { background: rgba(59,130,246,.08); border-color: rgba(59,130,246,.25); }
  .swagger-ui .opblock.opblock-post .opblock-summary { border-color: rgba(59,130,246,.2); }
  .swagger-ui .opblock.opblock-delete { background: rgba(239,68,68,.08); border-color: rgba(239,68,68,.25); }
  .swagger-ui .opblock.opblock-delete .opblock-summary { border-color: rgba(239,68,68,.2); }
  .swagger-ui .opblock.opblock-patch { background: rgba(168,85,247,.08); border-color: rgba(168,85,247,.25); }
  .swagger-ui .opblock.opblock-patch .opblock-summary { border-color: rgba(168,85,247,.2); }
  .swagger-ui .opblock-body pre { background: #0f172a; color: #5eead4; border: 1px solid #1e293b; border-radius: 6px; }
  .swagger-ui .opblock-description-wrapper p { color: #94a3b8; }
  .swagger-ui table thead tr th { color: #94a3b8; border-bottom: 1px solid #1e293b; }
  .swagger-ui table tbody tr td { color: #c8d6e5; border-bottom: 1px solid #1e293b; }
  .swagger-ui .parameter__name { color: #e2e8f0; }
  .swagger-ui .parameter__type { color: #5eead4; font-family: 'JetBrains Mono', monospace; }
  .swagger-ui .parameter__in { color: #64748b; }
  .swagger-ui input[type=text], .swagger-ui textarea, .swagger-ui select {
    background: #0f172a; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px;
  }
  .swagger-ui .btn { border-radius: 6px; }
  .swagger-ui .btn.authorize { color: #5eead4; border-color: #5eead4; }
  .swagger-ui .btn.execute { background: #0d9488; color: #fff; border: none; }
  .swagger-ui .responses-inner { background: transparent; }
  .swagger-ui .response-col_status { color: #5eead4; font-family: 'JetBrains Mono', monospace; }
  .swagger-ui .response-col_description { color: #94a3b8; }
  .swagger-ui .model-box { background: #0f172a; border: 1px solid #1e293b; border-radius: 6px; }
  .swagger-ui .model { color: #c8d6e5; }
  .swagger-ui .model-title { color: #e2e8f0; }
  .swagger-ui section.models { border: 1px solid #1e293b; border-radius: 8px; }
  .swagger-ui section.models h4 { color: #e2e8f0; }
  .swagger-ui .servers > label select { background: #0f172a; color: #e2e8f0; border: 1px solid #334155; }
  .swagger-ui .copy-to-clipboard { background: #1e293b; }
  .swagger-ui .microlight { background: #0f172a !important; color: #5eead4 !important; font-family: 'JetBrains Mono', monospace !important; }
  .swagger-ui .highlight-code .microlight code { color: #5eead4 !important; }
`;

// JSON spec endpoint
router.get('/spec.json', (_req, res) => {
  res.json(openApiSpec);
});

router.use('/', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customCss: nordicVaultCss,
  customSiteTitle: 'Arkova Verification API Docs',
  // Review on PR #2838: the previous arkova-26.vercel.app/favicon.ico was a
  // 404 (verified 2026-09-12). app.arkova.ai serves the brand SVG; the host is
  // allow-listed in DOCS_CSP img-src (middleware/securityHeaders.ts) — change
  // both together.
  customfavIcon: 'https://app.arkova.ai/favicon.svg',
}));

export { router as docsRouter };
