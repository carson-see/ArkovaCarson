/**
 * Tests for llms.txt file format and content validation.
 *
 * Validates markdown consistency and required sections per the
 * Cloudflare AI Tooling style guide for llms.txt files.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const llmsTxt = readFileSync(join(ROOT, 'public', 'llms.txt'), 'utf-8');

describe('llms.txt validation', () => {
  it('starts with a top-level heading', () => {
    expect(llmsTxt.startsWith('# ')).toBe(true);
  });

  it('contains required sections', () => {
    const requiredSections = [
      'Description',
      'Endpoints',
      'Authentication',
      'Tools',
    ];
    for (const section of requiredSections) {
      expect(llmsTxt).toContain(`## ${section}`);
    }
  });

  it('documents the verify endpoint', () => {
    expect(llmsTxt).toContain('/verify');
    expect(llmsTxt).toContain('public_id');
  });

  it('documents the semantic search endpoint', () => {
    expect(llmsTxt).toContain('search');
    expect(llmsTxt).toContain('query');
  });

  it('includes the frozen response schema fields', () => {
    const requiredFields = [
      'verified',
      'status',
      'issuer_name',
      'credential_type',
      'anchor_timestamp',
      'record_uri',
    ];
    for (const field of requiredFields) {
      expect(llmsTxt).toContain(field);
    }
  });

  it('does not contain banned UI terms (Constitution 1.3)', () => {
    const bannedTerms = ['Wallet', 'Gas', 'Blockchain', 'Bitcoin', 'Crypto', 'Testnet', 'Mainnet'];
    for (const term of bannedTerms) {
      // Check for standalone word usage (not inside code blocks or field names)
      const lines = llmsTxt.split('\n').filter((l) => !l.trim().startsWith('`') && !l.trim().startsWith('|'));
      for (const line of lines) {
        const regex = new RegExp(`\\b${term}\\b`, 'i');
        if (regex.test(line)) {
          // Allow within code fences
          expect(line.includes('`')).toBe(true);
        }
      }
    }
  });

  it('has consistent markdown heading hierarchy', () => {
    const headings = llmsTxt.split('\n').filter((l) => l.startsWith('#'));
    // Should have h1 followed by h2s, no skipping levels
    expect(headings[0]).toMatch(/^# /);
    for (const h of headings.slice(1)) {
      expect(h).toMatch(/^#{2,3} /);
    }
  });

  it('is under 5000 characters (concise for LLM consumption)', () => {
    expect(llmsTxt.length).toBeLessThan(5000);
  });
});

describe('AGENTS.md validation', () => {
  const agentsMd = readFileSync(join(ROOT, 'public', 'AGENTS.md'), 'utf-8');

  it('starts with a top-level heading', () => {
    expect(agentsMd.startsWith('# ')).toBe(true);
  });

  it('documents available MCP tools', () => {
    expect(agentsMd).toContain('verify_credential');
    expect(agentsMd).toContain('search_credentials');
  });

  it('includes authentication instructions', () => {
    expect(agentsMd).toContain('OAuth');
  });

  it('includes the MCP server URL pattern', () => {
    expect(agentsMd).toContain('/mcp');
  });
});
