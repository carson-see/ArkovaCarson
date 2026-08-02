/**
 * MCP discovery-manifest parity guard (L2-A6 / SCRUM sprint 2026-07-28).
 *
 * The public discovery manifest (public/.well-known/mcp/server-card.json)
 * is what MCP clients — and human operators deciding whether to install
 * the connector — read BEFORE ever calling `tools/list` against the live
 * server. It drifted badly: the live server (services/edge/src/mcp-tools.ts,
 * wired into services/edge/src/mcp-server.ts) registers 16 tools, but the
 * manifest advertised only 2 (`search`, `get_anchor`). An agent or founder
 * reading the manifest had no way to discover verify_batch, nessie_query,
 * anchor_document, or any of the other 12 real tools.
 *
 * `TOOL_DEFINITIONS` in mcp-tools.ts is the single source of truth both
 * `mcp-server.ts` (tool descriptions) and this test consume — mirrors the
 * "one schema module, two consumers" pattern in
 * services/worker/src/api/v2/mcpParity.ts (REST v2 <-> MCP response-shape
 * parity), applied here to the discovery layer instead of response shapes.
 *
 * This test is RED whenever the manifest's tool set, or any tool's
 * required-argument / property contract, falls out of sync with the real
 * server registry — including a tool being added to the server and never
 * added to the manifest (the original bug), a tool being removed from the
 * server but left dangling in the manifest, or a schema edit landing on
 * one side without the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TOOL_DEFINITIONS, type ToolDefinition } from '../../services/edge/src/mcp-tools';

const ROOT = join(__dirname, '..', '..');
const MANIFEST_PATH = join(ROOT, 'public', '.well-known', 'mcp', 'server-card.json');

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface ServerCard {
  tools: ManifestTool[];
}

function loadManifest(): ServerCard {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ServerCard;
}

// anchor_document is registered on the live server only when
// MCP_ENABLE_ANCHOR_DOCUMENT=true AND the caller holds a write:anchors /
// anchor:write scope (services/edge/src/mcp-server.ts
// isMcpAnchorDocumentAllowed). That's a per-request authorization gate,
// not a statement about whether the capability exists — the discovery
// manifest documents the server's capability surface, so it stays in the
// expected set here same as every other tool.
const SERVER_TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

describe('MCP discovery manifest parity (L2-A6)', () => {
  const manifest = loadManifest();

  it('server registers exactly 16 tools (sanity check on the fixture assumption)', () => {
    // Not a manifest assertion — a tripwire so this test file itself gets
    // revisited if TOOL_DEFINITIONS grows/shrinks materially, since the
    // PR body and description text below reference "16" explicitly.
    expect(SERVER_TOOL_NAMES.length).toBe(16);
  });

  it('has a non-empty tools array', () => {
    expect(Array.isArray(manifest.tools)).toBe(true);
    expect(manifest.tools.length).toBeGreaterThan(0);
  });

  it('advertises every tool the live MCP server registers (no under-count)', () => {
    const manifestNames = new Set(manifest.tools.map((t) => t.name));
    const missing = SERVER_TOOL_NAMES.filter((n) => !manifestNames.has(n));
    expect(missing).toEqual([]);
  });

  it('does not advertise a tool the server does not implement (no over-claim)', () => {
    const serverNames = new Set(SERVER_TOOL_NAMES);
    const extra = manifest.tools.map((t) => t.name).filter((n) => !serverNames.has(n));
    expect(extra).toEqual([]);
  });

  it('advertises the exact real tool count — 2-of-16 regression tripwire', () => {
    expect(manifest.tools.length).toBe(SERVER_TOOL_NAMES.length);
  });

  it('has no duplicate tool names in the manifest', () => {
    const names = manifest.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  describe.each(TOOL_DEFINITIONS)('tool: $name', (tool: ToolDefinition) => {
    const manifestTool = (): ManifestTool => {
      const found = manifest.tools.find((t) => t.name === tool.name);
      if (!found) throw new Error(`manifest is missing tool "${tool.name}"`);
      return found;
    };

    it('is present in the manifest', () => {
      expect(manifest.tools.some((t) => t.name === tool.name)).toBe(true);
    });

    it('has a non-empty description', () => {
      expect(typeof manifestTool().description).toBe('string');
      expect(manifestTool().description.length).toBeGreaterThan(0);
    });

    it('declares an object input schema', () => {
      expect(manifestTool().inputSchema.type).toBe('object');
    });

    it('required arguments match the server schema exactly', () => {
      const serverRequired = [...tool.inputSchema.required].sort();
      const manifestRequired = [...(manifestTool().inputSchema.required ?? [])].sort();
      expect(manifestRequired).toEqual(serverRequired);
    });

    it('declared property names match the server schema exactly', () => {
      const serverProps = Object.keys(tool.inputSchema.properties).sort();
      const manifestProps = Object.keys(manifestTool().inputSchema.properties ?? {}).sort();
      expect(manifestProps).toEqual(serverProps);
    });
  });

  it('does not use banned UI terminology in tool descriptions (Constitution 1.3)', () => {
    // Scoped to prose `description` fields only — technical field/tool
    // names (content_hash, get_fingerprint, etc.) are internal API
    // identifiers, not user-visible copy, and are explicitly out of scope
    // per Constitution 1.3 ("Internal code may use technical names").
    const banned = ['Wallet', 'Gas', 'Blockchain', 'Bitcoin', 'Crypto', 'Testnet', 'Mainnet'];
    for (const tool of manifest.tools) {
      for (const term of banned) {
        const regex = new RegExp(`\\b${term}\\b`, 'i');
        expect(regex.test(tool.description)).toBe(false);
      }
    }
  });

  it('does not overclaim external registry/listing status (R-7 claims-review gate)', () => {
    const overclaimPhrases = [
      /listed in the .*registry/i,
      /credential registry/i,
      /officially certified/i,
      /government[- ]approved/i,
    ];
    const haystack = JSON.stringify(manifest);
    for (const phrase of overclaimPhrases) {
      expect(phrase.test(haystack)).toBe(false);
    }
  });
});
