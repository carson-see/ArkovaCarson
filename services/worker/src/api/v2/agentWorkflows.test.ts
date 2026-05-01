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
const mcpServerManifest = JSON.parse(readRepoFile('services/edge/server.json')) as {
  tools: Array<{ name: string }>;
};
const tsClientSource = readRepoFile('packages/sdk/src/client.ts');
const pyClientSource = readRepoFile('packages/arkova-py/src/arkova/client.py');

const canonicalSurface = [
  {
    endpoint: '/api/v2/search',
    specPath: '/search',
    operationId: 'search',
    mcpTool: 'search',
    tsMethod: 'search',
    pyMethod: 'search',
  },
  {
    endpoint: '/api/v2/orgs',
    specPath: '/orgs',
    operationId: 'list_orgs',
    mcpTool: 'list_orgs',
    tsMethod: 'listOrgs',
    pyMethod: 'list_orgs',
  },
  {
    endpoint: '/api/v2/organizations/{public_id}',
    specPath: '/organizations/{public_id}',
    operationId: 'get_organization',
    mcpTool: 'get_organization',
    tsMethod: 'getOrganization',
    pyMethod: 'get_organization',
  },
  {
    endpoint: '/api/v2/records/{public_id}',
    specPath: '/records/{public_id}',
    operationId: 'get_record',
    mcpTool: 'get_record',
    tsMethod: 'getRecord',
    pyMethod: 'get_record',
  },
  {
    endpoint: '/api/v2/fingerprints/{fingerprint}',
    specPath: '/fingerprints/{fingerprint}',
    operationId: 'get_fingerprint',
    mcpTool: 'get_fingerprint',
    tsMethod: 'getFingerprint',
    pyMethod: 'get_fingerprint',
  },
  {
    endpoint: '/api/v2/documents/{public_id}',
    specPath: '/documents/{public_id}',
    operationId: 'get_document',
    mcpTool: 'get_document',
    tsMethod: 'getDocument',
    pyMethod: 'get_document',
  },
  {
    endpoint: '/api/v2/verify/{fingerprint}',
    specPath: '/verify/{fingerprint}',
    operationId: 'verify',
    mcpTool: 'verify',
    tsMethod: 'verifyFingerprint',
    pyMethod: 'verify_fingerprint',
  },
  {
    endpoint: '/api/v2/anchors/{public_id}',
    specPath: '/anchors/{public_id}',
    operationId: 'get_anchor',
    mcpTool: 'get_anchor',
    tsMethod: 'getAnchor',
    pyMethod: 'get_anchor',
  },
] as const;

describe('canonical agent workflow documentation', () => {
  it('keeps the REST, MCP, TypeScript, and Python surface matrix aligned with shipped code', () => {
    for (const surface of canonicalSurface) {
      expect(workflowDoc).toContain(surface.endpoint);
      expect(workflowDoc).toContain(surface.operationId);
      expect(workflowDoc).toContain(surface.mcpTool);
      expect(workflowDoc).toContain(`arkova.${surface.tsMethod}()`);
      expect(workflowDoc).toContain(`arkova.${surface.pyMethod}()`);

      expect(openApiV2Spec.paths[surface.specPath].get.operationId).toBe(surface.operationId);
      expect(mcpToolsSource).toContain(`name: '${surface.mcpTool}'`);
      expect(tsClientSource).toMatch(new RegExp(String.raw`async ${surface.tsMethod}\(`));
      expect(pyClientSource).toMatch(new RegExp(String.raw`def\s+${surface.pyMethod}\(`));
    }
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
    expect(mcpServerManifest.tools).toHaveLength(16);
    expect(mcpToolsDoc).toContain('exposes sixteen tools');

    for (const tool of mcpServerManifest.tools) {
      expect(mcpToolsDoc).toContain(`\`${tool.name}\``);
    }
  });

  it('keeps the MCP search prompt on the canonical v2 workflow', () => {
    const start = mcpServerSource.indexOf("'search-and-verify'");
    const end = mcpServerSource.indexOf("'anchor-and-verify'");
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
});
