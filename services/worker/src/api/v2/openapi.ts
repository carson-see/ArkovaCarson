import { Request, Response } from 'express';
import {
  ARKOVA_PUBLIC_ID_PATTERN,
  ORG_PUBLIC_ID_PATTERN,
  SHA256_HEX_PATTERN,
} from './patterns.js';

const searchParameters = [
  { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Search query.' },
  { name: 'type', in: 'query', required: false, schema: { $ref: '#/components/schemas/SearchType' }, description: 'Result type filter. Defaults to all.' },
  { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from the previous response.' },
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, description: 'Maximum results.' },
] as const;

const resourceSearchParameters = searchParameters.filter(parameter => parameter.name !== 'type');
const orgPublicIdPathParameter = {
  name: 'public_id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: ORG_PUBLIC_ID_PATTERN },
  description: 'Organization public ID returned by search or list_orgs.',
} as const;
const anchorPublicIdPathParameter = {
  name: 'public_id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: ARKOVA_PUBLIC_ID_PATTERN },
  description: 'Arkova public ID returned by search.',
} as const;
const fingerprintPathParameter = {
  name: 'fingerprint',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: SHA256_HEX_PATTERN },
  description: 'SHA-256 document fingerprint.',
} as const;

const searchResponses = {
  '200': { description: 'Search results.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
  '400': { $ref: '#/components/responses/ValidationError' },
  '401': { $ref: '#/components/responses/AuthenticationRequired' },
  '403': { $ref: '#/components/responses/InvalidScope' },
  '429': { $ref: '#/components/responses/RateLimited' },
  '500': { $ref: '#/components/responses/InternalError' },
} as const;

function resourceSearchPath(operationId: string, summary: string, description: string) {
  return {
    get: {
      tags: ['Search'],
      operationId,
      summary,
      description,
      parameters: resourceSearchParameters,
      responses: searchResponses,
    },
  } as const;
}

function detailResponses(schemaName: 'OrganizationDetail' | 'RecordDetail' | 'FingerprintDetail' | 'DocumentDetail') {
  return {
    '200': {
      description: 'Resource detail.',
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } },
    },
    '400': { $ref: '#/components/responses/ValidationError' },
    '401': { $ref: '#/components/responses/AuthenticationRequired' },
    '403': { $ref: '#/components/responses/InvalidScope' },
    '404': { $ref: '#/components/responses/NotFound' },
    '429': { $ref: '#/components/responses/RateLimited' },
    '500': { $ref: '#/components/responses/InternalError' },
  } as const;
}

interface ResourceDetailPathOptions {
  operationId: string;
  summary: string;
  description: string;
  toolName: string;
  whenToUse: string;
  args: Record<string, string>;
  auth: string;
  parameters: readonly (typeof orgPublicIdPathParameter | typeof anchorPublicIdPathParameter | typeof fingerprintPathParameter)[];
  schemaName: 'OrganizationDetail' | 'RecordDetail' | 'FingerprintDetail' | 'DocumentDetail';
}

function resourceDetailPath(options: ResourceDetailPathOptions) {
  return {
    get: {
      tags: ['Resource Details'],
      operationId: options.operationId,
      summary: options.summary,
      description: options.description,
      'x-agent-usage': {
        tool_name: options.toolName,
        when_to_use: options.whenToUse,
        arguments: options.args,
        auth: options.auth,
      },
      parameters: options.parameters,
      responses: detailResponses(options.schemaName),
    },
  } as const;
}

function agentToolResponses(schemaName: 'FingerprintVerification' | 'Anchor', okDescription: string, includeNotFound = false) {
  return {
    '200': { description: okDescription, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } } },
    '400': { $ref: '#/components/responses/ValidationError' },
    '401': { $ref: '#/components/responses/AuthenticationRequired' },
    '403': { $ref: '#/components/responses/InvalidScope' },
    ...(includeNotFound ? { '404': { $ref: '#/components/responses/NotFound' } } : {}),
    '429': { $ref: '#/components/responses/RateLimited' },
    '500': { $ref: '#/components/responses/InternalError' },
  } as const;
}

interface AgentToolPathOptions {
  operationId: string;
  summary: string;
  description: string;
  toolName: string;
  whenToUse: string;
  args: Record<string, string>;
  parameter: typeof anchorPublicIdPathParameter | typeof fingerprintPathParameter;
  schemaName: 'FingerprintVerification' | 'Anchor';
  okDescription: string;
  includeNotFound?: boolean;
}

function agentToolPath(options: AgentToolPathOptions) {
  return {
    get: {
      tags: ['Agent Tools'],
      operationId: options.operationId,
      summary: options.summary,
      description: options.description,
      'x-agent-usage': {
        tool_name: options.toolName,
        when_to_use: options.whenToUse,
        arguments: options.args,
        auth: 'Bearer API key with read:records scope.',
      },
      parameters: [options.parameter],
      responses: agentToolResponses(
        options.schemaName,
        options.okDescription,
        options.includeNotFound ?? false,
      ),
    },
  } as const;
}

const nullableStringSchema = { type: ['string', 'null'] } as const;
const nullableIntegerSchema = { type: ['integer', 'null'] } as const;
const nullableDateTimeSchema = { type: ['string', 'null'], format: 'date-time' } as const;
const nullableUriSchema = { type: ['string', 'null'], format: 'uri' } as const;

const publicRecordRequired = [
  'public_id',
  'verified',
  'status',
  'fingerprint',
  'title',
  'description',
  'issuer_name',
  'credential_type',
  'sub_type',
  'issued_date',
  'expiry_date',
  'anchor_timestamp',
  'network_receipt_id',
  'record_uri',
  'compliance_controls',
  'chain_confirmations',
  'parent_public_id',
  'version_number',
  'revocation_tx_id',
  'revocation_block_height',
] as const;

const fingerprintDetailRequired = [
  'verified',
  'status',
  'fingerprint',
  'public_id',
  'title',
  'issuer_name',
  'credential_type',
  'sub_type',
  'description',
  'anchor_timestamp',
  'network_receipt_id',
  'record_uri',
  'compliance_controls',
  'chain_confirmations',
  'parent_public_id',
  'version_number',
  'revocation_tx_id',
  'revocation_block_height',
  'file_mime',
  'file_size',
] as const;

const fileMetadataRequired = ['file_mime', 'file_size'] as const;
const fileMetadataProperties = {
  file_mime: nullableStringSchema,
  file_size: nullableIntegerSchema,
} as const;
const publicRecordReceiptProperties = {
  anchor_timestamp: nullableDateTimeSchema,
  network_receipt_id: nullableStringSchema,
  record_uri: nullableUriSchema,
  compliance_controls: { type: ['object', 'null'], additionalProperties: true },
  chain_confirmations: nullableIntegerSchema,
  parent_public_id: nullableStringSchema,
  version_number: nullableIntegerSchema,
  revocation_tx_id: nullableStringSchema,
  revocation_block_height: nullableIntegerSchema,
} as const;
const publicRecordProperties = {
  public_id: nullableStringSchema,
  verified: { type: 'boolean' },
  status: { type: 'string' },
  fingerprint: nullableStringSchema,
  title: nullableStringSchema,
  description: nullableStringSchema,
  issuer_name: nullableStringSchema,
  credential_type: nullableStringSchema,
  sub_type: nullableStringSchema,
  issued_date: nullableStringSchema,
  expiry_date: nullableStringSchema,
  ...publicRecordReceiptProperties,
} as const;

export const openApiV2Spec = {
  openapi: '3.1.0',
  info: {
    title: 'Arkova Verification API v2',
    version: '0.2.0',
    description:
      'Agent-ready Arkova verification API. Read-only tools are described with operation descriptions and x-agent-usage annotations for MCP, Gemini, and OpenAPI function-call importers. Authenticated API keys default to a 1,000 req/min base bucket; API v2 also applies per-minute scope-aware buckets of read:search 1,000, read:records 500, read:orgs 500, write:anchors 100, and admin:rules 50. Deployments may override the scope buckets via API_V2_RATE_LIMIT_* environment variables.',
  },
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  servers: [
    { url: 'https://api.arkova.ai/v2', description: 'Production API host' },
    { url: 'https://arkova-worker-270018525501.us-central1.run.app/api/v2', description: 'Cloud Run worker path' },
  ],
  security: [{ bearerApiKey: [] }],
  tags: [
    { name: 'Agent Tools', description: 'Read-only operations designed for direct agent tool use.' },
    { name: 'Search', description: 'Search verified organizations, anchors, fingerprints, and documents.' },
    { name: 'Resource Details', description: 'Post-search detail endpoints for API-key clients and agents.' },
  ],
  paths: {
    '/search': {
      get: {
        tags: ['Search'],
        operationId: 'search',
        summary: 'Search verified Arkova records',
        description:
          'Search organizations, anchored records, fingerprints, and documents. Use this as the primary discovery tool before calling get_anchor or verify.',
        'x-agent-usage': {
          tool_name: 'search',
          when_to_use: 'Use when the user asks to find credentials, organizations, documents, or a known fingerprint.',
          arguments: {
            q: 'Natural-language search text or an exact fingerprint.',
            type: 'Optional filter: all, org, record, fingerprint, or document.',
          },
          auth: 'Bearer API key with read:search scope.',
        },
        parameters: searchParameters,
        responses: searchResponses,
      },
    },
    '/organizations': resourceSearchPath(
      'search_organizations',
      'Search organizations visible to the API key',
      'Alias for `/search?type=org`. Returns organization rows scoped to the authenticated API key without internal organization UUIDs.',
    ),
    '/records': resourceSearchPath(
      'search_records',
      'Search verified records',
      'Alias for `/search?type=record`. Returns record-style search results using public identifiers only.',
    ),
    '/fingerprints': resourceSearchPath(
      'search_fingerprints',
      'Search exact fingerprints',
      'Alias for `/search?type=fingerprint`. Use for exact SHA-256 fingerprint discovery before calling verify.',
    ),
    '/documents': resourceSearchPath(
      'search_documents',
      'Search document metadata',
      'Alias for `/search?type=document`. Returns document-oriented search rows using public identifiers only.',
    ),
    '/organizations/{public_id}': resourceDetailPath({
      operationId: 'get_organization',
      summary: 'Get organization detail',
      description: 'Fetch the organization profile for the organization attached to the authenticated API key. Does not return internal organization UUIDs.',
      toolName: 'get_organization',
      whenToUse: 'Use after search or list_orgs returns an organization public_id.',
      args: { public_id: 'Organization public identifier, for example org_acme.' },
      auth: 'Bearer API key with read:orgs scope.',
      parameters: [orgPublicIdPathParameter],
      schemaName: 'OrganizationDetail',
    }),
    '/records/{public_id}': resourceDetailPath({
      operationId: 'get_record',
      summary: 'Get record detail',
      description: 'Fetch public-id-keyed anchor record metadata after search returns a record result. Internal anchor, user, and organization UUIDs are never returned.',
      toolName: 'get_record',
      whenToUse: 'Use after search returns a record public_id and the agent needs verification metadata.',
      args: { public_id: 'Arkova public identifier, for example ARK-DOC-ABCDEF.' },
      auth: 'Bearer API key with read:records scope.',
      parameters: [anchorPublicIdPathParameter],
      schemaName: 'RecordDetail',
    }),
    '/fingerprints/{fingerprint}': resourceDetailPath({
      operationId: 'get_fingerprint',
      summary: 'Get fingerprint detail',
      description: 'Fetch a public-id-backed fingerprint detail record by exact SHA-256 fingerprint. Missing fingerprints return problem+json 404; use verify for the boolean verification workflow.',
      toolName: 'get_fingerprint',
      whenToUse: 'Use when a search result or external workflow supplies an exact SHA-256 fingerprint and the agent needs the linked public record.',
      args: { fingerprint: '64-character lowercase or uppercase SHA-256 hex string.' },
      auth: 'Bearer API key with read:records scope.',
      parameters: [fingerprintPathParameter],
      schemaName: 'FingerprintDetail',
    }),
    '/documents/{public_id}': resourceDetailPath({
      operationId: 'get_document',
      summary: 'Get document detail',
      description: 'Fetch document-oriented public metadata by Arkova public ID. Documents themselves are never returned; this endpoint returns metadata and receipt fields only.',
      toolName: 'get_document',
      whenToUse: 'Use after search returns a document public_id and the agent needs file metadata plus anchor receipt details.',
      args: { public_id: 'Arkova public identifier, for example ARK-DOC-ABCDEF.' },
      auth: 'Bearer API key with read:records scope.',
      parameters: [anchorPublicIdPathParameter],
      schemaName: 'DocumentDetail',
    }),
    '/verify/{fingerprint}': agentToolPath({
      operationId: 'verify',
      summary: 'Verify a document fingerprint',
      description: 'Verify whether a SHA-256 document fingerprint has been anchored in Arkova and return the public receipt metadata when present.',
      toolName: 'verify',
      whenToUse: 'Use when the user has a SHA-256 fingerprint and wants to know whether it is anchored.',
      args: { fingerprint: '64-character lowercase or uppercase SHA-256 hex string.' },
      parameter: fingerprintPathParameter,
      schemaName: 'FingerprintVerification',
      okDescription: 'Verification result.',
    }),
    '/anchors/{public_id}': agentToolPath({
      operationId: 'get_anchor',
      summary: 'Get a public anchor by Arkova ID',
      description: 'Fetch redacted public anchor metadata by Arkova public ID. This is the follow-up call after search returns a public_id.',
      toolName: 'get_anchor',
      whenToUse: 'Use after search returns a public_id or when the user supplies an Arkova public ID.',
      args: { public_id: 'Arkova public identifier, for example ARK-DEG-ABCDEF.' },
      parameter: anchorPublicIdPathParameter,
      schemaName: 'Anchor',
      okDescription: 'Anchor metadata.',
      includeNotFound: true,
    }),
    '/orgs': {
      get: {
        tags: ['Agent Tools'],
        operationId: 'list_orgs',
        summary: 'List organizations available to the API key',
        description:
          'List the organization context attached to the authenticated API key. Agents use this before scoped searches or audit workflows.',
        'x-agent-usage': {
          tool_name: 'list_orgs',
          when_to_use: 'Use at the start of an agent session to learn the caller organization context.',
          arguments: {},
          auth: 'Bearer API key with read:orgs scope.',
        },
        responses: {
          '200': { description: 'Organization list.', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrgList' } } } },
          '401': { $ref: '#/components/responses/AuthenticationRequired' },
          '403': { $ref: '#/components/responses/InvalidScope' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['Agent Tools'],
        operationId: 'get_openapi_v2_spec',
        summary: 'Get the OpenAPI 3.1 agent spec',
        description: 'Return this OpenAPI 3.1 document. This route is public so agent builders can import the schema before authenticating.',
        security: [],
        responses: {
          '200': { description: 'OpenAPI 3.1 document.', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerApiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Arkova API key',
        description: 'Pass an Arkova API key as Authorization: Bearer ak_...',
      },
    },
    responses: {
      ValidationError: { description: 'Request validation failed.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } } } },
      AuthenticationRequired: { description: 'API key missing or invalid.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } } } },
      InvalidScope: { description: 'API key does not grant the required scope.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } } } },
      NotFound: { description: 'Requested resource was not found.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } } } },
      RateLimited: {
        description: 'Rate limit exceeded.',
        headers: {
          'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait before retrying.' },
          'X-RateLimit-Limit': { schema: { type: 'integer' }, description: 'Per-minute scope quota for this API key.' },
          'X-RateLimit-Remaining': { schema: { type: 'integer' }, description: 'Requests remaining in the current scope bucket.' },
          'X-RateLimit-Reset': { schema: { type: 'integer' }, description: 'Unix timestamp when the current scope bucket resets.' },
        },
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } } },
      },
      InternalError: { description: 'Unexpected server error.', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetail' } } } },
    },
    schemas: {
      SearchType: { type: 'string', enum: ['all', 'org', 'record', 'fingerprint', 'document'], default: 'all' },
      SearchResult: {
        type: 'object',
        required: ['type', 'public_id', 'score', 'snippet'],
        properties: {
          type: { $ref: '#/components/schemas/SearchType' },
          public_id: { type: 'string' },
          score: { type: 'number' },
          snippet: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      SearchResponse: {
        type: 'object',
        required: ['results', 'next_cursor'],
        properties: {
          results: { type: 'array', items: { $ref: '#/components/schemas/SearchResult' } },
          next_cursor: { type: ['string', 'null'] },
        },
      },
      FingerprintVerification: {
        type: 'object',
        required: ['verified', 'status', 'fingerprint'],
        properties: {
          verified: { type: 'boolean' },
          status: { type: 'string' },
          fingerprint: { type: 'string' },
          public_id: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          anchor_timestamp: { type: ['string', 'null'], format: 'date-time' },
          network_receipt_id: { type: ['string', 'null'] },
          record_uri: { type: ['string', 'null'], format: 'uri' },
        },
      },
      Anchor: {
        type: 'object',
        required: ['public_id', 'verified', 'status', 'record_uri'],
        properties: {
          public_id: { type: 'string' },
          verified: { type: 'boolean' },
          status: { type: 'string' },
          issuer_name: { type: 'string' },
          credential_type: { type: 'string' },
          issued_date: { type: ['string', 'null'] },
          expiry_date: { type: ['string', 'null'] },
          anchor_timestamp: { type: ['string', 'null'] },
          network_receipt_id: { type: ['string', 'null'] },
          record_uri: { type: 'string', format: 'uri' },
        },
      },
      OrganizationDetail: {
        type: 'object',
        required: ['public_id', 'display_name', 'description', 'domain', 'website_url', 'verification_status', 'industry_tag', 'org_type', 'location', 'logo_url'],
        properties: {
          public_id: { type: 'string' },
          display_name: { type: 'string' },
          description: { type: ['string', 'null'] },
          domain: { type: ['string', 'null'] },
          website_url: { type: ['string', 'null'], format: 'uri' },
          verification_status: { type: ['string', 'null'] },
          industry_tag: { type: ['string', 'null'] },
          org_type: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          logo_url: { type: ['string', 'null'], format: 'uri' },
        },
      },
      RecordDetail: {
        type: 'object',
        required: publicRecordRequired,
        properties: publicRecordProperties,
      },
      FingerprintDetail: {
        type: 'object',
        required: fingerprintDetailRequired,
        properties: {
          ...publicRecordProperties,
          verified: { type: 'boolean' },
          status: { type: 'string' },
          fingerprint: { type: 'string' },
          ...fileMetadataProperties,
        },
      },
      DocumentDetail: {
        type: 'object',
        required: [...publicRecordRequired, ...fileMetadataRequired],
        properties: {
          ...publicRecordProperties,
          ...fileMetadataProperties,
        },
      },
      Org: {
        type: 'object',
        required: ['public_id', 'display_name'],
        properties: {
          public_id: { type: 'string' },
          display_name: { type: 'string' },
          domain: { type: ['string', 'null'] },
          website_url: { type: ['string', 'null'], format: 'uri' },
          verification_status: { type: ['string', 'null'] },
        },
      },
      OrgList: {
        type: 'object',
        required: ['organizations'],
        properties: { organizations: { type: 'array', items: { $ref: '#/components/schemas/Org' } } },
      },
      ProblemDetail: {
        type: 'object',
        required: ['type', 'title', 'status'],
        properties: {
          type: { type: 'string', format: 'uri' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          instance: { type: 'string' },
        },
      },
    },
  },
} as const;

export function apiV2OpenApiHandler(_req: Request, res: Response): void {
  res
    .type('application/json')
    .setHeader('Cache-Control', 'public, max-age=300')
    .json(openApiV2Spec);
}
