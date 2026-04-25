/**
 * CIBA OpenAPI 3.0 Specification (SCRUM-1122)
 *
 * Closes the CIBA epic DoD gate that requires an OpenAPI doc covering every
 * endpoint shipped in CIBA v1.0. The full Verification API spec lives in
 * `docs.ts`; this module is the authoritative spec for the rules / queue /
 * connector / proof-packet / collision endpoints AND the connector webhook
 * receivers.
 *
 * Source-of-truth alignment: every schema below cross-references the Zod
 * source in either `services/worker/src/rules/schemas.ts` or
 * `services/worker/src/api/queue-resolution.ts`. When those Zod schemas
 * change, this module must be updated in lock-step (CI smoke test verifies
 * the JSON parses and that every endpoint is present).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpecPathItem = Record<string, any>;

interface CibaOpenApiSpec {
  openapi: '3.0.3';
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
  paths: Record<string, SpecPathItem>;
}

const securitySchemes: Record<string, unknown> = {
  OrgAdminBearer: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Supabase JWT for an authenticated org admin (role=ORG_ADMIN OR org_members.role IN (owner, admin)). RLS + per-RPC checks enforce the same constraint at the DB layer.',
  },
  PlatformAdminBearer: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Supabase JWT for a platform admin (profiles.is_platform_admin=true). Used for cross-org operational endpoints; never accepted for org-scoped read paths.',
  },
  WebhookHmac: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Vendor-Signature',
    description:
      'Vendor-signed HMAC over the raw request body. Header name varies per vendor: X-DocuSign-Signature-1 (DocuSign), X-AdobeSign-ClientId-Authentication-Sha256 (Adobe), X-Checkr-Signature (Checkr). All signatures verified via integrations/oauth/hmac.ts.',
  },
};

const TRIGGER_TYPE_ENUM = [
  'ESIGN_COMPLETED',
  'WORKSPACE_FILE_MODIFIED',
  'CONNECTOR_DOCUMENT_RECEIVED',
  'MANUAL_UPLOAD',
  'SCHEDULED_CRON',
  'QUEUE_DIGEST',
  'EMAIL_INTAKE',
];

const schemas: Record<string, unknown> = {
  TriggerType: {
    type: 'string',
    enum: TRIGGER_TYPE_ENUM,
    description: 'Source-of-truth: services/worker/src/rules/schemas.ts (CreateOrgRuleInput.trigger_type).',
  },
  ActionType: {
    type: 'string',
    enum: ['AUTO_ANCHOR', 'FAST_TRACK_ANCHOR', 'QUEUE_FOR_REVIEW', 'FLAG_COLLISION', 'NOTIFY', 'FORWARD_TO_URL'],
    description: 'Source-of-truth: services/worker/src/rules/schemas.ts (CreateOrgRuleInput.action_type).',
  },
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
  },
  // Source: services/worker/src/rules/schemas.ts (CreateOrgRuleInput).
  Rule: {
    type: 'object',
    required: ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config'],
    properties: {
      id: { type: 'string', format: 'uuid', readOnly: true },
      org_id: { type: 'string', format: 'uuid', readOnly: true },
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 1000, nullable: true },
      trigger_type: { $ref: '#/components/schemas/TriggerType' },
      trigger_config: { type: 'object', description: 'Schema varies by trigger_type — see rules/schemas.ts.' },
      action_type: { $ref: '#/components/schemas/ActionType' },
      action_config: { type: 'object', description: 'Schema varies by action_type — see rules/schemas.ts.' },
      enabled: { type: 'boolean', default: false, description: 'New rules always ship disabled per SEC-02.' },
    },
  },
  RuleTestRequest: {
    type: 'object',
    required: ['rule', 'event'],
    properties: {
      rule: { $ref: '#/components/schemas/Rule' },
      event: {
        type: 'object',
        required: ['trigger_type'],
        properties: {
          trigger_type: { $ref: '#/components/schemas/TriggerType' },
          vendor: { type: 'string' },
          filename: { type: 'string' },
          folder_path: { type: 'string' },
          sender_email: { type: 'string', format: 'email' },
          subject: { type: 'string' },
        },
      },
      assume_enabled: { type: 'boolean', default: true },
    },
  },
  RuleTestResponse: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      persisted: { type: 'boolean' },
      matched: { type: 'boolean' },
      reason: { type: 'string' },
      needs_semantic_match: { type: 'boolean' },
      action_type: { type: 'string' },
      action_preview: { type: 'object' },
    },
  },
  PendingResolutionAnchor: {
    type: 'object',
    required: ['public_id', 'fingerprint', 'created_at', 'sibling_count'],
    properties: {
      // SCRUM-1121: API uses `public_id` not internal anchors.id.
      public_id: { type: 'string', maxLength: 50 },
      external_file_id: { type: 'string', nullable: true },
      filename: { type: 'string', nullable: true },
      fingerprint: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      sibling_count: { type: 'integer', minimum: 0 },
    },
  },
  ResolveQueueRequest: {
    type: 'object',
    required: ['external_file_id', 'selected_public_id'],
    properties: {
      external_file_id: { type: 'string', minLength: 1, maxLength: 255 },
      selected_public_id: { type: 'string', minLength: 1, maxLength: 50 },
      reason: { type: 'string', maxLength: 2000 },
    },
    additionalProperties: false,
  },
  ConnectorHealthResponse: {
    type: 'object',
    required: ['connectors', 'generated_at'],
    properties: {
      connectors: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'label', 'kind', 'state'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            kind: { type: 'string', enum: ['live', 'demo', 'gated'] },
            state: { type: 'string', enum: ['connected', 'degraded', 'disconnected'] },
            health_reason: {
              type: 'string',
              nullable: true,
              enum: ['vendor_auth_revoked', 'subscription_expiry', 'processing_failure', 'none', null],
            },
            account_label: { type: 'string', nullable: true },
            last_event_at: { type: 'string', format: 'date-time', nullable: true },
            last_renewal_at: { type: 'string', format: 'date-time', nullable: true },
            next_expires_at: { type: 'string', format: 'date-time', nullable: true },
            last_error: { type: 'string', nullable: true },
          },
        },
      },
      generated_at: { type: 'string', format: 'date-time' },
    },
  },
  ComplianceInboxSummary: {
    type: 'object',
    required: ['counts', 'links', 'generated_at'],
    properties: {
      counts: {
        type: 'object',
        properties: {
          captured_today: { type: 'integer' },
          secured_automatically: { type: 'integer' },
          needs_review: { type: 'integer' },
          failed: { type: 'integer' },
          aging_review: { type: 'integer' },
        },
      },
      links: { type: 'object', additionalProperties: { type: 'string' } },
      generated_at: { type: 'string', format: 'date-time' },
    },
  },
  ProofPacket: {
    type: 'object',
    properties: {
      schema_version: { type: 'integer' },
      execution: { type: 'object' },
      source_event: { type: 'object', nullable: true },
      rule: { type: 'object', nullable: true },
      action: { type: 'object' },
      timestamps: { type: 'object' },
      anchor_receipt: { type: 'object' },
      lineage: { type: 'object' },
      actor: { type: 'object', properties: { user_id: { type: 'string', format: 'uuid' } } },
      generated_at: { type: 'string', format: 'date-time' },
    },
  },
  CollisionContext: {
    type: 'object',
    required: ['external_file_id', 'candidates', 'suggested_terminal_public_id', 'generated_at'],
    properties: {
      external_file_id: { type: 'string' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          required: ['public_id', 'fingerprint', 'created_at'],
          properties: {
            public_id: { type: 'string' },
            fingerprint: { type: 'string' },
            filename: { type: 'string', nullable: true },
            vendor: { type: 'string', nullable: true },
            modified_at: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            size_bytes: { type: 'integer', nullable: true },
          },
        },
      },
      suggested_terminal_public_id: { type: 'string', nullable: true },
      generated_at: { type: 'string', format: 'date-time' },
    },
  },
};

// Helper to keep path entries terse.
function rulesPaths(): Record<string, SpecPathItem> {
  return {
    '/api/rules': {
      get: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'List rules for caller org',
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/Rule' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
          '403': { description: 'No org on profile', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Create a rule (always ships disabled per SEC-02)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Rule' } } },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
              },
            },
          },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/rules/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Get a rule (includes full trigger/action config)',
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Rule' } } } },
          '404': { description: 'Not found' },
        },
      },
      patch: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Patch a rule',
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
      delete: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Hard-delete a rule',
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/api/rules/test': {
      post: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Dry-run a rule (SCRUM-1140) — nothing persisted',
        description: 'Schema is `RuleTestRequest`. Source-of-truth Zod is `services/worker/src/rules/schemas.ts`.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RuleTestRequest' } } },
        },
        responses: {
          '200': {
            description: 'Result',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RuleTestResponse' } } },
          },
        },
      },
    },
    '/api/rules/{id}/run': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Manual run — queue an execution row for the rule',
        responses: {
          '202': { description: 'Queued' },
          '429': { description: 'Rate-limited (5 manual runs per minute per org)' },
        },
      },
    },
    '/api/rules/{id}/executions': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Recent executions for one rule',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/rules/demo-event': {
      post: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Inject a demo event (SCRUM-1144) — admin-only, gated by ENABLE_DEMO_INJECTOR',
        responses: {
          '202': { description: 'Queued' },
          '403': { description: 'Disabled in this environment or not org admin' },
        },
      },
    },
    '/api/rules/draft': {
      post: {
        tags: ['Rules', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Natural-language rule draft (ARK-110) — Gemini-authored, ships disabled',
        responses: { '200': { description: 'Draft' } },
      },
    },
  };
}

function queuePaths(): Record<string, SpecPathItem> {
  return {
    '/api/queue/pending': {
      get: {
        tags: ['Queue', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'List PENDING_RESOLUTION anchors (SCRUM-1011, public_id-keyed per SCRUM-1121)',
        description:
          'Source-of-truth Zod is `services/worker/src/api/queue-resolution.ts`. Returns rows with `public_id` (not internal `anchors.id`) per CLAUDE.md §6.',
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/PendingResolutionAnchor' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/queue/resolve': {
      post: {
        tags: ['Queue', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Confirm terminal version (SCRUM-1011 + SCRUM-1121)',
        description: 'Source-of-truth Zod is `services/worker/src/api/queue-resolution.ts:ResolveQueueInput`.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ResolveQueueRequest' } } },
        },
        responses: {
          '200': {
            description: 'Resolved',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { resolution_id: { type: 'string', format: 'uuid' } } },
              },
            },
          },
          '403': { description: 'Forbidden (not org admin or different org)' },
          '404': { description: 'Selected anchor not found' },
          '409': { description: 'Anchor not in PENDING_RESOLUTION' },
        },
      },
    },
    '/api/queue/run': {
      post: {
        tags: ['Queue', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Force a batch-anchor run for caller org',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/queue/collision/{externalFileId}': {
      parameters: [{ name: 'externalFileId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['Queue', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Collision context with suggested terminal version (SCRUM-1150)',
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CollisionContext' } } },
          },
        },
      },
    },
  };
}

function readPaths(): Record<string, SpecPathItem> {
  return {
    '/api/connectors/health': {
      get: {
        tags: ['Connectors', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Connector setup wizard health dashboard (SCRUM-1146)',
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ConnectorHealthResponse' } } },
          },
        },
      },
    },
    '/api/compliance-inbox/summary': {
      get: {
        tags: ['ComplianceInbox', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Compliance inbox summary (SCRUM-1145)',
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ComplianceInboxSummary' } } },
          },
        },
      },
    },
    '/api/proof-packet/execution/{executionId}': {
      parameters: [{ name: 'executionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        tags: ['ProofPacket', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Audit proof packet export for one execution (SCRUM-1149)',
        responses: {
          '200': {
            description: 'OK — application/json with Content-Disposition: attachment',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ProofPacket' } } },
          },
          '404': { description: 'Execution not found in caller org' },
        },
      },
    },
    '/api/anchors/{publicId}/lineage': {
      parameters: [{ name: 'publicId', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        tags: ['Anchors', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Anchor version lineage (ARK-104)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/anchors/{publicId}/supersede': {
      parameters: [{ name: 'publicId', in: 'path', required: true, schema: { type: 'string' } }],
      post: {
        tags: ['Anchors', 'OrgAdmin'],
        security: [{ OrgAdminBearer: [] }],
        summary: 'Supersede an anchor (ARK-104)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/treasury/health': {
      get: {
        tags: ['Treasury', 'PlatformAdmin'],
        security: [{ PlatformAdminBearer: [] }],
        summary: 'Treasury health (ARK-103, platform-admin only)',
        responses: { '200': { description: 'OK' } },
      },
    },
  };
}

function webhookPaths(): Record<string, SpecPathItem> {
  return {
    '/webhooks/docusign': {
      post: {
        tags: ['Webhook', 'HMAC'],
        security: [{ WebhookHmac: [] }],
        summary: 'DocuSign Connect — envelope-completed receiver (SCRUM-1101)',
        responses: {
          '202': { description: 'Enqueued' },
          '200': { description: 'Acknowledged (duplicate / orphaned)' },
          '401': { description: 'Invalid signature' },
        },
      },
    },
    '/webhooks/adobe-sign': {
      post: {
        tags: ['Webhook', 'HMAC'],
        security: [{ WebhookHmac: [] }],
        summary: 'Adobe Sign agreement-completed receiver (SCRUM-1148)',
        responses: {
          '202': { description: 'Enqueued' },
          '200': { description: 'Acknowledged (duplicate / orphaned / non-completed event)' },
          '401': { description: 'Invalid signature' },
        },
      },
    },
    '/webhooks/checkr': {
      post: {
        tags: ['Webhook', 'HMAC'],
        security: [{ WebhookHmac: [] }],
        summary: 'Checkr report-completed receiver (SCRUM-1030 / 1151)',
        responses: {
          '202': { description: 'Enqueued' },
          '200': { description: 'Acknowledged (duplicate / orphaned / non-completed event)' },
          '401': { description: 'Invalid signature' },
        },
      },
    },
    '/webhooks/veremark': {
      post: {
        tags: ['Webhook', 'HMAC'],
        security: [{ WebhookHmac: [] }],
        summary: 'Veremark check.completed receiver (SCRUM-1030 — gated)',
        responses: {
          '503': { description: 'Vendor gated (default) — see SCRUM-1151 spike doc' },
        },
      },
    },
  };
}

export const cibaOpenApiSpec: CibaOpenApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Arkova CIBA API',
    version: '1.0.0',
    description:
      'Compliance Intelligence + Efficient Batch Anchoring (CIBA) endpoints. Source-of-truth Zod schemas live in `services/worker/src/rules/schemas.ts` and `services/worker/src/api/queue-resolution.ts` — when those change this spec must update in lock-step.',
  },
  servers: [
    { url: 'https://arkova-worker-270018525501.us-central1.run.app', description: 'Production worker' },
    { url: 'http://localhost:3001', description: 'Local development' },
  ],
  components: {
    securitySchemes,
    schemas,
  },
  paths: {
    ...rulesPaths(),
    ...queuePaths(),
    ...readPaths(),
    ...webhookPaths(),
  },
};

export function getCibaOpenApiSpec(): CibaOpenApiSpec {
  return cibaOpenApiSpec;
}
