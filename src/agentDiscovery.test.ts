import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

interface VercelRule {
  source: string;
  destination?: string;
  has?: Array<{ type: string; key: string; value?: unknown }>;
  headers?: Array<{ key: string; value: string }>;
}

interface VercelConfig {
  headers: VercelRule[];
  rewrites: VercelRule[];
  redirects?: Array<{ source: string; destination: string; permanent: boolean }>;
}

describe('app.arkova.ai agent discovery', () => {
  const config = readJson<VercelConfig>('vercel.json');

  it('advertises discovery resources with Link response headers', () => {
    const homepage = config.headers.find(rule => rule.source === '/');
    const link = homepage?.headers?.find(header => header.key === 'Link')?.value ?? '';

    expect(link).toContain('</.well-known/api-catalog>; rel="api-catalog"');
    expect(link).toContain('</api/docs/spec.json>; rel="service-desc"');
    expect(link).toContain('</developers>; rel="service-doc"');
    expect(link).toContain('</auth.md>; rel="describedby"');
  });

  it('negotiates the homepage to Markdown while keeping HTML as the default', () => {
    const markdownRewrite = config.rewrites.find(rule =>
      rule.source === '/' &&
      rule.destination === '/index.md' &&
      rule.has?.some(match => match.type === 'header' && match.key.toLowerCase() === 'accept')
    );
    const markdownHeaders = config.headers.find(rule =>
      rule.source === '/' &&
      rule.has?.some(match => match.type === 'header' && match.key.toLowerCase() === 'accept')
    );

    expect(markdownRewrite).toBeDefined();
    expect(markdownHeaders?.headers).toContainEqual({ key: 'Content-Type', value: 'text/markdown; charset=utf-8' });
    expect(read('public/index.md')).toContain('# Arkova');
  });

  it('keeps the Markdown rewrite destination out of the SPA fallback', () => {
    const spaFallback = config.rewrites.find(rule => rule.destination === '/index.html');

    expect(spaFallback?.source).toContain('index\\.md');
  });

  it('does not soft-200 unsupported machine-discovery endpoints as HTML', () => {
    const spaFallback = config.rewrites.find(rule => rule.destination === '/index.html');

    expect(spaFallback?.source).toContain('\\.well-known');
    expect(spaFallback?.source).toContain('openapi\\.json');
  });

  it('publishes Content Signals alongside the existing crawler rules', () => {
    const robots = read('public/robots.txt');
    expect(robots).toContain('Content-Signal: ai-train=no, search=yes, ai-input=yes');
    expect(robots).toContain('Sitemap: https://app.arkova.ai/sitemap.xml');
  });

  it('keeps private routes disallowed for every explicitly named AI crawler', () => {
    const groups = read('public/robots.txt')
      .split(/\n\s*\n/)
      .map(block => block
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')))
      .filter(lines => lines.some(line => line.toLowerCase().startsWith('user-agent:')));
    const namedAiCrawlers = [
      'GPTBot',
      'ChatGPT-User',
      'OAI-SearchBot',
      'ClaudeBot',
      'anthropic-ai',
      'PerplexityBot',
      'Google-Extended',
      'Bytespider',
      'Amazonbot',
      'meta-externalagent',
    ];
    const wildcardGroup = groups.find(lines => lines.includes('User-agent: *')) ?? [];
    const privateDisallows = wildcardGroup.filter(line => line.startsWith('Disallow:'));

    expect(privateDisallows).not.toHaveLength(0);
    for (const crawler of namedAiCrawlers) {
      const crawlerGroup = groups.find(lines => lines.includes(`User-agent: ${crawler}`)) ?? [];
      expect(crawlerGroup.filter(line => line.startsWith('Disallow:')), crawler).toEqual(privateDisallows);
    }
  });

  it('publishes an RFC 9727 API catalog with working Arkova targets', () => {
    const catalog = readJson<{
      linkset: Array<{ anchor: string; 'service-desc': Array<{ href: string }>; 'service-doc': Array<{ href: string }>; status: Array<{ href: string }> }>;
    }>('public/.well-known/api-catalog');

    expect(catalog.linkset).toEqual(expect.arrayContaining([
      expect.objectContaining({
        anchor: 'https://api.arkova.ai/v2',
        'service-desc': expect.arrayContaining([expect.objectContaining({ href: 'https://api.arkova.ai/v2/openapi.json' })]),
        'service-doc': expect.arrayContaining([expect.objectContaining({ href: 'https://app.arkova.ai/developers' })]),
        status: expect.arrayContaining([expect.objectContaining({ href: 'https://api.arkova.ai/health' })]),
      }),
    ]));
  });

  it('publishes OAuth protected-resource metadata for the app API', () => {
    const metadata = readJson<{
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    }>('public/.well-known/oauth-protected-resource');

    expect(metadata.resource).toBe('https://app.arkova.ai');
    expect(metadata.authorization_servers).toEqual([
      'https://vzwyaatejekddvltxyye.supabase.co/auth/v1',
    ]);
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining([
      'read:records', 'read:orgs', 'read:search', 'write:anchors', 'admin:rules',
    ]));
    expect(metadata.bearer_methods_supported).toContain('header');
  });

  it('redirects OIDC discovery to the canonical production issuer', () => {
    expect(config.redirects).toContainEqual({
      source: '/.well-known/openid-configuration',
      destination: 'https://vzwyaatejekddvltxyye.supabase.co/auth/v1/.well-known/openid-configuration',
      permanent: false,
    });
  });

  it('publishes honest agent registration instructions', () => {
    const auth = read('public/auth.md');
    expect(auth).toMatch(/^# auth\.md/m);
    expect(auth).toContain('https://app.arkova.ai/settings/api-keys');
    expect(auth).toContain('Dynamic client registration is not currently available');
    expect(auth).toContain('/.well-known/oauth-protected-resource');
  });

  it('publishes a remote MCP server card', () => {
    const card = readJson<{
      serverInfo: { name: string; version: string };
      transports: Array<{ type: string; endpoint: string }>;
      capabilities: { tools?: Record<string, unknown> };
    }>('public/.well-known/mcp/server-card.json');

    expect(card.serverInfo.name).toBe('arkova');
    expect(card.transports).toContainEqual(expect.objectContaining({
      type: 'streamable-http',
      endpoint: 'https://edge.arkova.ai/mcp',
    }));
    expect(card.capabilities.tools).toBeDefined();
  });

  it('publishes a v0.2.0 skills index whose digests match each skill', () => {
    const index = readJson<{
      $schema: string;
      skills: Array<{ name: string; type: string; url: string; digest: string }>;
    }>('public/.well-known/agent-skills/index.json');

    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    expect(index.skills.length).toBeGreaterThanOrEqual(2);

    for (const skill of index.skills) {
      expect(skill.type).toBe('skill-md');
      const pathname = new URL(skill.url).pathname.replace(/^\//, 'public/');
      const digest = createHash('sha256').update(read(pathname)).digest('hex');
      expect(skill.digest).toBe(`sha256:${digest}`);
    }
  });

  it('assigns correct media types to extensionless discovery documents', () => {
    const headerFor = (source: string, key: string) => config.headers
      .find(rule => rule.source === source)
      ?.headers?.find(header => header.key === key)?.value;

    expect(headerFor('/.well-known/api-catalog', 'Content-Type')).toBe('application/linkset+json; charset=utf-8');
    expect(headerFor('/.well-known/oauth-protected-resource', 'Content-Type')).toBe('application/json; charset=utf-8');
    expect(headerFor('/auth.md', 'Content-Type')).toBe('text/markdown; charset=utf-8');
  });
});
