// @ts-nocheck — edge source is outside worker rootDir; Vitest resolves it at runtime.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openApiV2Spec } from './openapi.js';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8');
}

const workflowDoc = readRepoFile('docs/api/agent-workflows.md');
const mcpToolsDoc = readRepoFile('docs/api/mcp-tools.md');
const mcpToolsSource = readRepoFile('services/edge/src/mcp-tools.ts');
const mcpServerSource = readRepoFile('services/edge/src/mcp-server.ts');
const mcpJwtSource = readRepoFile('services/edge/src/mcp-jwt-verify.ts');
const mcpServerManifest = JSON.parse(readRepoFile('services/edge/server.json')) as {
  tools: Array<{ name: string }>;
  prompts: Array<{ name: string }>;
};
const tsClientSource = readRepoFile('packages/sdk/src/client.ts');
const tsTypesSource = readRepoFile('packages/sdk/src/types.ts');
const pyClientSource = readRepoFile('packages/arkova-py/src/arkova/client.py');
const pyModelsSource = readRepoFile('packages/arkova-py/src/arkova/models.py');

const canonicalSurface = [
  ['/api/v2/search', '/search', 'search', 'search', 'search', 'search'],
  ['/api/v2/orgs', '/orgs', 'list_orgs', 'list_orgs', 'listOrgs', 'list_orgs'],
  ['/api/v2/organizations/{public_id}', '/organizations/{public_id}', 'get_organization', 'get_organization', 'getOrganization', 'get_organization'],
  ['/api/v2/records/{public_id}', '/records/{public_id}', 'get_record', 'get_record', 'getRecord', 'get_record'],
  ['/api/v2/fingerprints/{fingerprint}', '/fingerprints/{fingerprint}', 'get_fingerprint', 'get_fingerprint', 'getFingerprint', 'get_fingerprint'],
  ['/api/v2/documents/{public_id}', '/documents/{public_id}', 'get_document', 'get_document', 'getDocument', 'get_document'],
  ['/api/v2/verify/{fingerprint}', '/verify/{fingerprint}', 'verify', 'verify', 'verifyFingerprint', 'verify_fingerprint'],
  ['/api/v2/anchors/{public_id}', '/anchors/{public_id}', 'get_anchor', 'get_anchor', 'getAnchor', 'get_anchor'],
] as const;

const validMcpArgs: Record<string, Record<string, unknown>> = {
  search: { q: 'acme', type: 'org', limit: 5 },
  list_orgs: {},
  get_organization: { public_id: 'org_acme' },
  get_record: { public_id: 'ARK-DOC-ABCDEF' },
  get_fingerprint: { fingerprint: 'a'.repeat(64) },
  get_document: { public_id: 'ARK-DOC-ABCDEF' },
  verify: { fingerprint: 'a'.repeat(64) },
  get_anchor: { public_id: 'ARK-DOC-ABCDEF' },
};

function parameterNames(operation: { parameters?: readonly unknown[] }): string[] {
  return (operation.parameters ?? [])
    .map((parameter) => (
      typeof parameter === 'object' &&
      parameter !== null &&
      'name' in parameter &&
      'required' in parameter &&
      parameter.required === true
        ? String(parameter.name)
        : null
    ))
    .filter((name): name is string => name !== null);
}

function exportedTypeBlock(source: string, typeName: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) =>
    line.startsWith(`export interface ${typeName}`) || line.startsWith(`export type ${typeName}`),
  );
  expect(start).toBeGreaterThanOrEqual(0);

  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i].startsWith('export ')) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

function pythonClassBlock(source: string, className: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) =>
    line.startsWith(`class ${className}(`) || line.startsWith(`class ${className}:`),
  );
  expect(start).toBeGreaterThanOrEqual(0);

  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i].startsWith('class ')) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

describe('canonical agent workflow documentation', () => {
  it('keeps the REST, MCP, TypeScript, and Python surface matrix aligned with shipped code', () => {
    for (const [endpoint, specPath, operationId, mcpTool, tsMethod, pyMethod] of canonicalSurface) {
      expect(workflowDoc).toContain(endpoint);
      expect(workflowDoc).toContain(operationId);
      expect(workflowDoc).toContain(mcpTool);
      expect(workflowDoc).toContain(`arkova.${tsMethod}()`);
      expect(workflowDoc).toContain(`arkova.${pyMethod}()`);

      expect(openApiV2Spec.paths[specPath].get.operationId).toBe(operationId);
      expect(mcpToolsSource).toContain(`name: '${mcpTool}'`);
      expect(tsClientSource).toMatch(new RegExp(String.raw`async ${tsMethod}\(`));
      // Python SDK exposes both sync (`Arkova`) and async (`AsyncArkova`)
      // surfaces. Both must define every detail method.
      const pySyncMatches = pyClientSource.match(
        new RegExp(String.raw`^    def\s+${pyMethod}\(`, 'mg'),
      ) ?? [];
      const pyAsyncMatches = pyClientSource.match(
        new RegExp(String.raw`^    async def\s+${pyMethod}\(`, 'mg'),
      ) ?? [];
      expect(pySyncMatches.length).toBeGreaterThanOrEqual(1);
      expect(pyAsyncMatches.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('validates every OpenAPI agent tool argument shape with the MCP strict schemas', async () => {
    const { MCP_TOOL_SCHEMAS, validateToolArgs } = await import(
      /* @vite-ignore */ new URL('../../../../edge/src/mcp-tool-schemas.ts', import.meta.url).href
    );

    for (const [, specPath,, mcpTool] of canonicalSurface) {
      const operation = openApiV2Spec.paths[specPath].get;
      const toolName = operation['x-agent-usage'].tool_name;
      const args = validMcpArgs[mcpTool];

      expect(toolName).toBe(mcpTool);
      expect(MCP_TOOL_SCHEMAS[toolName]).toBeDefined();
      expect(args).toBeDefined();
      expect(validateToolArgs(toolName, args).ok).toBe(true);

      for (const name of parameterNames(operation)) {
        expect(Object.keys(args)).toContain(name);
      }

      for (const name of Object.keys(operation['x-agent-usage'].arguments ?? {})) {
        expect(Object.keys(args)).toContain(name);
      }
    }
  });

  it('keeps SDK detail envelope types aligned with the v2 contract', () => {
    // TS: detail interfaces must exist alongside the new methods.
    for (const t of ['OrganizationDetails', 'RecordDetails', 'FingerprintDetails', 'DocumentDetails']) {
      expect(tsTypesSource).toMatch(new RegExp(String.raw`(?:export\s+(?:interface|type))\s+${t}\b`));
    }

    // Python: matching Pydantic models in models.py.
    for (const t of ['OrganizationDetail', 'RecordDetail', 'FingerprintDetail', 'DocumentDetail']) {
      expect(pyModelsSource).toMatch(new RegExp(String.raw`class\s+${t}\b`));
    }

    // Organization summary/detail types must not re-introduce the
    // internal `id` field that v2 org endpoints never return publicly.
    expect(tsTypesSource).not.toMatch(/OrganizationDetails\s+extends\s+OrganizationSummary/);
    expect(exportedTypeBlock(tsTypesSource, 'OrganizationSummary').split('\n')).not.toContain(
      '  id: string;',
    );
    expect(pyModelsSource).not.toMatch(/class\s+OrganizationDetail\s*\(\s*Org\s*\)/);
    expect(pythonClassBlock(pyModelsSource, 'Org').split('\n')).not.toContain('    id: str');
  });

  it('documents the expected agent sequence and public-data guardrails', () => {
    for (const step of [
      'list_orgs',
      'search',
      'get_document',
      'get_record',
      'get_fingerprint',
      'get_organization',
      'verify',
      'get_anchor',
    ]) {
      expect(workflowDoc).toContain(step);
    }

    expect(workflowDoc).toContain('application/problem+json');
    expect(workflowDoc).toContain('Retry-After');
    expect(workflowDoc).toContain('internal `id`, `org_id`, `user_id`');
    expect(workflowDoc).toContain('raw document content');
  });

  it('keeps the MCP tool reference aligned with the published server manifest', () => {
    expect(mcpServerManifest.tools).toHaveLength(15);
    expect(mcpToolsDoc).toContain('exposes fifteen read-oriented launch tools');
    expect(mcpServerManifest.tools.map(tool => tool.name)).not.toContain('anchor_document');
    expect(mcpServerManifest.prompts.map(prompt => prompt.name)).not.toContain('anchor-and-verify');
    expect(mcpToolsDoc).toContain('MCP_ENABLE_ANCHOR_DOCUMENT=true');

    for (const tool of mcpServerManifest.tools) {
      expect(mcpToolsDoc).toContain(`\`${tool.name}\``);
    }
  });

  it('keeps the MCP search prompt on the canonical v2 workflow', () => {
    const start = mcpServerSource.indexOf("'search-and-verify'");
    const end = mcpServerSource.indexOf("'research-topic'");
    // Fail loudly with diagnostic context if the markers move or vanish,
    // rather than producing the cryptic "expected '' to contain ..." that
    // a `slice(-1, -1)` would yield.
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const promptBlock = mcpServerSource.slice(start, end);

    expect(promptBlock).toContain('Run search');
    expect(promptBlock).toContain('get_document');
    expect(promptBlock).toContain('get_record');
    expect(promptBlock).toContain('get_fingerprint');
    expect(promptBlock).toContain('get_organization');
    expect(promptBlock).toContain('call verify');
    expect(promptBlock).toContain('call get_anchor');
    expect(promptBlock).not.toContain('search_credentials');
    expect(promptBlock).not.toContain('verify_credential');
  });

  it('keeps MCP anchor_document out of the default launch surface unless explicitly enabled and scoped', () => {
    expect(mcpServerSource).toContain('MCP_ENABLE_ANCHOR_DOCUMENT');
    expect(mcpServerSource).toContain('write:anchors');
    expect(mcpServerSource).toContain('anchor:write');
    expect(mcpServerSource).not.toContain('mcp:anchor');
    expect(mcpToolsDoc).toContain('not a public API-key scope');
    expect(mcpServerSource).toContain('if (telemetry.anchorDocumentEnabled)');
    expect(mcpServerSource).toContain("scopes: Array.isArray(data.scopes) ? data.scopes : []");
    expect(mcpServerSource).toContain('scopes: local.scopes');
    expect(mcpJwtSource).toContain('scopesFromPayload');
    expect(mcpToolsDoc).toContain('public MCP launch is read-only');
    expect(mcpToolsDoc).toContain('gated write tool');
  });
});
