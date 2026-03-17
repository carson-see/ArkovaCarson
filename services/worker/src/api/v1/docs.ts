/**
 * OpenAPI Documentation (P4.5-TS-04)
 *
 * Serves Swagger UI at /api/docs with the full Verification API spec.
 * Accessible without authentication.
 */

import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';

const router = Router();

/** OpenAPI 3.0 specification for the Verification API */
export const openApiSpec = {
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
                  anchor_timestamp: '2026-03-10T08:00:00Z',
                  bitcoin_block: 204567,
                  network_receipt_id: 'b8e381df09ca404eaae2e5e9d9b3d27567fe97ece39ead718f6d2c77ca60eb57',
                  record_uri: 'https://app.arkova.io/verify/ARK-2026-TEST-001',
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
                    items: { type: 'string', enum: ['verify', 'verify:batch', 'keys:manage', 'usage:read'] },
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
        description: 'Update the name or scopes of an existing API key.',
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
                  scopes: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Key updated' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '404': { $ref: '#/components/responses/NotFound' },
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
          '402': { description: 'Insufficient AI credits' },
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
          '402': { description: 'Insufficient AI credits' },
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
          content: { 'application/json': { schema: { type: 'object', required: ['corrections'], properties: { corrections: { type: 'array', items: { type: 'object', properties: { fieldKey: { type: 'string' }, originalValue: { type: 'string' }, correctedValue: { type: 'string' } } } } } } } },
        },
        responses: {
          '200': { description: 'Feedback recorded' },
          '401': { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/ai/integrity': {
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
          '200': { description: 'Review queue items' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/verify/search': {
      get: {
        summary: 'Agentic verification search',
        description:
          'Semantic search returning frozen verification schema results. Designed for AI agents, ATS systems, and background check integrations. Requires API key (not JWT).',
        operationId: 'agenticVerifySearch',
        tags: ['AI Intelligence', 'Verification'],
        security: [{ ApiKeyBearer: [] }, { ApiKeyHeader: [] }],
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } },
          { name: 'threshold', in: 'query', schema: { type: 'number', default: 0.75 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 5, maximum: 20 } },
        ],
        responses: {
          '200': { description: 'Verification results with similarity scores', content: { 'application/json': { schema: { type: 'object', properties: { results: { type: 'array', items: { $ref: '#/components/schemas/VerificationResult' } }, total: { type: 'integer' } } } } } },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { $ref: '#/components/responses/RateLimited' },
          '503': { $ref: '#/components/responses/ServiceUnavailable' },
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
      VerificationResult: {
        type: 'object',
        description: 'Frozen verification response schema (v1). Fields cannot be removed or changed.',
        required: ['verified'],
        properties: {
          verified: { type: 'boolean' },
          status: { type: 'string', enum: ['ACTIVE', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'PENDING'] },
          issuer_name: { type: 'string' },
          recipient_identifier: { type: 'string', description: 'Hashed identifier, never raw PII' },
          credential_type: { type: 'string' },
          issued_date: { type: 'string', format: 'date-time', nullable: true },
          expiry_date: { type: 'string', format: 'date-time', nullable: true },
          anchor_timestamp: { type: 'string', format: 'date-time' },
          bitcoin_block: { type: 'integer', nullable: true },
          network_receipt_id: { type: 'string', nullable: true },
          merkle_proof_hash: { type: 'string', nullable: true },
          record_uri: { type: 'string', format: 'uri' },
          jurisdiction: { type: 'string', description: 'Omitted when null, never returned as null' },
          error: { type: 'string' },
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
          scopes: { type: 'array', items: { type: 'string' } },
          is_active: { type: 'boolean' },
          last_used_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ApiKeyCreated: {
        type: 'object',
        properties: {
          key_id: { type: 'string', format: 'uuid' },
          raw_key: { type: 'string', description: 'Shown only once — store it securely' },
          key_prefix: { type: 'string' },
          name: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
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
          provider: { type: 'string', description: 'AI provider used (e.g., gemini, cloudflare-workers-ai)' },
          model: { type: 'string', description: 'Model identifier' },
          creditsUsed: { type: 'integer', description: 'AI credits consumed' },
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
    { name: 'Jobs', description: 'Async batch job polling' },
    { name: 'Usage', description: 'API usage and quota monitoring' },
    { name: 'Key Management', description: 'API key lifecycle management (requires Supabase JWT)' },
    { name: 'AI Intelligence', description: 'AI-powered extraction, search, and fraud detection (requires Supabase JWT)' },
  ],
};

// Mount Swagger UI
router.use('/', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Arkova Verification API Docs',
}));

// JSON spec endpoint
router.get('/spec.json', (_req, res) => {
  res.json(openApiSpec);
});

export { router as docsRouter };
