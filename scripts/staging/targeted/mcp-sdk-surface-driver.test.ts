import { afterEach, describe, expect, it } from 'vitest';

import { newDriverStats, recordOutcome, summarizeEvidence } from './driver-core';

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
  assertOauthNotAdvertised,
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
  redactSecrets,
  redactEvidenceDocument,
  registerSecret,
  clearRegisteredSecrets,
  currentSecrets,
  scrubSecrets,
  captureField,
  REDACTION_PLACEHOLDER,
  decodeJwtHeaderAlg,
  decodeJwtExpMs,
  tokenNeedsRegrant,
  ensureGoTrueToken,
  newMcpEvidence,
  GOTRUE_REGRANT_MARGIN_MS,
  newCaptureBudget,
  captureFor,
  buildMcpEvidenceDocument,
  MAX_CAPTURES_PER_LABEL,
  CAPTURE_MAX_SNIPPET,
  type GoTrueTokenBox,
  RENAMED_TOOLS,
  HOSTED_ALLOWED_NAME_PREFIXES,
  STDIO_ALLOWED_NAME_PREFIXES,
  STDIO_EXPECTED_TOOL_NAMES,
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
    expect(assertRequiredToolsPresent(cleanTools, RENAMED_TOOLS)).toBeNull();
  });

  it('assertRequiredToolsPresent flags a missing required tool', () => {
    const err = assertRequiredToolsPresent([{ name: 'get_anchor', description: '' }], RENAMED_TOOLS);
    expect(err).toMatch(/verify_anchor/);
    expect(err).toMatch(/search_anchors/);
  });

  it('assertApiOnlyNotePresent passes when both tools carry the note', () => {
    expect(assertApiOnlyNotePresent(cleanTools, RENAMED_TOOLS)).toBeNull();
  });

  it('assertApiOnlyNotePresent flags a tool missing the note', () => {
    const missingNote: McpToolSummary[] = [
      { name: 'arkova_verify_anchor', description: 'Verify an anchor, no note here.' },
      { name: 'arkova_search_anchors', description: 'Search, does NOT read local files.' },
    ];
    const err = assertApiOnlyNotePresent(missingNote, RENAMED_TOOLS);
    expect(err).toMatch(/verify_anchor/);
    expect(err).not.toMatch(/search_anchors/);
  });

  it('assertToolsList combines all three checks and reports every failure', () => {
    const body = {
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'search_credentials', description: 'old, no note' }] },
    };
    const a = assertToolsList(body, { required: RENAMED_TOOLS, note: RENAMED_TOOLS });
    expect(a.errors.length).toBeGreaterThan(0);
    expect(a.credentialNamedCount).toBe(1);
    expect(a.apiOnlyNotePresent).toBe(false);
  });

  it('RENAMED_TOOLS is the single list both surfaces require AND note-check', () => {
    expect(RENAMED_TOOLS).toEqual(['arkova_verify_anchor', 'arkova_search_anchors']);
  });

  it('assertToolsList applies the optional D4 prefix rule only when namePrefixes is given', () => {
    const body = {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'arkova_verify_anchor', description: 'does NOT read local files' },
          { name: 'arkova_search_anchors', description: 'does NOT read local files' },
          { name: 'legacy_unprefixed', description: 'does NOT read local files' },
        ],
      },
    };
    expect(assertToolsList(body, { required: RENAMED_TOOLS, note: RENAMED_TOOLS }).errors).toEqual([]);
    const withPrefixes = assertToolsList(body, {
      required: RENAMED_TOOLS,
      note: RENAMED_TOOLS,
      namePrefixes: HOSTED_ALLOWED_NAME_PREFIXES,
    });
    expect(withPrefixes.errors.join(' ')).toMatch(/legacy_unprefixed/);
  });

  it('assertToolsList applies the optional D5 exact-set rule only when exactNames is given', () => {
    const body = {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: STDIO_EXPECTED_TOOL_NAMES.map((name) => ({ name, description: 'does NOT read local files' })),
      },
    };
    const opts = {
      required: RENAMED_TOOLS,
      note: RENAMED_TOOLS,
      namePrefixes: STDIO_ALLOWED_NAME_PREFIXES,
      exactNames: STDIO_EXPECTED_TOOL_NAMES,
    };
    expect(assertToolsList(body, opts).errors).toEqual([]);
    const short = { ...body, result: { tools: body.result.tools.slice(0, 5) } };
    expect(assertToolsList(short, opts).errors.join(' ')).toMatch(/exactly 6 tools/);
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
    const a = assertToolsList(body, { required: RENAMED_TOOLS, note: RENAMED_TOOLS });
    expect(a.errors).toEqual([]);
    expect(a.credentialNamedCount).toBe(0);
    expect(a.apiOnlyNotePresent).toBe(true);
  });
});

describe('mcp-sdk-surface-driver: D3 OAuth discovery assertion (unconditional)', () => {
  it('a default run PASSES on a discovery body without authorization_servers (the post-D3 state)', () => {
    expect(assertOauthNotAdvertised({ resource: 'https://x/mcp', scopes_supported: [] })).toBeNull();
  });

  it('a default run FAILS when authorization_servers is still present', () => {
    const err = assertOauthNotAdvertised({ resource: 'https://x/mcp', authorization_servers: ['https://x/auth'] });
    expect(err).toMatch(/PRESENT/);
  });

  it('an empty authorization_servers array is still an advertisement (key presence is the test)', () => {
    expect(assertOauthNotAdvertised({ resource: 'https://x/mcp', authorization_servers: [] })).toMatch(/PRESENT/);
  });

  it('fails on a non-object body', () => {
    expect(assertOauthNotAdvertised(null)).toMatch(/not an object/);
    expect(assertOauthNotAdvertised(['a'])).toMatch(/not an object/);
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

  it('rejects the removed --expect-oauth-advertised flag outright (the D3 assertion is unconditional)', () => {
    expect(() => parseMcpSdkDriverArgs(['--expect-oauth-advertised', 'true'])).toThrow();
    expect(() => parseMcpSdkDriverArgs(['--expect-oauth-advertised=false'])).toThrow();
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


// Obviously-fake credential material: an `ak_test_` prefix plus 64 zeros can
// never be a live Arkova key (real keys are `ak_live_`/`ak_test_` + random hex).
const FAKE_API_KEY = `ak_test_${'0'.repeat(64)}`;
const FAKE_SERVICE_ROLE = `eyJhbGciOiJIUzI1NiJ9.${'0'.repeat(40)}.${'0'.repeat(43)}`;

describe('mcp-sdk-surface-driver: redactSecrets', () => {
  it('replaces every occurrence of a secret', () => {
    const text = `key=${FAKE_API_KEY} again=${FAKE_API_KEY}`;
    const out = redactSecrets(text, [FAKE_API_KEY]);
    expect(out).toBe(`key=${REDACTION_PLACEHOLDER} again=${REDACTION_PLACEHOLDER}`);
    expect(out).not.toContain(FAKE_API_KEY);
  });

  it('is a no-op for an empty secret list', () => {
    expect(redactSecrets('nothing to hide', [])).toBe('nothing to hide');
  });

  it('ignores empty-string entries rather than replacing between every character', () => {
    expect(redactSecrets('abc', ['', FAKE_API_KEY])).toBe('abc');
  });

  it('treats regex metacharacters literally (a secret is bytes, not a pattern)', () => {
    const metachar = 'a.b*c+d(e)f[g]h$i^j|k?';
    expect(redactSecrets(`x ${metachar} y`, [metachar])).toBe(`x ${REDACTION_PLACEHOLDER} y`);
    // The pattern must NOT match a string that only the REGEX form would match.
    expect(redactSecrets('aXbcccdef g h$i^j|k?', [metachar])).toBe('aXbcccdef g h$i^j|k?');
  });

  it('redacts longest-first so an overlapping prefix cannot leave the longer secret partly exposed', () => {
    const prefix = 'ak_test_0000';
    const out = redactSecrets(`full=${FAKE_API_KEY}`, [prefix, FAKE_API_KEY]);
    expect(out).toBe(`full=${REDACTION_PLACEHOLDER}`);
    expect(out).not.toContain('0000');
  });

  it('handles a secret that is a substring of another occurrence in the same text', () => {
    const out = redactSecrets(`${FAKE_API_KEY} and ak_test_0000`, [FAKE_API_KEY, 'ak_test_0000']);
    expect(out).toBe(`${REDACTION_PLACEHOLDER} and ${REDACTION_PLACEHOLDER}`);
  });
});

describe('mcp-sdk-surface-driver: secret registry', () => {
  afterEach(() => clearRegisteredSecrets());

  it('registers non-empty values only and scrubs them out of arbitrary text', () => {
    registerSecret(FAKE_API_KEY);
    registerSecret(undefined);
    registerSecret('');
    expect(currentSecrets()).toEqual([FAKE_API_KEY]);
    expect(scrubSecrets(`boom: ${FAKE_API_KEY}`)).toBe(`boom: ${REDACTION_PLACEHOLDER}`);
  });

  it('scrubs nothing when no secret has been registered', () => {
    expect(scrubSecrets(`boom: ${FAKE_API_KEY}`)).toBe(`boom: ${FAKE_API_KEY}`);
  });
});

describe('mcp-sdk-surface-driver: evidence never carries a registered secret', () => {
  afterEach(() => clearRegisteredSecrets());

  it('a simulated child failure whose message contains the API key yields evidence with ZERO occurrences', () => {
    registerSecret(FAKE_API_KEY);
    registerSecret(FAKE_SERVICE_ROLE);
    const stats = newDriverStats();
    // The exact shape the SDK-smoke catch blocks record: a child-process error
    // whose message echoes the argv/env it was handed.
    const err = new Error(
      `Command failed: python3 -c "..." (ARKOVA_SMOKE_API_KEY=${FAKE_API_KEY}) ` +
        `upstream said {"apikey":"${FAKE_SERVICE_ROLE}"}`,
    );
    recordOutcome(stats, {
      label: 'sdk:py:verify',
      endpoint: 'sdk:py:verify',
      method: 'SDK',
      status: 0,
      latencyMs: 12,
      expected: false,
      capturedBody: captureField(String(err.message)),
    });
    const evidence = summarizeEvidence(stats, { driver: 'mcp-sdk-surface', pr: '#2589', apiBase: 'https://rig.test' });
    const serialized = JSON.stringify(redactEvidenceDocument(evidence, currentSecrets()));
    expect(serialized).not.toContain(FAKE_API_KEY);
    expect(serialized).not.toContain(FAKE_SERVICE_ROLE);
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
  });

  it('redactEvidenceDocument is a belt-and-braces net for a body that bypassed captureField', () => {
    const stats = newDriverStats();
    recordOutcome(stats, {
      label: 'hosted:neg:bogus-key',
      endpoint: '/mcp',
      method: 'POST',
      status: 500,
      latencyMs: 3,
      // Not routed through captureField — an upstream error body that echoed the key.
      expected: false,
      capturedBody: { error: 'upstream', detail: `X-API-Key: ${FAKE_API_KEY}` },
    });
    const evidence = summarizeEvidence(stats, { driver: 'mcp-sdk-surface', pr: '#2589', apiBase: 'https://rig.test' });
    expect(JSON.stringify(evidence)).toContain(FAKE_API_KEY);
    const cleaned = redactEvidenceDocument(evidence, [FAKE_API_KEY]);
    expect(JSON.stringify(cleaned)).not.toContain(FAKE_API_KEY);
    // Still a well-formed evidence document, not a mangled string.
    expect(cleaned.capturedBodies[0].label).toBe('hosted:neg:bogus-key');
  });

  it('redacts a secret whose JSON-escaped form differs from its raw form', () => {
    const quoted = 'pw"with\\escapes';
    const doc = { note: `login failed for ${quoted}` };
    const cleaned = redactEvidenceDocument(doc, [quoted]);
    expect(JSON.stringify(cleaned)).not.toContain('with');
  });
});


// ── §D Bearer-JWT: GoTrue grant caching ──────────────────────────────────
// A syntactically real, cryptographically meaningless JWT: the signature is
// literal zeros, so this can never authenticate anywhere.
function fakeJwt(expSeconds: number | undefined, alg = 'ES256'): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const payload: Record<string, unknown> = { sub: 'tsoak-user', role: 'authenticated' };
  if (expSeconds !== undefined) payload.exp = expSeconds;
  return `${b64({ alg, typ: 'JWT' })}.${b64(payload)}.${'0'.repeat(43)}`;
}

describe('mcp-sdk-surface-driver: decodeJwtExpMs', () => {
  it('reads `exp` (seconds) out of the payload and returns milliseconds', () => {
    expect(decodeJwtExpMs(fakeJwt(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it('shares its decoding with the header `alg` read on the same token', () => {
    const token = fakeJwt(1_800_000_000, 'ES256');
    expect(decodeJwtHeaderAlg(token)).toBe('ES256');
    expect(decodeJwtExpMs(token)).toBe(1_800_000_000_000);
  });

  it('returns null when the payload has no exp, or is malformed', () => {
    expect(decodeJwtExpMs(fakeJwt(undefined))).toBeNull();
    expect(decodeJwtExpMs('not-a-jwt')).toBeNull();
    expect(decodeJwtExpMs('aaa.!!!not-base64-json!!!.bbb')).toBeNull();
  });
});

describe('mcp-sdk-surface-driver: tokenNeedsRegrant', () => {
  const NOW = 1_800_000_000_000;

  it('needs a grant when nothing is cached', () => {
    expect(tokenNeedsRegrant(null, NOW)).toBe(true);
  });

  it('REUSES a cached token that is comfortably inside its lifetime', () => {
    expect(tokenNeedsRegrant({ token: 't', expMs: NOW + 3_600_000 }, NOW)).toBe(false);
  });

  it('reuses right up to the margin boundary, then re-grants', () => {
    expect(tokenNeedsRegrant({ token: 't', expMs: NOW + GOTRUE_REGRANT_MARGIN_MS + 1 }, NOW)).toBe(false);
    expect(tokenNeedsRegrant({ token: 't', expMs: NOW + GOTRUE_REGRANT_MARGIN_MS }, NOW)).toBe(true);
  });

  it('re-grants once the token has actually expired', () => {
    expect(tokenNeedsRegrant({ token: 't', expMs: NOW - 1 }, NOW)).toBe(true);
  });

  it('re-grants when exp could not be decoded — an unprovable lifetime is not a reusable one', () => {
    expect(tokenNeedsRegrant({ token: 't', expMs: null }, NOW)).toBe(true);
  });
});

describe('mcp-sdk-surface-driver: ensureGoTrueToken', () => {
  afterEach(() => clearRegisteredSecrets());

  const NOW = 1_800_000_000_000;
  const liveToken = fakeJwt(NOW / 1000 + 3600);

  function harness(box: GoTrueTokenBox, grant: () => Promise<string>) {
    const stats = newDriverStats();
    return {
      stats,
      deps: { box, stats, evidence: newMcpEvidence(), log: () => {}, grant, now: () => NOW },
    };
  }

  it('grants once, then REUSES the cached token on the next cycle without calling GoTrue again', async () => {
    const box: GoTrueTokenBox = { current: null };
    let grants = 0;
    const grant = async () => { grants++; return liveToken; };
    const h = harness(box, grant);
    expect(await ensureGoTrueToken(h.deps)).toBe(liveToken);
    expect(await ensureGoTrueToken(h.deps)).toBe(liveToken);
    expect(await ensureGoTrueToken(h.deps)).toBe(liveToken);
    expect(grants).toBe(1);
  });

  it('re-grants once the cached token is inside the 120s expiry margin', async () => {
    const nearExpiry = fakeJwt(NOW / 1000 + 60); // 60s left — inside the margin
    const box: GoTrueTokenBox = { current: null };
    let grants = 0;
    const tokens = [nearExpiry, liveToken];
    const grant = async () => tokens[grants++];
    const h = harness(box, grant);
    expect(await ensureGoTrueToken(h.deps)).toBe(nearExpiry);
    expect(await ensureGoTrueToken(h.deps)).toBe(liveToken);
    expect(grants).toBe(2);
  });

  it('forceRegrant bypasses a still-live cache (the post-401 path)', async () => {
    const box: GoTrueTokenBox = { current: null };
    let grants = 0;
    const grant = async () => { grants++; return liveToken; };
    const h = harness(box, grant);
    await ensureGoTrueToken(h.deps);
    await ensureGoTrueToken({ ...h.deps, forceRegrant: true });
    expect(grants).toBe(2);
  });

  it('registers the granted token as a secret so it can never reach evidence', async () => {
    const box: GoTrueTokenBox = { current: null };
    const h = harness(box, async () => liveToken);
    await ensureGoTrueToken(h.deps);
    expect(currentSecrets()).toContain(liveToken);
  });

  it('a FAILED grant records an unexpected `hosted:bearer:gotrue-grant` outcome — it is not silent', async () => {
    const box: GoTrueTokenBox = { current: null };
    const h = harness(box, async () => { throw new Error('GoTrue password grant failed: HTTP 400'); });
    expect(await ensureGoTrueToken(h.deps)).toBeNull();

    const evidence = summarizeEvidence(h.stats, { driver: 'mcp-sdk-surface', pr: '#2589', apiBase: 'https://rig.test' });
    expect(evidence.allExpected).toBe(false);
    expect(evidence.byLabel['hosted:bearer:gotrue-grant'].unexpected).toBe(1);
    // …while still marking the section skipped, so downstream evidence readers
    // can tell "Bearer probes did not run" from "Bearer probes failed".
    expect(h.deps.evidence.bearerSkipped).toMatch(/gotrue/);
    expect(box.current).toBeNull();
  });

  it('a failed grant does not leak the GoTrue error text into evidence unredacted', async () => {
    registerSecret(FAKE_API_KEY);
    const box: GoTrueTokenBox = { current: null };
    const h = harness(box, async () => { throw new Error(`grant failed for key ${FAKE_API_KEY}`); });
    await ensureGoTrueToken(h.deps);
    const evidence = summarizeEvidence(h.stats, { driver: 'mcp-sdk-surface', pr: '#2589', apiBase: 'https://rig.test' });
    expect(JSON.stringify(evidence)).not.toContain(FAKE_API_KEY);
  });
});


describe('mcp-sdk-surface-driver: captured-body budget (§4b)', () => {
  afterEach(() => clearRegisteredSecrets());

  it('admits up to MAX_CAPTURES_PER_LABEL bodies for one label, then drops and counts', () => {
    const budget = newCaptureBudget();
    let admitted = 0;
    for (let i = 0; i < MAX_CAPTURES_PER_LABEL + 7; i++) {
      if (captureFor(budget, 'hosted:call:verify_anchor', { i }).capturedBody !== undefined) admitted++;
    }
    expect(admitted).toBe(MAX_CAPTURES_PER_LABEL);
    expect(budget.dropped).toBe(7);
  });

  it('budgets PER LABEL — a noisy branch cannot starve a quiet one', () => {
    const budget = newCaptureBudget(2);
    captureFor(budget, 'noisy', { a: 1 });
    captureFor(budget, 'noisy', { a: 2 });
    expect(captureFor(budget, 'noisy', { a: 3 }).capturedBody).toBeUndefined();
    expect(captureFor(budget, 'quiet', { a: 1 }).capturedBody).toEqual({ a: 1 });
    expect(budget.dropped).toBe(1);
  });

  it('truncates an oversized captured body to CAPTURE_MAX_SNIPPET', () => {
    const budget = newCaptureBudget();
    const huge = 'x'.repeat(CAPTURE_MAX_SNIPPET * 4);
    const captured = captureFor(budget, 'hosted:call:search', huge).capturedBody;
    expect(typeof captured).toBe('string');
    expect((captured as string).length).toBeLessThanOrEqual(CAPTURE_MAX_SNIPPET + 32);
    expect(captured as string).toMatch(/truncated/);
  });

  it('truncates an oversized JSON body too, rather than retaining megabytes of it', () => {
    const budget = newCaptureBudget();
    const captured = captureFor(budget, 'hosted:tools/list', { blob: 'y'.repeat(CAPTURE_MAX_SNIPPET * 2) }).capturedBody;
    expect(typeof captured).toBe('string');
    expect((captured as string).length).toBeLessThanOrEqual(CAPTURE_MAX_SNIPPET + 32);
  });

  it('scrubs registered secrets on the way into the budgeted capture', () => {
    registerSecret(FAKE_API_KEY);
    const budget = newCaptureBudget();
    const captured = captureFor(budget, 'sdk:py:verify', `child failed with ${FAKE_API_KEY}`).capturedBody;
    expect(captured).toBe(`child failed with ${REDACTION_PLACEHOLDER}`);
  });

  it('a dropped capture still records the outcome — only the body is shed', () => {
    const budget = newCaptureBudget(1);
    const stats = newDriverStats();
    for (let i = 0; i < 3; i++) {
      recordOutcome(stats, {
        label: 'stdio:hygiene',
        endpoint: 'stdio:stdout',
        method: 'STDIO',
        status: 599,
        latencyMs: 0,
        expected: false,
        ...captureFor(budget, 'stdio:hygiene', { nonJsonLines: ['banner'] }),
      });
    }
    const evidence = summarizeEvidence(stats, { driver: 'mcp-sdk-surface', pr: '#2589', apiBase: 'https://rig.test' });
    expect(evidence.byLabel['stdio:hygiene'].unexpected).toBe(3);
    expect(evidence.capturedBodies).toHaveLength(1);
    expect(budget.dropped).toBe(2);
  });
});

describe('mcp-sdk-surface-driver: buildMcpEvidenceDocument (§4a checkpointing)', () => {
  function doc(complete: boolean) {
    const stats = newDriverStats();
    recordOutcome(stats, {
      label: 'hosted:initialize', endpoint: '/mcp', method: 'POST', status: 200, latencyMs: 5, expected: true,
    });
    return buildMcpEvidenceDocument({
      stats,
      apiBase: 'https://rig.test',
      edgeMcpBase: 'https://edge-mcp.test',
      mcp: { ...newMcpEvidence(), droppedCaptures: 4 },
      cycles: 3,
      complete,
    });
  }

  it('a mid-run write is marked checkpoint:true / complete:false', () => {
    const d = doc(false);
    expect(d.checkpoint).toBe(true);
    expect(d.complete).toBe(false);
  });

  it('the final write flips to checkpoint:false / complete:true', () => {
    const d = doc(true);
    expect(d.checkpoint).toBe(false);
    expect(d.complete).toBe(true);
  });

  it('carries the driver summary, the MCP extension, the cycle count and the dropped-capture count', () => {
    const d = doc(false);
    expect(d.driver).toBe('mcp-sdk-surface');
    expect(d.pr).toBe('#2589');
    expect(d.edgeMcpBase).toBe('https://edge-mcp.test');
    expect(d.cycles).toBe(3);
    expect(d.totalRequests).toBe(1);
    expect(d.mcp.droppedCaptures).toBe(4);
  });

  it('newMcpEvidence starts with a zero dropped-capture count', () => {
    expect(newMcpEvidence().droppedCaptures).toBe(0);
  });
});
