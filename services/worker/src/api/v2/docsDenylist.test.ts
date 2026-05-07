import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../../${path}`, import.meta.url), 'utf8');
}

const apiReadme = readRepoFile('docs/api/README.md');
const mcpTools = readRepoFile('docs/api/mcp-tools.md');
const agentWorkflows = readRepoFile('docs/api/agent-workflows.md');
const v2Migration = readRepoFile('docs/api/v2-migration.md');
const canonicalSources = readRepoFile('docs/api/canonical-sources.md');
const historicalGuide = readRepoFile('docs/guides/API_GUIDE.md');
const sdkReadme = readRepoFile('packages/sdk/README.md');
const pyReadme = readRepoFile('packages/arkova-py/README.md');
const edgeManifest = readRepoFile('services/edge/server.json');

describe('API/MCP public docs denylist', () => {
  it('keeps canonical docs on public_id and away from internal database ids', () => {
    expect(apiReadme).toContain('omit internal database identifiers such as `id`, `org_id`, and `user_id`');
    expect(agentWorkflows).toContain('Agents should not request or invent internal `id`, `org_id`, `user_id`');
    expect(v2Migration).toContain('GET /api/v2/anchors/{public_id}');
    expect(pyReadme).toContain('verify(public_id)');
    expect(sdkReadme).toContain('API v2 agent/search/detail surfaces use `public_id`/`publicId`');
  });

  it('documents MCP as read-only by default and does not publish anchor_document in the launch manifest', () => {
    expect(mcpTools).toContain('fifteen read-oriented launch tools');
    expect(mcpTools).toContain('MCP_ENABLE_ANCHOR_DOCUMENT=true');
    expect(apiReadme).toContain('MCP launch is read-only by default');
    expect(edgeManifest).not.toContain('"anchor_document"');
    expect(edgeManifest).not.toContain('"anchor-and-verify"');
  });

  it('redirects stale historical guides instead of treating them as the current API/MCP contract', () => {
    expect(canonicalSources).toContain('docs/guides/API_GUIDE.md');
    expect(canonicalSources).toContain('Historical March 2026 setup guide');
    expect(historicalGuide).toContain('Historical guide');
    expect(historicalGuide).toContain('not the current API/MCP launch contract');
    expect(historicalGuide).toContain('Do not use the agent examples below to infer that `anchor_document` is exposed');
  });

  it('documents the current x402 scope without implying API v2 read surfaces require payment', () => {
    for (const endpoint of [
      '/api/v1/verify',
      '/api/v1/verify/entity',
      '/api/v1/compliance/check',
      '/api/v1/regulatory/lookup',
      '/api/v1/cle',
      '/api/v1/nessie/query',
    ]) {
      expect(sdkReadme).toContain(endpoint);
    }

    expect(sdkReadme).toContain('API v2 agent/read surfaces use scoped API keys, not x402');
    expect(apiReadme).toContain('x402 micropayments');
  });
});
