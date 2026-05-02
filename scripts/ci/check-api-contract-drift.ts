/**
 * SCRUM-1586 — fail early when agent-facing API contracts drift.
 *
 * The v2 OpenAPI spec, MCP tool descriptions, and MCP argument validators are
 * all developer-facing API contracts. If one changes without the others, agent
 * builders receive one shape while runtime validation accepts another.
 */

import { z } from 'zod';

export interface ContractDriftViolation {
  source: string;
  message: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface OpenApiGetOperation {
  operationId?: string;
  'x-agent-usage'?: {
    tool_name?: string;
  };
}

interface OpenApiSpec {
  paths: Record<string, { get?: OpenApiGetOperation } | undefined>;
}

type ZodObjectLike = z.ZodObject<z.ZodRawShape>;

const AGENT_OPENAPI_PATHS = [
  '/search',
  '/verify/{fingerprint}',
  '/anchors/{public_id}',
  '/orgs',
] as const;

function schemaShape(schema: z.ZodTypeAny): z.ZodRawShape | null {
  if (schema instanceof z.ZodObject) return (schema as ZodObjectLike).shape;

  const candidate = schema as unknown as {
    shape?: z.ZodRawShape;
    _def?: { shape?: z.ZodRawShape | (() => z.ZodRawShape) };
  };
  if (candidate.shape) return candidate.shape;
  if (typeof candidate._def?.shape === 'function') return candidate._def.shape();
  if (candidate._def?.shape) return candidate._def.shape;
  return null;
}

export function zodObjectKeys(schema: z.ZodTypeAny): string[] {
  return Object.keys(schemaShape(schema) ?? {}).sort();
}

export function zodRequiredKeys(schema: z.ZodTypeAny): string[] {
  const shape = schemaShape(schema);
  if (!shape) return [];

  return Object.entries(shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key)
    .sort();
}

export function collectMcpContractDrift(
  definitions: ToolDefinition[],
  schemas: Record<string, z.ZodTypeAny>,
): ContractDriftViolation[] {
  const violations: ContractDriftViolation[] = [];
  const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const definitionNames = [...definitionByName.keys()].sort();
  const schemaNames = Object.keys(schemas).sort();

  const missingDefinitions = schemaNames.filter((name) => !definitionByName.has(name));
  const missingSchemas = definitionNames.filter((name) => !schemas[name]);

  for (const name of missingDefinitions) {
    violations.push({ source: `mcp:${name}`, message: 'validator schema exists without a tool definition' });
  }

  for (const name of missingSchemas) {
    violations.push({ source: `mcp:${name}`, message: 'tool definition exists without a validator schema' });
  }

  for (const name of definitionNames.filter((candidate) => schemas[candidate])) {
    const definition = definitionByName.get(name)!;
    const schema = schemas[name];
    const definedProperties = Object.keys(definition.inputSchema.properties).sort();
    const schemaProperties = zodObjectKeys(schema);
    const definedRequired = [...definition.inputSchema.required].sort();
    const schemaRequired = zodRequiredKeys(schema);

    if (JSON.stringify(definedProperties) !== JSON.stringify(schemaProperties)) {
      violations.push({
        source: `mcp:${name}`,
        message: `tool definition properties ${definedProperties.join(',') || '(none)'} differ from validator properties ${schemaProperties.join(',') || '(none)'}`,
      });
    }

    if (JSON.stringify(definedRequired) !== JSON.stringify(schemaRequired)) {
      violations.push({
        source: `mcp:${name}`,
        message: `tool definition required args ${definedRequired.join(',') || '(none)'} differ from validator required args ${schemaRequired.join(',') || '(none)'}`,
      });
    }
  }

  return violations;
}

export function collectOpenApiAgentDrift(
  spec: OpenApiSpec,
  schemas: Record<string, z.ZodTypeAny>,
): ContractDriftViolation[] {
  const violations: ContractDriftViolation[] = [];

  for (const path of AGENT_OPENAPI_PATHS) {
    const operation = spec.paths[path]?.get;
    const operationId = operation?.operationId;
    const toolName = operation?.['x-agent-usage']?.tool_name;

    if (!operationId) {
      violations.push({ source: `openapi:${path}`, message: 'missing operationId' });
      continue;
    }

    if (toolName !== operationId) {
      violations.push({
        source: `openapi:${path}`,
        message: `x-agent-usage.tool_name ${toolName ?? '(missing)'} does not match operationId ${operationId}`,
      });
    }

    if (!schemas[operationId]) {
      violations.push({
        source: `openapi:${path}`,
        message: `operationId ${operationId} has no matching MCP validator schema`,
      });
    }
  }

  return violations;
}

async function loadRuntimeContracts(): Promise<{
  definitions: ToolDefinition[];
  schemas: Record<string, z.ZodTypeAny>;
  openApiSpec: OpenApiSpec;
}> {
  const edgeToolsUrl = new URL('../../services/edge/src/mcp-tools.ts', import.meta.url).href;
  const edgeSchemasUrl = new URL('../../services/edge/src/mcp-tool-schemas.ts', import.meta.url).href;
  const openApiUrl = new URL('../../services/worker/src/api/v2/openapi.ts', import.meta.url).href;

  const [{ TOOL_DEFINITIONS }, { MCP_TOOL_SCHEMAS }, { openApiV2Spec }] = await Promise.all([
    import(edgeToolsUrl) as Promise<{ TOOL_DEFINITIONS: ToolDefinition[] }>,
    import(edgeSchemasUrl) as Promise<{ MCP_TOOL_SCHEMAS: Record<string, z.ZodTypeAny> }>,
    import(openApiUrl) as Promise<{ openApiV2Spec: OpenApiSpec }>,
  ]);

  return {
    definitions: TOOL_DEFINITIONS,
    schemas: MCP_TOOL_SCHEMAS,
    openApiSpec: openApiV2Spec,
  };
}

export async function collectContractDrift(): Promise<ContractDriftViolation[]> {
  const { definitions, schemas, openApiSpec } = await loadRuntimeContracts();

  return [
    ...collectMcpContractDrift(
      definitions,
      schemas,
    ),
    ...collectOpenApiAgentDrift(
      openApiSpec,
      schemas,
    ),
  ];
}

async function main(): Promise<void> {
  const violations = await collectContractDrift();

  if (violations.length === 0) {
    console.log('✅ Agent-facing API contracts are aligned across v2 OpenAPI and MCP schemas.');
    return;
  }

  console.error(`::error::SCRUM-1586: ${violations.length} API contract drift issue(s) found:`);
  for (const violation of violations) {
    console.error(`  ${violation.source}: ${violation.message}`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('::error::SCRUM-1586: API contract drift check failed to run.');
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
