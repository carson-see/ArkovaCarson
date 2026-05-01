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
  ['/api/v2/search', '/search', 'search', 'search', 'search', 'search'],
  ['/api/v2/orgs', '/orgs', 'list_orgs', 'list_orgs', 'listOrgs', 'list_orgs'],
  ['/api/v2/organizations/{public_id}', '/organizations/{public_id}', 'get_organization', 'get_organization', 'getOrganization', 'get_organization'],
  ['/api/v2/records/{public_id}', '/records/{public_id}', 'get_record', 'get_record', 'getRecord', 'get_record'],
  ['/api/v2/fingerprints/{fingerprint}', '/fingerprints/{fingerprint}', 'get_fingerprint', 'get_fingerprint', 'getFingerprint', 'get_fingerprint'],
  ['/api/v2/documents/{public_id}', '/documents/{public_id}', 'get_document', 'get_document', 'getDocument', 'get_document'],
  ['/api/v2/verify/{fingerprint}', '/verify/{fingerprint}', 'verify', 'verify', 'verifyFingerprint', 'verify_fingerprint'],
  ['/api/v2/anchors/{public_id}', '/anchors/{public_id}', 'get_anchor', 'get_anchor', 'getAnchor', 'get_anchor'],
] as const;

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
      expect(pyClientSource).toMatch(new RegExp(String.raw`def\s+${pyMethod}\(`));
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
