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
const tsClientSource = readRepoFile('packages/sdk/src/client.ts');
const tsTypesSource = readRepoFile('packages/sdk/src/types.ts');
const pyClientSource = readRepoFile('packages/arkova-py/src/arkova/client.py');
const pyModelsSource = readRepoFile('packages/arkova-py/src/arkova/models.py');

const canonicalSurface = [
  ['/api/v2/search', '/search', 'search', 'arkova_search', 'search', 'search'],
  ['/api/v2/orgs', '/orgs', 'list_orgs', 'arkova_list_orgs', 'listOrgs', 'list_orgs'],
  ['/api/v2/organizations/{public_id}', '/organizations/{public_id}', 'get_organization', 'arkova_get_organization', 'getOrganization', 'get_organization'],
  ['/api/v2/records/{public_id}', '/records/{public_id}', 'get_record', 'arkova_get_record', 'getRecord', 'get_record'],
  ['/api/v2/fingerprints/{fingerprint}', '/fingerprints/{fingerprint}', 'get_fingerprint', 'arkova_get_fingerprint', 'getFingerprint', 'get_fingerprint'],
  ['/api/v2/documents/{public_id}', '/documents/{public_id}', 'get_document', 'arkova_get_document', 'getDocument', 'get_document'],
  ['/api/v2/verify/{fingerprint}', '/verify/{fingerprint}', 'verify', 'arkova_verify', 'verifyFingerprint', 'verify_fingerprint'],
  ['/api/v2/anchors/{public_id}', '/anchors/{public_id}', 'get_anchor', 'arkova_get_anchor', 'getAnchor', 'get_anchor'],
] as const;

const validMcpArgs: Record<string, Record<string, unknown>> = {
  arkova_search: { q: 'acme', type: 'org', limit: 5 },
  arkova_list_orgs: {},
  arkova_get_organization: { public_id: 'org_acme' },
  arkova_get_record: { public_id: 'ARK-DOC-ABCDEF' },
  arkova_get_fingerprint: { fingerprint: 'a'.repeat(64) },
  arkova_get_document: { public_id: 'ARK-DOC-ABCDEF' },
  arkova_verify: { fingerprint: 'a'.repeat(64) },
  arkova_get_anchor: { public_id: 'ARK-DOC-ABCDEF' },
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
      'arkova_list_orgs',
      'arkova_search',
      'arkova_get_document',
      'arkova_get_record',
      'arkova_get_fingerprint',
      'arkova_get_organization',
      'arkova_verify',
      'arkova_get_anchor',
    ]) {
      expect(workflowDoc).toContain(step);
    }

    expect(workflowDoc).toContain('application/problem+json');
    expect(workflowDoc).toContain('Retry-After');
    expect(workflowDoc).toContain('internal `id`, `org_id`, `user_id`');
    expect(workflowDoc).toContain('raw document content');
  });

  it('makes every executable MCP call in the workflow doc use the REGISTERED tool name', () => {
    // The surface-matrix test above proves the prefixed names APPEAR in the
    // document. It cannot see the ```text blocks under each "MCP:" heading,
    // which are the only lines an agent actually copies — those carried the
    // pre-rename bare names (`search({...})`, `get_anchor({...})`) while the
    // matrix two screens up listed `arkova_search`. A reader who follows the
    // worked example gets a tool-not-found; a reader who reads the table does
    // not. This pins the executable half.
    //
    // REST and SDK blocks are deliberately out of scope: `GET /api/v2/search`
    // and `arkova.getAnchor()` are correct as written and must stay bare.
    const mcpBlocks = [...workflowDoc.matchAll(/^MCP:\n+```text\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    expect(mcpBlocks.length).toBeGreaterThan(0);

    const registered = new Set<string>(canonicalSurface.map(([, , , mcpTool]) => mcpTool));
    const calls = mcpBlocks.flatMap((block) =>
      [...block.matchAll(/^([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((name) => !registered.has(name))).toEqual([]);
  });

  it('keeps the MCP tool reference aligned with the runtime tool registry', () => {
    // `services/edge/server.json` is the official MCP Registry publish
    // manifest — it no longer carries a `tools`/`prompts` field (the
    // registry's schema.json has no such field; see #1776). The runtime
    // source of truth for what tools/prompts the deployed MCP server
    // actually exposes is `TOOL_DEFINITIONS` in `mcp-tools.ts` (tools) and
    // the conditional `prompt(...)` registrations in `mcp-server.ts`
    // (prompts) — both already loaded above as raw source text for the
    // other assertions in this file, so parse tool names out of the same
    // strings rather than re-introducing a JSON manifest dependency.
    const definedToolNames = Array.from(
      mcpToolsSource.matchAll(/\bname:\s*'([a-z_]+)'/g),
    ).map((match) => match[1]);
    // `arkova_anchor_document` is registered at runtime only when
    // `MCP_ENABLE_ANCHOR_DOCUMENT=true` (see mcp-server.ts) — it is not
    // part of the default read-only launch surface. The same is true of
    // `arkova_get_submission_status`, which shares that flag + write-scope
    // gate, and of `arkova_import_rows` (UAT-23), which is registered inside
    // that same `telemetry.anchorDocumentEnabled` block — three conditional
    // tools in total. `arkova_manage_folders` IS a default launch tool
    // (SCRUM-5142). Derive the default set from the canonical registry rather
    // than maintaining a second hand-counted list here.
    const launchToolNames = definedToolNames.filter((name) =>
      name !== 'arkova_anchor_document'
      && name !== 'arkova_get_submission_status'
      && name !== 'arkova_import_rows');

    expect(new Set(launchToolNames).size).toBe(launchToolNames.length);
    expect(launchToolNames).toContain('arkova_manage_folders');
    expect(mcpToolsDoc).toContain(`exposes ${launchToolNames.length} default launch tools plus three conditionally registered submission-lifecycle tools`);
    expect(launchToolNames).not.toContain('arkova_anchor_document');
    expect(mcpToolsDoc).toContain('MCP_ENABLE_ANCHOR_DOCUMENT=true');

    // The `anchor-and-verify` prompt must stay behind the same flag gate as
    // the `arkova_anchor_document` tool it depends on — not unconditionally
    // registered like `search-and-verify` / `research-topic`.
    expect(mcpServerSource).toMatch(
      /if \(telemetry\.anchorDocumentEnabled\) \{\s*\n\s*prompt\(\s*\n\s*'anchor-and-verify',/,
    );

    for (const name of launchToolNames) {
      expect(mcpToolsDoc).toContain(`\`${name}\``);
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

    expect(promptBlock).toContain('Run arkova_search');
    expect(promptBlock).toContain('arkova_get_document');
    expect(promptBlock).toContain('arkova_get_record');
    expect(promptBlock).toContain('arkova_get_fingerprint');
    expect(promptBlock).toContain('arkova_get_organization');
    expect(promptBlock).toContain('call arkova_verify');
    expect(promptBlock).toContain('call arkova_get_anchor');
    expect(promptBlock).not.toContain('arkova_search_anchors');
    expect(promptBlock).not.toContain('arkova_verify_anchor');
  });

  it('keeps MCP arkova_anchor_document out of the default launch surface unless explicitly enabled and scoped', () => {
    expect(mcpServerSource).toContain('MCP_ENABLE_ANCHOR_DOCUMENT');
    expect(mcpServerSource).toContain('write:anchors');
    expect(mcpServerSource).toContain('anchor:write');
    expect(mcpServerSource).not.toContain('mcp:anchor');
    expect(mcpToolsDoc).toContain('not a public API-key scope');
    expect(mcpServerSource).toContain('if (telemetry.anchorDocumentEnabled)');
    expect(mcpServerSource).toContain("scopes: Array.isArray(data.scopes) ? data.scopes : []");
    expect(mcpServerSource).toContain('scopes: local.scopes');
    expect(mcpJwtSource).toContain('scopesFromPayload');
    // UAT-23 added a third tool (`arkova_import_rows`) behind the same gate,
    // so the reference now says "All three" rather than "Both" — the claim the
    // assertion guards (conditional registration on the flag) is unchanged.
    expect(mcpToolsDoc).toContain('All three are registered only when `MCP_ENABLE_ANCHOR_DOCUMENT=true`');
    expect(mcpToolsDoc).toContain('Folder mutations remain separately available through `arkova_manage_folders`');
    expect(mcpToolsDoc).toContain('only to callers with `anchor:write`');
    expect(mcpToolsDoc).toContain('gated write tool');
  });
});
