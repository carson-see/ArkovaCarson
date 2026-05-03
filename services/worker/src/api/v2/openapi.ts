import { Request, Response } from 'express';

const ANCHOR_PUBLIC_ID_PARAMETER = {
  name: 'public_id',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^ARK-[A-Z0-9-]{3,60}$' },
  description: 'Arkova public ID.',
} as const;

const FINGERPRINT_PARAMETER = {
  name: 'fingerprint',
  in: 'path',
  required: true,
  schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
  description: 'SHA-256 document fingerprint.',
} as const;

const ORG_PUBLIC_ID_PARAMETER = {
  name: 'public_id',
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 2, maxLength: 128 },
  description: 'Organization public ID.',
} as const;

const ERROR_RESPONSE_REFS = {
  validation: ['400', '#/components/responses/ValidationError'],
  authentication: ['401', '#/components/responses/AuthenticationRequired'],
  invalidScope: ['403', '#/components/responses/InvalidScope'],
  notFound: ['404', '#/components/responses/NotFound'],
  rateLimited: ['429', '#/components/responses/RateLimited'],
  internal: ['500', '#/components/responses/InternalError'],
} as const;

type ErrorResponseKey = keyof typeof ERROR_RESPONSE_REFS;

const RESPONSE_GROUPS = {
  scopedRead: ['authentication', 'invalidScope', 'rateLimited', 'internal'],
  validatedScopedRead: ['validation', 'authentication', 'invalidScope', 'rateLimited', 'internal'],
  detail: ['validation', 'authentication', 'invalidScope', 'notFound', 'rateLimited', 'internal'],
} as const satisfies Record<string, readonly ErrorResponseKey[]>;

function jsonResponse(description: string, schemaRef: string) {
  return {
    description,
    content: { 'application/json': { schema: { $ref: schemaRef } } },
  };
}

function errorResponses(keys: readonly ErrorResponseKey[]) {
  return Object.fromEntries(
    keys.map(key => {
      const [status, ref] = ERROR_RESPONSE_REFS[key];
      return [status, { $ref: ref }];
    }),
  );
}

function responsesWith(description: string, schemaRef: string, errors: readonly ErrorResponseKey[]) {
  return {
    '200': jsonResponse(description, schemaRef),
    ...errorResponses(errors),
  };
}

interface AgentToolGetConfig {
  operationId: string;
  summary: string;
  description: string;
  toolName: string;
  whenToUse: string;
  auth: string;
  responseDescription: string;
  schemaRef: string;
  errors: readonly ErrorResponseKey[];
  parameters?: readonly unknown[];
  usageArgs?: Record<string, string>;
}

function agentToolGet(config: AgentToolGetConfig) {
  return {
    tags: ['Agent Tools'],
    operationId: config.operationId,
    summary: config.summary,
    description: config.description,
    'x-agent-usage': {
      tool_name: config.toolName,
      when_to_use: config.whenToUse,
      arguments: config.usageArgs ?? {},
      auth: config.auth,
    },
    ...(config.parameters ? { parameters: config.parameters } : {}),
    responses: responsesWith(config.responseDescription, config.schemaRef, config.errors),
  };
}

export const openApiV2Spec = {
  openapi: '3.1.0',
  info: {
    title: 'Arkova Verification API v2',
    version: '0.2.0',
    description:
      'Agent-ready Arkova verification API. Read-only tools are described with operation descriptions and x-agent-usage annotations for MCP, Gemini, and OpenAPI function-call importers. Scope-aware quotas are enforced per API key: read:search 1,000/min, read:records 500/min, read:orgs 500/min, write:anchors 100/min, and admin:rules 50/min.',
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
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Search query.' },
          { name: 'type', in: 'query', required: false, schema: { $ref: '#/components/schemas/SearchType' }, description: 'Result type filter. Defaults to all.' },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from the previous response.' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, description: 'Maximum results.' },
        ],
        responses: responsesWith('Search results.', '#/components/schemas/SearchResponse', RESPONSE_GROUPS.validatedScopedRead),
      },
    },
    '/verify/{fingerprint}': {
      get: agentToolGet({
        operationId: 'verify',
        summary: 'Verify a document fingerprint',
        description: 'Verify whether a SHA-256 document fingerprint has been anchored in Arkova and return the public receipt metadata when present.',
        toolName: 'verify',
        whenToUse: 'Use when the user has a SHA-256 fingerprint and wants to know whether it is anchored.',
        usageArgs: { fingerprint: '64-character lowercase or uppercase SHA-256 hex string.' },
        auth: 'Bearer API key with read:records scope.',
        parameters: [FINGERPRINT_PARAMETER],
        responseDescription: 'Verification result.',
        schemaRef: '#/components/schemas/FingerprintVerification',
        errors: RESPONSE_GROUPS.validatedScopedRead,
      }),
    },
    '/anchors/{public_id}': {
      get: agentToolGet({
        operationId: 'get_anchor',
        summary: 'Get a public anchor by Arkova ID',
        description: 'Fetch redacted public anchor metadata by Arkova public ID. This is the follow-up call after search returns a public_id.',
        toolName: 'get_anchor',
        whenToUse: 'Use after search returns a public_id or when the user supplies an Arkova public ID.',
        usageArgs: { public_id: 'Arkova public identifier, for example ARK-DEG-ABCDEF.' },
        auth: 'Bearer API key with read:records scope.',
        parameters: [ANCHOR_PUBLIC_ID_PARAMETER],
        responseDescription: 'Anchor metadata.',
        schemaRef: '#/components/schemas/Anchor',
        errors: RESPONSE_GROUPS.detail,
      }),
    },
    '/orgs': {
      get: agentToolGet({
        operationId: 'list_orgs',
        summary: 'List organizations available to the API key',
        description: 'List the organization context attached to the authenticated API key. Agents use this before scoped searches or audit workflows.',
        toolName: 'list_orgs',
        whenToUse: 'Use at the start of an agent session to learn the caller organization context.',
        auth: 'Bearer API key with read:orgs scope.',
        responseDescription: 'Organization list.',
        schemaRef: '#/components/schemas/OrgList',
        errors: RESPONSE_GROUPS.scopedRead,
      }),
    },
    '/organizations/{public_id}': {
      get: agentToolGet({
        operationId: 'get_organization',
        summary: 'Get organization detail by public ID',
        description: 'Fetch the organization profile visible to the authenticated API key by public_id. The response never exposes the internal organization UUID.',
        toolName: 'get_organization',
        whenToUse: 'Use after search returns an organization public_id and the agent needs organization profile details.',
        usageArgs: { public_id: 'Organization public identifier returned by search, for example org_acme.' },
        auth: 'Bearer API key with read:orgs scope.',
        parameters: [ORG_PUBLIC_ID_PARAMETER],
        responseDescription: 'Organization detail.',
        schemaRef: '#/components/schemas/OrganizationDetail',
        errors: RESPONSE_GROUPS.detail,
      }),
    },
    '/records/{public_id}': {
      get: agentToolGet({
        operationId: 'get_record',
        summary: 'Get record detail by public ID',
        description: 'Fetch public-safe anchor record metadata by public_id. Same-org pending/submitted records are visible to the key owner; other tenants only expose secured records.',
        toolName: 'get_record',
        whenToUse: 'Use after search returns a record public_id and the agent needs metadata, fingerprint, and receipt fields.',
        usageArgs: { public_id: 'Arkova public identifier, for example ARK-DOC-ABCDEF.' },
        auth: 'Bearer API key with read:records scope.',
        parameters: [ANCHOR_PUBLIC_ID_PARAMETER],
        responseDescription: 'Record detail.',
        schemaRef: '#/components/schemas/ResourceDetail',
        errors: RESPONSE_GROUPS.detail,
      }),
    },
    '/fingerprints/{fingerprint}': {
      get: agentToolGet({
        operationId: 'get_fingerprint',
        summary: 'Get fingerprint detail',
        description: 'Fetch the newest visible anchor record for a SHA-256 fingerprint. Returns problem+json when the fingerprint is malformed or absent.',
        toolName: 'get_fingerprint',
        whenToUse: 'Use after search returns a fingerprint hit or when the user supplies a SHA-256 fingerprint and wants the corresponding public record detail.',
        usageArgs: { fingerprint: '64-character lowercase or uppercase SHA-256 hex string.' },
        auth: 'Bearer API key with read:records scope.',
        parameters: [FINGERPRINT_PARAMETER],
        responseDescription: 'Fingerprint detail.',
        schemaRef: '#/components/schemas/ResourceDetail',
        errors: RESPONSE_GROUPS.detail,
      }),
    },
    '/documents/{public_id}': {
      get: agentToolGet({
        operationId: 'get_document',
        summary: 'Get document detail by public ID',
        description: 'Fetch public-safe document metadata by public_id. Raw files, recipient email, org_id, user_id, and internal anchor ids are never returned.',
        toolName: 'get_document',
        whenToUse: 'Use after search returns a document public_id and the agent needs document metadata or public receipt details.',
        usageArgs: { public_id: 'Arkova public identifier, for example ARK-DOC-ABCDEF.' },
        auth: 'Bearer API key with read:records scope.',
        parameters: [ANCHOR_PUBLIC_ID_PARAMETER],
        responseDescription: 'Document detail.',
        schemaRef: '#/components/schemas/ResourceDetail',
        errors: RESPONSE_GROUPS.detail,
      }),
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
        required: ['type', 'id', 'public_id', 'score', 'snippet'],
        properties: {
          type: { $ref: '#/components/schemas/SearchType' },
          id: { type: 'string' },
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
          jurisdiction: { type: ['string', 'null'] },
        },
      },
      Org: {
        type: 'object',
        required: ['id', 'public_id', 'display_name'],
        properties: {
          id: { type: 'string' },
          public_id: { type: 'string' },
          display_name: { type: 'string' },
          domain: { type: ['string', 'null'] },
          website_url: { type: ['string', 'null'], format: 'uri' },
          verification_status: { type: ['string', 'null'] },
        },
      },
      OrganizationDetail: {
        type: 'object',
        required: ['public_id', 'display_name', 'description', 'domain', 'website_url', 'verification_status'],
        properties: {
          public_id: { type: 'string' },
          display_name: { type: 'string' },
          description: { type: ['string', 'null'] },
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
      ResourceDetail: {
        type: 'object',
        required: ['type', 'public_id', 'verified', 'status', 'record_uri'],
        properties: {
          type: { type: 'string', enum: ['record', 'fingerprint', 'document'] },
          public_id: { type: ['string', 'null'] },
          verified: { type: 'boolean' },
          status: { type: 'string' },
          title: { type: ['string', 'null'] },
          description: { type: ['string', 'null'] },
          credential_type: { type: ['string', 'null'] },
          sub_type: { type: ['string', 'null'] },
          fingerprint: { type: ['string', 'null'] },
          issued_date: { type: ['string', 'null'] },
          expiry_date: { type: ['string', 'null'] },
          anchor_timestamp: { type: ['string', 'null'], format: 'date-time' },
          network_receipt_id: { type: ['string', 'null'] },
          record_uri: { type: ['string', 'null'], format: 'uri' },
          metadata: {
            type: 'object',
            additionalProperties: {
              type: ['string', 'number', 'boolean', 'null'],
            },
          },
        },
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
