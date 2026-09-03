import { describe, expect, it } from 'vitest';

import {
  MCP_SDK_DRIVER,
  isDirectRun,
  resolveEdgeMcpBase,
  buildJsonRpcRequest,
  buildJsonRpcNotification,
  classifyMcpOutcome,
  isToolResultError,
  extractToolList,
  assertNoCredentialNamedTools,
  assertRequiredToolsPresent,
  assertApiOnlyNotePresent,
  assertToolsList,
  assertOauthAdvertisement,
  assertUnknownToolRejected,
  assertReadToolOutcome,
  planHostedReadToolCalls,
  planHostedNegatives,
  planStdioReadToolCalls,
  classifyStdioOutput,
  findJsonRpcResponseById,
  buildAuditCountUrl,
  parseCountFromContentRange,
  parseMcpSdkDriverArgs,
  HOSTED_REQUIRED_TOOLS,
  HOSTED_NOTE_TOOLS,
  STDIO_REQUIRED_TOOLS,
  STDIO_NOTE_TOOLS,
  type McpToolSummary,
} from './mcp-sdk-surface-driver';

const FX = { publicId: 'ARK-TSOAK-ABC123', fingerprint: 'a'.repeat(64), searchTerm: 'Jordan Rivera' };

describe('mcp-sdk-surface-driver: metadata', () => {
  it('names PR #2589 and the driver', () => {
    expect(MCP_SDK_DRIVER.driver).toBe('mcp-sdk-surface');
    expect(MCP_SDK_DRIVER.pr).toBe('#2589');
  });
});

describe('mcp-sdk-surface-driver: isDirectRun (path comparison, not string compare)', () => {
  it('is true when argv1 resolves to the same file as the module URL', () => {
    const url = 'file:///repo/scripts/staging/targeted/mcp-sdk-surface-driver.ts';
    expect(isDirectRun(url, '/repo/scripts/staging/targeted/mcp-sdk-surface-driver.ts')).toBe(true);
  });

  it('is false when argv1 is undefined (imported by a test, not launched)', () => {
    expect(isDirectRun('file:///repo/scripts/staging/targeted/mcp-sdk-surface-driver.ts', undefined)).toBe(false);
  });

  it('is false for an unrelated path', () => {
    expect(
      isDirectRun('file:///repo/scripts/staging/targeted/mcp-sdk-surface-driver.ts', '/repo/scripts/other.ts'),
    ).toBe(false);
  });
});

describe('mcp-sdk-surface-driver: resolveEdgeMcpBase', () => {
  it('accepts a well-formed isolated hosted-MCP Worker URL and trims trailing slashes', () => {
    expect(resolveEdgeMcpBase({ STAGING_EDGE_MCP_BASE: 'https://arkova-edge-mcp-sdk-3894.acct.workers.dev/' })).toBe(
      'https://arkova-edge-mcp-sdk-3894.acct.workers.dev',
    );
  });

  it('throws when STAGING_EDGE_MCP_BASE is unset', () => {
    expect(() => resolveEdgeMcpBase({})).toThrow(/STAGING_EDGE_MCP_BASE is required/);
  });

  it('throws on a non-URL value', () => {
    expect(() => resolveEdgeMcpBase({ STAGING_EDGE_MCP_BASE: 'not a url' })).toThrow(/absolute URL/);
  });

  it('throws on http (non-https)', () => {
    expect(() => resolveEdgeMcpBase({ STAGING_EDGE_MCP_BASE: 'http://arkova-edge-mcp-sdk-3894.acct.workers.dev' })).toThrow(
      /must use https/,
    );
  });

  it('refuses production (edge.arkova.ai)', () => {
    expect(() => resolveEdgeMcpBase({ STAGING_EDGE_MCP_BASE: 'https://edge.arkova.ai' })).toThrow(/production/);
  });
});

describe('mcp-sdk-surface-driver: JSON-RPC builders', () => {
  it('builds a request with an id and params', () => {
    expect(buildJsonRpcRequest('tools/call', { name: 'verify_anchor' }, 7)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'verify_anchor' },
    });
  });

  it('omits params when undefined', () => {
    expect(buildJsonRpcRequest('tools/list', undefined, 2)).toEqual({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });

  it('builds a notification with no id', () => {
    const n = buildJsonRpcNotification('notifications/initialized');
    expect(n).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect('id' in n).toBe(false);
  });
});

describe('mcp-sdk-surface-driver: classifyMcpOutcome / isToolResultError', () => {
  it('classifies a result body', () => {
    expect(classifyMcpOutcome({ jsonrpc: '2.0', id: 1, result: { tools: [] } })).toBe('jsonrpc-result');
  });

  it('classifies an error body', () => {
    expect(classifyMcpOutcome({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'not found' } })).toBe(
      'jsonrpc-error',
    );
  });

  it('classifies a non-object / null body as unparseable', () => {
    expect(classifyMcpOutcome(null)).toBe('unparseable');
    expect(classifyMcpOutcome('plain text')).toBe('unparseable');
    expect(classifyMcpOutcome([1, 2])).toBe('unparseable');
  });

  it('reads result.isError === true (nessie_query disabled shape)', () => {
    const body = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }], isError: true } };
    expect(isToolResultError(body)).toBe(true);
  });

  it('is false for a normal successful result', () => {
    expect(isToolResultError({ jsonrpc: '2.0', id: 1, result: { content: [] } })).toBe(false);
  });

  it('is false for an error body (no result key at all)', () => {
    expect(isToolResultError({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(false);
  });
});

describe('mcp-sdk-surface-driver: extractToolList', () => {
  it('extracts name+description pairs from a tools/list result', () => {
    const body = {
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'arkova_verify_anchor', description: 'does NOT read local files' }] },
    };
    expect(extractToolList(body)).toEqual([{ name: 'arkova_verify_anchor', description: 'does NOT read local files' }]);
  });

  it('returns null on an error body', () => {
    expect(extractToolList({ jsonrpc: '2.0', id: 2, error: { code: -1, message: 'x' } })).toBeNull();
  });

  it('returns null when result.tools is missing or not an array', () => {
    expect(extractToolList({ jsonrpc: '2.0', id: 2, result: {} })).toBeNull();
  });
});

describe('mcp-sdk-surface-driver: SCRUM-2589 tool-naming assertions', () => {
  const cleanTools: McpToolSummary[] = [
    { name: 'arkova_verify_anchor', description: 'Verify. Queries the Arkova verification API over HTTPS; it does NOT read local files, environment variables, or stored secrets.' },
    { name: 'arkova_search_anchors', description: 'Search. does NOT read local files here too.' },
    { name: 'get_anchor', description: 'Get an anchor.' },
  ];

  it('assertNoCredentialNamedTools passes on the renamed set', () => {
    expect(assertNoCredentialNamedTools(cleanTools)).toBeNull();
  });

  it('assertNoCredentialNamedTools flags a leftover "credential"-named tool (case-insensitive)', () => {
    const dirty = [...cleanTools, { name: 'search_Credentials', description: 'old name' }];
    const err = assertNoCredentialNamedTools(dirty);
    expect(err).toMatch(/search_Credentials/);
  });

  it('assertRequiredToolsPresent passes when both required tools exist', () => {
    expect(assertRequiredToolsPresent(cleanTools, HOSTED_REQUIRED_TOOLS)).toBeNull();
  });

  it('assertRequiredToolsPresent flags a missing required tool', () => {
    const err = assertRequiredToolsPresent([{ name: 'get_anchor', description: '' }], HOSTED_REQUIRED_TOOLS);
    expect(err).toMatch(/verify_anchor/);
    expect(err).toMatch(/search_anchors/);
  });

  it('assertApiOnlyNotePresent passes when both tools carry the note', () => {
    expect(assertApiOnlyNotePresent(cleanTools, HOSTED_NOTE_TOOLS)).toBeNull();
  });

  it('assertApiOnlyNotePresent flags a tool missing the note', () => {
    const missingNote: McpToolSummary[] = [
      { name: 'arkova_verify_anchor', description: 'Verify an anchor, no note here.' },
      { name: 'arkova_search_anchors', description: 'Search, does NOT read local files.' },
    ];
    const err = assertApiOnlyNotePresent(missingNote, HOSTED_NOTE_TOOLS);
    expect(err).toMatch(/verify_anchor/);
    expect(err).not.toMatch(/search_anchors/);
  });

  it('assertToolsList combines all three checks and reports every failure', () => {
    const body = {
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'search_credentials', description: 'old, no note' }] },
    };
    const a = assertToolsList(body, HOSTED_REQUIRED_TOOLS, HOSTED_NOTE_TOOLS);
    expect(a.errors.length).toBeGreaterThan(0);
    expect(a.credentialNamedCount).toBe(1);
    expect(a.apiOnlyNotePresent).toBe(false);
  });

  it('assertToolsList is clean on the stdio arkova_* renamed set', () => {
    const body = {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'arkova_verify_anchor', description: 'Verify. does NOT read local files, environment variables, or stored secrets.' },
          { name: 'arkova_search_anchors', description: 'Search. does NOT read local files. never returns API keys.' },
        ],
      },
    };
    const a = assertToolsList(body, STDIO_REQUIRED_TOOLS, STDIO_NOTE_TOOLS);
    expect(a.errors).toEqual([]);
    expect(a.credentialNamedCount).toBe(0);
    expect(a.apiOnlyNotePresent).toBe(true);
  });
});

describe('mcp-sdk-surface-driver: D3 OAuth discovery assertion', () => {
  it('post-fix (default expectation): passes when authorization_servers is ABSENT', () => {
    expect(assertOauthAdvertisement({ resource: 'https://x' }, false)).toBeNull();
  });

  it('post-fix: fails when authorization_servers is still PRESENT', () => {
    const err = assertOauthAdvertisement({ resource: 'https://x', authorization_servers: ['https://x/auth'] }, false);
    expect(err).toMatch(/PRESENT/);
  });

  it('pre-fix mode (--expect-oauth-advertised): passes when PRESENT', () => {
    expect(assertOauthAdvertisement({ authorization_servers: ['https://x/auth'] }, true)).toBeNull();
  });

  it('pre-fix mode: fails when ABSENT', () => {
    const err = assertOauthAdvertisement({}, true);
    expect(err).toMatch(/ABSENT/);
  });

  it('fails on a non-object body', () => {
    expect(assertOauthAdvertisement(null, false)).toMatch(/not an object/);
  });
});

describe('mcp-sdk-surface-driver: negative-case assertion (old/unknown tool names)', () => {
  it('accepts a JSON-RPC protocol error', () => {
    expect(assertUnknownToolRejected({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Unknown tool' } })).toBeNull();
  });

  it('accepts a result-level isError:true rejection as a fallback shape', () => {
    const body = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Unknown tool' }], isError: true } };
    expect(assertUnknownToolRejected(body)).toBeNull();
  });

  it('fails when the tool call actually succeeded', () => {
    const err = assertUnknownToolRejected({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } });
    expect(err).toMatch(/expected a JSON-RPC error/);
  });
});

describe('mcp-sdk-surface-driver: planHostedReadToolCalls (§A3)', () => {
  const plan = planHostedReadToolCalls(FX);

  it('drives all 8 read tools including the deliberately-disabled nessie_query', () => {
    const labels = plan.map((p) => p.label);
    expect(labels).toEqual([
      'verify_anchor',
      'search_anchors',
      'verify_document',
      'get_anchor',
      'verify_batch',
      'search',
      'verify',
      'nessie_query',
    ]);
  });

  it('assigns each request a distinct, deterministic id', () => {
    const ids = plan.map((p) => p.request.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('verify_batch mixes the seeded fixture with an unknown id', () => {
    const batch = plan.find((p) => p.label === 'verify_batch')!;
    expect(batch.args.public_ids).toEqual([FX.publicId, 'ARK-NOPE-000000']);
  });

  it('nessie_query is the only "either" expectation; everything else expects a real result', () => {
    for (const p of plan) {
      if (p.label === 'nessie_query') expect(p.expect).toBe('either');
      else expect(p.expect).toBe('result');
    }
  });

  it('every request is a well-formed tools/call envelope', () => {
    for (const p of plan) {
      expect(p.request.method).toBe('tools/call');
      expect((p.request.params as { name: string }).name).toBe(p.toolName);
    }
  });
});

describe('mcp-sdk-surface-driver: assertReadToolOutcome', () => {
  it('"result" expectation requires a genuine jsonrpc-result', () => {
    expect(assertReadToolOutcome({ jsonrpc: '2.0', id: 1, result: {} }, 'result')).toBeNull();
    expect(assertReadToolOutcome({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }, 'result')).toMatch(
      /expected a JSON-RPC result/,
    );
  });

  it('"either" expectation (nessie_query) accepts a result-level isError:true', () => {
    const body = { jsonrpc: '2.0', id: 1, result: { content: [], isError: true } };
    expect(assertReadToolOutcome(body, 'either')).toBeNull();
  });

  it('"either" expectation accepts a protocol error too', () => {
    expect(assertReadToolOutcome({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }, 'either')).toBeNull();
  });

  it('"either" expectation rejects an ordinary success (capability must be gated off)', () => {
    const err = assertReadToolOutcome({ jsonrpc: '2.0', id: 1, result: { content: [] } }, 'either');
    expect(err).toMatch(/EXPECTED-error outcome/);
  });
});

describe('mcp-sdk-surface-driver: planHostedNegatives (§A4)', () => {
  const negs = planHostedNegatives();

  it('has the 5 documented negatives', () => {
    expect(negs.map((n) => n.label)).toEqual(['no-auth', 'bogus-key', 'unknown-tool', 'search_credentials-removed', 'search_anchors-unprefixed-removed']);
  });

  it('no-auth and bogus-key expect HTTP 401 (rejected before tool dispatch)', () => {
    expect(negs.find((n) => n.label === 'no-auth')!.okStatuses).toEqual([401]);
    expect(negs.find((n) => n.label === 'bogus-key')!.okStatuses).toEqual([401]);
    expect(negs.find((n) => n.label === 'no-auth')!.authMode).toBe('missing');
    expect(negs.find((n) => n.label === 'bogus-key')!.authMode).toBe('bogus');
  });

  it('unknown-tool and search_credentials-removed authenticate normally and expect HTTP 200 + a JSON-RPC rejection', () => {
    const unknown = negs.find((n) => n.label === 'unknown-tool')!;
    const removed = negs.find((n) => n.label === 'search_credentials-removed')!;
    expect(unknown.authMode).toBe('valid');
    expect(unknown.okStatuses).toEqual([200]);
    expect(unknown.assert).toBeDefined();
    expect(removed.authMode).toBe('valid');
    expect((removed.request.params as { name: string }).name).toBe('search_credentials');
  });
});

describe('mcp-sdk-surface-driver: planStdioReadToolCalls (§B)', () => {
  const plan = planStdioReadToolCalls(FX);

  it('drives the 4 arkova_* stdio tools', () => {
    expect(plan.map((p) => p.label)).toEqual([
      'arkova_verify_anchor',
      'arkova_anchor_status',
      'arkova_search_anchors',
      'arkova_batch_verify',
    ]);
  });

  it('arkova_batch_verify encodes public_ids as a JSON-array STRING (its inputSchema is a string, not an array)', () => {
    const batch = plan.find((p) => p.label === 'arkova_batch_verify')!;
    expect(typeof batch.args.public_ids).toBe('string');
    expect(JSON.parse(batch.args.public_ids as string)).toEqual([FX.publicId]);
  });

  it('ids do not collide with the hosted plan default id range', () => {
    const hostedIds = new Set(planHostedReadToolCalls(FX).map((p) => p.request.id));
    for (const p of plan) expect(hostedIds.has(p.request.id)).toBe(false);
  });
});

describe('mcp-sdk-surface-driver: classifyStdioOutput / findJsonRpcResponseById (stdio hygiene)', () => {
  it('separates valid JSON-RPC lines from stray non-JSON stdout output', () => {
    const raw = [
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      'Server listening on stdio', // hygiene violation — a banner on stdout
      '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
      '',
      '  ',
    ].join('\n');
    const { jsonLines, nonJsonLines } = classifyStdioOutput(raw);
    expect(jsonLines).toHaveLength(2);
    expect(nonJsonLines).toEqual(['Server listening on stdio']);
  });

  it('reports zero non-JSON lines on a clean transcript', () => {
    const raw = '{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n';
    expect(classifyStdioOutput(raw).nonJsonLines).toEqual([]);
  });

  it('findJsonRpcResponseById matches by id and ignores others', () => {
    const { jsonLines } = classifyStdioOutput(
      '{"jsonrpc":"2.0","id":1,"result":{"a":1}}\n{"jsonrpc":"2.0","id":2,"result":{"a":2}}\n',
    );
    expect(findJsonRpcResponseById(jsonLines, 2)).toEqual({ jsonrpc: '2.0', id: 2, result: { a: 2 } });
    expect(findJsonRpcResponseById(jsonLines, 99)).toBeNull();
  });
});

describe('mcp-sdk-surface-driver: audit-control helpers (§A6)', () => {
  it('buildAuditCountUrl filters on event_type and bounds the row read', () => {
    const url = buildAuditCountUrl('https://proj.supabase.co', 'MCP_TOOL_CALL');
    expect(url).toBe('https://proj.supabase.co/rest/v1/audit_events?select=id&event_type=eq.MCP_TOOL_CALL&limit=1');
  });

  it('strips a trailing slash from the Supabase URL', () => {
    const url = buildAuditCountUrl('https://proj.supabase.co/', 'MCP_TOOL_CALL');
    expect(url.startsWith('https://proj.supabase.co/rest/v1/')).toBe(true);
  });

  it('parseCountFromContentRange reads the total after the slash', () => {
    expect(parseCountFromContentRange('0-0/117')).toBe(117);
  });

  it('parseCountFromContentRange handles the "*/N" no-rows-returned form', () => {
    expect(parseCountFromContentRange('*/42')).toBe(42);
  });

  it('parseCountFromContentRange handles "*/0" (zero rows)', () => {
    expect(parseCountFromContentRange('*/0')).toBe(0);
  });

  it('parseCountFromContentRange returns -1 for a missing or unparseable header', () => {
    expect(parseCountFromContentRange(null)).toBe(-1);
    expect(parseCountFromContentRange('garbage')).toBe(-1);
  });
});

describe('mcp-sdk-surface-driver: parseMcpSdkDriverArgs', () => {
  it('defaults to a 15-minute duration window when neither --duration nor --cycles is given', () => {
    const args = parseMcpSdkDriverArgs([]);
    expect(args.durationMin).toBe(15);
    expect(args.cycles).toBeUndefined();
  });

  it('honors an explicit --duration', () => {
    const args = parseMcpSdkDriverArgs(['--duration', '45']);
    expect(args.durationMin).toBe(45);
    expect(args.cycles).toBeUndefined();
  });

  it('--cycles selects fixed-count mode and clears the duration window', () => {
    const args = parseMcpSdkDriverArgs(['--cycles', '5']);
    expect(args.cycles).toBe(5);
    expect(args.durationMin).toBeUndefined();
  });

  it('rejects a non-positive --cycles', () => {
    expect(() => parseMcpSdkDriverArgs(['--cycles', '0'])).toThrow(/positive integer/);
  });

  it('rejects a non-positive --duration', () => {
    expect(() => parseMcpSdkDriverArgs(['--duration=0'])).toThrow(/positive integer/);
    expect(() => parseMcpSdkDriverArgs(['--duration=-1'])).toThrow(/positive integer/);
  });

  it('--expect-oauth-advertised defaults to true (post-D3-fix: NOT advertised is the pass case)', () => {
    expect(parseMcpSdkDriverArgs([]).expectOauthAdvertised).toBe(true);
  });

  it('--expect-oauth-advertised=false switches to the pre-fix expectation', () => {
    expect(parseMcpSdkDriverArgs(['--expect-oauth-advertised', 'false']).expectOauthAdvertised).toBe(false);
    expect(parseMcpSdkDriverArgs(['--expect-oauth-advertised', '0']).expectOauthAdvertised).toBe(false);
  });

  it('--with-sdks and --dry-run parse as booleans, default false', () => {
    expect(parseMcpSdkDriverArgs([]).withSdks).toBe(false);
    expect(parseMcpSdkDriverArgs([]).dryRun).toBe(false);
    expect(parseMcpSdkDriverArgs(['--with-sdks', '--dry-run']).withSdks).toBe(true);
    expect(parseMcpSdkDriverArgs(['--with-sdks', '--dry-run']).dryRun).toBe(true);
  });

  it('parses --evidence-out', () => {
    expect(parseMcpSdkDriverArgs(['--evidence-out', 'docs/staging/x.json']).evidenceOut).toBe('docs/staging/x.json');
  });
});
