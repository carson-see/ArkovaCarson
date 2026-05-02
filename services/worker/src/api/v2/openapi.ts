import { Request, Response } from 'express';

const SEARCH_PARAMETERS = [
  { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Search query.' },
  { name: 'type', in: 'query', required: false, schema: { $ref: '#/components/schemas/SearchType' }, description: 'Result type filter. Defaults to all.' },
  { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from the previous response.' },
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, description: 'Maximum results.' },
] as const;

const SEARCH_ALIAS_PARAMETERS = SEARCH_PARAMETERS.filter((p) => p.name !== 'type');

const SEARCH_RESPONSES = {
  '200': { description: 'Search results.', content: { 'application/json': { schema: { $ref: '#/components/schemas/SearchResponse' } } } },
  '400': { $ref: '#/components/responses/ValidationError' },
  '401': { $ref: '#/components/responses/AuthenticationRequired' },
  '403': { $ref: '#/components/responses/InvalidScope' },
  '429': { $ref: '#/components/responses/RateLimited' },
  '500': { $ref: '#/components/responses/InternalError' },
} as const;

function searchAliasPath(resourceType: 'org' | 'record' | 'fingerprint' | 'document', operationId: string, summary: string, description: string) {
  return {
    get: {
      tags: ['Search'],
      operationId,
      summary,
      description,
      'x-arkova-alias-for': `/search?type=${resourceType}`,
      parameters: SEARCH_ALIAS_PARAMETERS,
      responses: SEARCH_RESPONSES,
    },
  } as const;
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
        parameters: SEARCH_PARAMETERS,
        responses: SEARCH_RESPONSES,
      },
    },
    '/organizations': searchAliasPath(
      'org',
      'search_organizations',
      'Search organizations',
      'Search the authenticated API key organization context. This is a direct alias for /search?type=org.',
    ),
    '/records': searchAliasPath(
      'record',
      'search_records',
      'Search records',
      'Search anchored records visible to the API key. This is a direct alias for /search?type=record.',
    ),
    '/fingerprints': searchAliasPath(
      'fingerprint',
      'search_fingerprints',
      'Search fingerprints',
      'Search exact document fingerprints visible to the API key. This is a direct alias for /search?type=fingerprint.',
    ),
    '/documents': searchAliasPath(
      'document',
      'search_documents',
      'Search documents',
      'Search document metadata visible to the API key. This is a direct alias for /search?type=document.',
    ),
    '/verify/{fingerprint}': {
      get: {
        tags: ['Agent Tools'],
        operationId: 'verify',
        summary: 'Verify a document fingerprint',
        description:
          'Verify whether a SHA-256 document fingerprint has been anchored in Arkova and return the public receipt metadata when present.',
        'x-agent-usage': {
          tool_name: 'verify',
          when_to_use: 'Use when the user has a SHA-256 fingerprint and wants to know whether it is anchored.',
          arguments: { fingerprint: '64-character lowercase or uppercase SHA-256 hex string.' },
          auth: 'Bearer API key with read:records scope.',
        },
        parameters: [
          { name: 'fingerprint', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' }, description: 'SHA-256 document fingerprint.' },
        ],
        responses: {
          '200': { description: 'Verification result.', content: { 'application/json': { schema: { $ref: '#/components/schemas/FingerprintVerification' } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/AuthenticationRequired' },
          '403': { $ref: '#/components/responses/InvalidScope' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/anchors/{public_id}': {
      get: {
        tags: ['Agent Tools'],
        operationId: 'get_anchor',
        summary: 'Get a public anchor by Arkova ID',
        description:
          'Fetch redacted public anchor metadata by Arkova public ID. This is the follow-up call after search returns a public_id.',
        'x-agent-usage': {
          tool_name: 'get_anchor',
          when_to_use: 'Use after search returns a public_id or when the user supplies an Arkova public ID.',
          arguments: { public_id: 'Arkova public identifier, for example ARK-DEG-ABCDEF.' },
          auth: 'Bearer API key with read:records scope.',
        },
        parameters: [
          { name: 'public_id', in: 'path', required: true, schema: { type: 'string', pattern: '^ARK-[A-Z0-9-]{3,60}$' }, description: 'Arkova public ID.' },
        ],
        responses: {
          '200': { description: 'Anchor metadata.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Anchor' } } } },
          '400': { $ref: '#/components/responses/ValidationError' },
          '401': { $ref: '#/components/responses/AuthenticationRequired' },
          '403': { $ref: '#/components/responses/InvalidScope' },
          '404': { $ref: '#/components/responses/NotFound' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '500': { $ref: '#/components/responses/InternalError' },
        },
      },
    },
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
