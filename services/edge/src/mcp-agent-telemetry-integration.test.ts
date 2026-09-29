import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  rate: vi.fn(),
  sentry: vi.fn(),
  ingest: vi.fn(() => [{ type: 'test-alert' }]),
}));
vi.mock('./mcp-audit-log', () => ({ fireAndForgetAudit: mocks.audit }));
vi.mock('./mcp-rate-limit', () => ({ enforceRateLimit: mocks.rate }));
vi.mock('./mcp-anomaly-detection', () => ({
  createAnomalyDetector: () => ({ ingest: mocks.ingest }),
  sendToSentry: mocks.sentry,
}));

import { createMcpServer, withTelemetry, type RequestTelemetryContext } from './mcp-server.js';

const sentinel = 'SENTINEL-RECEIPT-AND-CREDENTIAL';
const passportId = 'bbbbbbbb-0000-4000-8000-000000000001';
const telemetry: RequestTelemetryContext = {
  env: { SENTRY_DSN: 'https://sentry.invalid/1' } as never,
  execCtx: { waitUntil: vi.fn((promise: Promise<unknown>) => promise), passThroughOnException: vi.fn() },
  apiKeyId: 'key-id', userId: 'user-id', anchorDocumentEnabled: false, clientIp: null,
};
const auditEntries = () => mocks.audit.mock.calls.map(([, entry]) => entry);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue({ ok: true });
  mocks.sentry.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('lifecycle telemetry through the real wrapper', () => {
  it.each([
    ['validation', { name: sentinel.repeat(30) }, { ok: true }, vi.fn(), 'tool_error'],
    ['rate-limit', { name: sentinel }, { ok: false, retryAfterSeconds: 1, limit: 1, toolName: 'arkova_register_agent' }, vi.fn(), 'rate_limited'],
  ])('projects secret input before %s and audits exactly once', async (_path, args, decision, handler, outcome) => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.rate.mockResolvedValueOnce(decision);
    const result = await withTelemetry('arkova_register_agent', handler, telemetry)(args);
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(auditEntries()).toHaveLength(1);
    expect(auditEntries()[0].outcome).toBe(outcome);
    expect(JSON.stringify(auditEntries())).not.toContain(sentinel);
    expect(JSON.stringify(mocks.sentry.mock.calls)).not.toContain(sentinel);
    expect(mocks.sentry).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(sentinel);
    consoleSpy.mockRestore();
  });

  it.each([
    ['handler error', vi.fn(async () => ({ isError: true, content: [{ type: 'text' as const, text: 'fixed' }] })), 'tool_error'],
    ['thrown handler', vi.fn(async () => { throw new Error(sentinel); }), 'tool_error'],
    ['success', vi.fn(async () => ({ content: [{ type: 'text' as const, text: sentinel }] })), 'success'],
  ])('audits %s once without serializing input or output', async (_path, handler, outcome) => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withTelemetry('arkova_register_agent', handler, telemetry)({ name: sentinel });
    expect(handler).toHaveBeenCalledOnce();
    expect(auditEntries()).toHaveLength(1);
    expect(auditEntries()[0].outcome).toBe(outcome);
    expect(JSON.stringify(auditEntries())).not.toContain(sentinel);
    expect(JSON.stringify(mocks.sentry.mock.calls)).not.toContain(sentinel);
    expect(mocks.sentry).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(sentinel);
    consoleSpy.mockRestore();
  });
});

describe('registered admission tool telemetry', () => {
  it('calls the actual registration callback and excludes receipt/key sentinels from audit, Sentry, and console', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = {
      agent: { id:'agent-id', name:'Agent', agent_type:'custom', status:'active', allowed_scopes:['verify'], created_at:'2026-09-26T00:00:00Z' },
      binding: { issuer:'computeid', passport_id:passportId, bound_at:'2026-09-26T00:00:00Z', receipt_expires_at:'2026-09-27T00:00:00Z' },
      key: sentinel, key_id:'key-id', key_prefix:'ak_once', scopes:['verify'], warning:'Store once.',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(response, { status: 201 })));
    const server = createMcpServer({ supabaseUrl:'https://db.test', supabaseKey:'service', userId:'user-id', workerBaseUrl:'https://worker.test', callerApiKey:'ak_caller' }, telemetry);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name:'telemetry-test', version:'1' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({ name:'arkova_admit_computeid_agent', arguments:{ passport_id:passportId, verification_receipt:{ passport_id:passportId, status:'active', issued_at:'2026-09-26', expires_at:'2026-09-27', key_id:'0123456789abcdef', receipt_signature:sentinel, receipt_algorithm:'ed25519', receipt_payload:sentinel } } });
    expect(result.isError).not.toBe(true);
    expect(auditEntries()).toHaveLength(1);
    expect(auditEntries()[0].outcome).toBe('success');
    expect(JSON.stringify(auditEntries())).not.toContain(sentinel);
    expect(JSON.stringify(mocks.sentry.mock.calls)).not.toContain(sentinel);
    expect(mocks.sentry).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(sentinel);
    await client.close(); await server.close(); consoleSpy.mockRestore();
  });
});
