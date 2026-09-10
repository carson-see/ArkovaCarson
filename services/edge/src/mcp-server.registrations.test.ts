/**
 * SCRUM-3818 — structural ratchet: every evidence-carrying MCP tool's LIVE
 * registration in `mcp-server.ts` must source its description from
 * `TOOL_DESC` (built from `TOOL_DEFINITIONS` in `mcp-tools.ts`), never a
 * hardcoded string literal.
 *
 * WHY THIS EXISTS. `mcp-tools.test.ts`'s "tool descriptions no longer imply
 * uniform verification confidence" test only asserts against the
 * DECLARATIVE `TOOL_DEFINITIONS` array. It cannot see `mcp-server.ts`,
 * which is what the deployed Cloudflare Worker actually registers with the
 * MCP SDK. `oracle_batch_verify`'s registration (`mcp-server.ts` ~line 456)
 * carried its own hardcoded description literal — stale, missing the
 * fingerprint_source evidence-strength caveat — even though
 * `TOOL_DEFINITIONS['oracle_batch_verify'].description` and the "no NEW
 * forbidden terms" test both looked correct. A green `mcp-tools.test.ts`
 * run therefore proved nothing about what an agent actually sees for that
 * tool. This file closes that gap by reading `mcp-server.ts`'s SOURCE TEXT
 * (not executing it — the module needs a live `McpServer` + Cloudflare
 * Workers bindings to run) and structurally verifying each registration's
 * second argument is a `TOOL_DESC` accessor for the correct key, not a
 * literal. Same "scan the source, not a snapshot of behavior" approach as
 * `src/lib/nessie-surfaces-offline.test.ts` elsewhere in this repo.
 *
 * Scope: the 9 evidence-carrying tools whose responses can include
 * `fingerprint_source` / `fingerprint_evidence_note` (see
 * `shapeAnchorRow`, mcp-tools.ts) — the set `mcp-tools.test.ts` already
 * pins in "tool descriptions no longer imply uniform verification
 * confidence". Every other tool() call in mcp-server.ts (search,
 * search_credentials, nessie_query, anchor_document, list_orgs,
 * get_organization, list_agents) is out of scope — they don't emit this
 * field, so their descriptions are not part of this bug class.
 */

// `services/edge/tsconfig.json` declares `types: ["@cloudflare/workers-types"]`
// only (no Node lib) — correct for the production Worker code, but this file
// is a TEST that needs `node:fs`/`node:path` to read mcp-server.ts's source
// text (Vitest runs it under Node regardless of the production target). A
// file-scoped triple-slash reference opts JUST this file into `@types/node`
// (installed as a devDependency below) without changing the tsconfig `types`
// array — so no other file in `src/` gains Node's ambient globals. Same
// "scope the type leak to one file" approach mcp-server.ts itself documents
// at its own top (re: NOT pulling `@cloudflare/workers-types` via a global
// `/// <reference />` for the analogous reason, in the other direction).
/// <reference types="node" />

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SOURCE = readFileSync(join(__dirname, 'mcp-server.ts'), 'utf-8');

/** The same 9 tools mcp-tools.test.ts pins as evidence-carrying. */
const EVIDENCE_AWARE_TOOLS = [
  'verify_credential',
  'verify_document',
  'verify_batch',
  'verify',
  'get_anchor',
  'get_record',
  'get_fingerprint',
  'get_document',
  'oracle_batch_verify',
] as const;

/**
 * Extract the raw text of a `tool('<name>', <description-arg>, { ...shape
 * literal... }, ...)` call's description argument (the 2nd positional arg),
 * stopping at the `,` immediately before the 3rd arg's opening `{` (every
 * registration in this file passes an object-literal shape as the 3rd arg).
 */
function extractDescriptionArg(toolName: string): string {
  const re = new RegExp(`tool\\(\\s*['"]${toolName}['"]\\s*,([\\s\\S]*?),\\s*\\{`);
  const match = MCP_SERVER_SOURCE.match(re);
  if (!match) {
    throw new Error(`No tool('${toolName}', ...) registration found in mcp-server.ts`);
  }
  return match[1];
}

/** Strip `//` line comments (registrations may carry explanatory comments
 * between the name and the description expression — see oracle_batch_verify). */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .trim();
}

describe('mcp-server.ts tool registrations source descriptions from TOOL_DESC (SCRUM-3818)', () => {
  it.each(EVIDENCE_AWARE_TOOLS)(
    '%s sources its live description from TOOL_DESC, not a hardcoded literal',
    (name) => {
      const cleaned = stripLineComments(extractDescriptionArg(name));
      const allowed = [`TOOL_DESC['${name}']`, `TOOL_DESC["${name}"]`, `TOOL_DESC.${name}`];
      expect(
        allowed,
        `mcp-server.ts's '${name}' registration must read exactly one of ${JSON.stringify(allowed)} ` +
          `as its description argument — found: ${JSON.stringify(cleaned)}. A hardcoded string ` +
          `literal here silently diverges from TOOL_DEFINITIONS['${name}'].description in ` +
          `mcp-tools.ts (this is exactly how oracle_batch_verify went stale — SCRUM-3818).`,
      ).toContain(cleaned);
    },
  );

  it('TOOL_DESC itself is derived from TOOL_DEFINITIONS (single source of truth, not a second literal map)', () => {
    expect(MCP_SERVER_SOURCE).toContain(
      "const TOOL_DESC = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t.description]));",
    );
  });
});
