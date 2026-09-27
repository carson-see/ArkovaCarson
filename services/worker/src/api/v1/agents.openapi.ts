import { API_KEY_SCOPES } from "../apiScopes.js";

const dualAuth = [{ SupabaseJWT: [] }, { ApiKeyHeader: [] }, {
  ApiKeyBearer: [],
}];
const apiKeyOnly = [{ ApiKeyHeader: [] }, { ApiKeyBearer: [] }];
const response = (schema: string, description: string) => ({
  description,
  content: {
    "application/json": { schema: { $ref: `#/components/schemas/${schema}` } },
  },
});
const agentId = {
  name: "agentId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const commonErrors = {
  "401": {
    description: "Missing, malformed, invalid, revoked, or expired credential",
  },
  "403": { $ref: "#/components/responses/AgentForbidden" },
  "409": { $ref: "#/components/responses/AmbiguousCaller" },
};

export const agentOpenApiPaths = {
  "/agents": {
    get: {
      operationId: "listAgents",
      tags: ["Agents"],
      summary: "List agents in the caller organization",
      description: "JWT members may read. API keys require agents:manage.",
      security: dualAuth,
      "x-arkova-required-scopes": ["agents:manage"],
      responses: {
        "200": response("AgentList", "Tenant-scoped agent list"),
        ...commonErrors,
      },
    },
    post: {
      operationId: "registerAgent",
      tags: ["Agents"],
      summary: "Register an agent",
      description:
        "JWT callers must be organization admins. API keys require agents:manage and cannot delegate scopes they do not hold.",
      security: dualAuth,
      "x-arkova-required-scopes": ["agents:manage"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AgentCreate" },
          },
        },
      },
      responses: {
        "201": response("Agent", "Agent registered"),
        "400": { $ref: "#/components/responses/AgentBadRequest" },
        ...commonErrors,
      },
    },
  },
  "/agents/{agentId}": {
    parameters: [agentId],
    get: {
      operationId: "getAgent",
      tags: ["Agents"],
      summary: "Get an agent and active-key metadata",
      description: "JWT members may read. API keys require agents:manage.",
      security: dualAuth,
      "x-arkova-required-scopes": ["agents:manage"],
      responses: {
        "200": response("Agent", "Tenant-scoped agent"),
        ...commonErrors,
        "404": { description: "Agent not found in caller tenant" },
      },
    },
    patch: {
      operationId: "updateAgent",
      tags: ["Agents"],
      summary: "Update, suspend, or resume an agent",
      description:
        "JWT callers must be organization admins. API keys require agents:manage. Status and accompanying fields commit atomically; machine callers cannot delegate beyond their own scopes and provider-bound agents retain their provider scope ceiling.",
      security: dualAuth,
      "x-arkova-required-scopes": ["agents:manage"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/AgentUpdate" },
          },
        },
      },
      responses: {
        "200": response("Agent", "Agent updated"),
        "400": { $ref: "#/components/responses/AgentBadRequest" },
        ...commonErrors,
        "404": { description: "Agent not found in caller tenant" },
        "409": {
          description:
            "Ambiguous credentials, terminal revocation, or provider-owned suspension blocks the update",
        },
      },
    },
    delete: {
      operationId: "revokeAgent",
      tags: ["Agents"],
      summary: "Terminally revoke an agent and its keys",
      description:
        "JWT callers must be organization admins. API keys require an active, unexpired, same-organization agents:manage credential.",
      security: dualAuth,
      "x-arkova-required-scopes": ["agents:manage"],
      responses: {
        "200": response("AgentRevocationResult", "Agent revoked atomically"),
        ...commonErrors,
        "404": { description: "Agent not found in caller tenant" },
      },
    },
  },
  "/agents/{agentId}/key": {
    post: {
      operationId: "mintAgentKey",
      tags: ["Agents"],
      summary: "Mint an agent API key",
      description:
        "JWT callers must be organization admins. API keys require agents:manage and must satisfy every scope allowed to the target agent. Returns the raw key once; mutations are not automatically retried.",
      parameters: [agentId],
      security: dualAuth,
      "x-arkova-required-scopes": ["agents:manage"],
      responses: {
        "201": response("AgentKeyCreated", "Raw agent key returned once"),
        ...commonErrors,
        "404": { description: "Agent not found in caller tenant" },
        "409": {
          description:
            "Ambiguous credentials or an inactive agent blocks key creation",
        },
      },
    },
  },
  "/agents/computeid/admit": {
    post: {
      operationId: "admitComputeIdAgent",
      tags: ["Agents"],
      summary: "Admit a ComputeID passport agent",
      description:
        "Requires an organization API key with agents:manage. The signed receipt is passed through and verified offline. Requested passport scopes remain subject to the provider allowlist and caller delegation ceiling. Returns the raw agent key once.",
      security: apiKeyOnly,
      "x-arkova-required-scopes": ["agents:manage"],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ComputeIdAdmissionRequest" },
          },
        },
      },
      responses: {
        "201": response(
          "ComputeIdAdmissionResult",
          "Passport bound and raw key returned once",
        ),
        "400": response(
          "ComputeIdAdmissionError",
          "Invalid request or no permitted scopes",
        ),
        "401": response(
          "ComputeIdAdmissionError",
          "Organization API key or valid signed receipt required",
        ),
        "403": response(
          "ComputeIdAdmissionError",
          "Caller delegation ceiling denied",
        ),
        "409": response(
          "ComputeIdAdmissionError",
          "Passport revoked or already bound",
        ),
        "500": response(
          "ComputeIdAdmissionError",
          "Admission unavailable or failed",
        ),
        "503": response(
          "ComputeIdAdmissionError",
          "ComputeID integration disabled",
        ),
      },
    },
  },
};

const scopeArray = {
  type: "array",
  minItems: 1,
  items: { type: "string", enum: [...API_KEY_SCOPES] },
};
export const agentOpenApiSchemas = {
  AgentCreate: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
      agent_type: {
        type: "string",
        enum: [
          "llm_agent",
          "ats_integration",
          "hr_platform",
          "compliance_tool",
          "custom",
        ],
        default: "custom",
      },
      allowed_scopes: { ...scopeArray, default: ["verify"] },
      framework: { type: "string", maxLength: 100 },
      version: { type: "string", maxLength: 50 },
      callback_url: { type: "string", format: "uri", pattern: "^https://" },
      metadata: {
        type: "object",
        additionalProperties: true,
        description:
          "Metadata except the provider-managed computeid namespace.",
      },
    },
  },
  AgentUpdate: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
      allowed_scopes: scopeArray,
      status: { type: "string", enum: ["active", "suspended"] },
      framework: { type: "string", maxLength: 100 },
      version: { type: "string", maxLength: 50 },
      callback_url: {
        type: "string",
        format: "uri",
        pattern: "^https://",
        nullable: true,
      },
    },
  },
  AgentKeySummary: {
    type: "object",
    required: ["id", "name", "key_prefix", "scopes", "is_active", "created_at"],
    additionalProperties: false,
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      key_prefix: { type: "string" },
      scopes: { type: "array", items: { type: "string" } },
      is_active: { type: "boolean" },
      last_used_at: { type: "string", format: "date-time", nullable: true },
      created_at: { type: "string", format: "date-time" },
      expires_at: { type: "string", format: "date-time", nullable: true },
    },
  },
  Agent: {
    type: "object",
    required: ["id", "name", "agent_type", "status", "allowed_scopes"],
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      description: { type: "string", nullable: true },
      agent_type: { type: "string" },
      status: { type: "string", enum: ["active", "suspended", "revoked"] },
      allowed_scopes: { type: "array", items: { type: "string" } },
      framework: { type: "string", nullable: true },
      version: { type: "string", nullable: true },
      callback_url: { type: "string", format: "uri", nullable: true },
      metadata: { type: "object", nullable: true, additionalProperties: true },
      api_keys: {
        type: "array",
        items: { $ref: "#/components/schemas/AgentKeySummary" },
      },
    },
  },
  AgentList: {
    type: "object",
    required: ["agents"],
    properties: {
      agents: { type: "array", items: { $ref: "#/components/schemas/Agent" } },
    },
  },
  AgentRevocationResult: {
    type: "object",
    required: ["status", "agent_id"],
    properties: {
      status: { type: "string", enum: ["revoked"] },
      agent_id: { type: "string", format: "uuid" },
    },
  },
  AgentKeyCreated: {
    type: "object",
    required: [
      "key",
      "key_id",
      "key_prefix",
      "agent_id",
      "agent_name",
      "scopes",
      "created_at",
      "warning",
    ],
    properties: {
      key: {
        type: "string",
        description: "Returned once and never persisted raw.",
      },
      key_id: { type: "string", format: "uuid" },
      key_prefix: { type: "string" },
      agent_id: { type: "string", format: "uuid" },
      agent_name: { type: "string" },
      scopes: { type: "array", items: { type: "string" } },
      created_at: { type: "string", format: "date-time" },
      warning: { type: "string" },
    },
  },
  ComputeIdVerificationReceipt: {
    type: "object",
    required: [
      "passport_id",
      "status",
      "issued_at",
      "expires_at",
      "key_id",
      "receipt_signature",
      "receipt_algorithm",
      "receipt_payload",
    ],
    additionalProperties: true,
    properties: {
      passport_id: { type: "string", format: "uuid" },
      status: { type: "string", minLength: 1, maxLength: 32 },
      signature_valid: { type: "boolean", nullable: true },
      issued_at: { type: "string", format: "date-time", maxLength: 64 },
      expires_at: { type: "string", format: "date-time", maxLength: 64 },
      key_id: { type: "string", pattern: "^[0-9a-f]{16}$" },
      receipt_signature: { type: "string", minLength: 1, maxLength: 4096 },
      receipt_algorithm: { type: "string", minLength: 1, maxLength: 32 },
      receipt_payload: { type: "string", minLength: 2, maxLength: 16384 },
    },
  },
  ComputeIdAdmissionRequest: {
    type: "object",
    required: ["passport_id", "verification_receipt"],
    properties: {
      passport_id: { type: "string", format: "uuid" },
      verification_receipt: {
        $ref: "#/components/schemas/ComputeIdVerificationReceipt",
      },
      name: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 1000 },
      allowed_scopes: {
        ...scopeArray,
        maxItems: 32,
        description:
          "The runtime accepts known API scopes, drops scopes outside the seven-scope passport allowlist, and denies any explicitly requested passport scope above the caller ceiling.",
      },
    },
  },
  ComputeIdAdmissionAgent: {
    type: "object",
    required: [
      "id",
      "name",
      "status",
      "agent_type",
      "allowed_scopes",
      "created_at",
    ],
    properties: {
      id: { type: "string", format: "uuid" },
      name: { type: "string" },
      status: { type: "string", enum: ["active"] },
      agent_type: { type: "string", enum: ["llm_agent"] },
      allowed_scopes: { type: "array", items: { type: "string" } },
      created_at: { type: "string", format: "date-time" },
    },
  },
  ComputeIdBinding: {
    type: "object",
    required: ["issuer", "passport_id", "bound_at", "receipt_expires_at"],
    properties: {
      issuer: { type: "string", enum: ["computeid"] },
      passport_id: { type: "string", format: "uuid" },
      bound_at: { type: "string", format: "date-time" },
      receipt_issued_at: { type: "string", format: "date-time" },
      receipt_expires_at: { type: "string", format: "date-time" },
    },
  },
  ComputeIdAdmissionResult: {
    type: "object",
    required: [
      "agent",
      "binding",
      "key",
      "key_id",
      "key_prefix",
      "scopes",
      "warning",
    ],
    properties: {
      agent: { $ref: "#/components/schemas/ComputeIdAdmissionAgent" },
      binding: { $ref: "#/components/schemas/ComputeIdBinding" },
      key: {
        type: "string",
        description: "Returned once and never persisted raw.",
      },
      key_id: { type: "string", format: "uuid" },
      key_prefix: { type: "string" },
      scopes: { type: "array", items: { type: "string" } },
      warning: { type: "string" },
    },
  },
  AgentError: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        oneOf: [{ type: "string" }, {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {},
            reason: { type: "string" },
            permitted: { type: "array", items: { type: "string" } },
            agent_id: { type: "string", format: "uuid" },
          },
        }],
      },
      message: { type: "string" },
      detail: { type: "string" },
      details: {},
      required: { type: "string" },
      granted: { type: "array", items: { type: "string" } },
      missing: { type: "array", items: { type: "string" } },
      permitted: { type: "array", items: { type: "string" } },
    },
  },
  ComputeIdAdmissionError: { $ref: "#/components/schemas/AgentError" },
};

export const agentOpenApiResponses = {
  AgentBadRequest: response("AgentError", "Invalid lifecycle request"),
  AgentForbidden: response(
    "AgentError",
    "Role, agents:manage, tenant, delegation, or provider scope ceiling denied",
  ),
  AmbiguousCaller: response(
    "AgentError",
    "More than one credential was presented",
  ),
};
