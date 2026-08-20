// scripts/staging/wave3-mcp-audit-probe.ts
//
// Wave 3 soak-driver probe for #2232's BUG-2026-08-13-XXX P0 fix: the MCP
// audit log (services/edge/src/mcp-audit-log.ts logMcpToolCall) had never
// written a row to production audit_events. This script imports the REAL,
// shipped `logMcpToolCall` function (no reimplementation, no mock) and
// invokes it against the real arkova-wave3-2026-08 rig, proving the write
// mechanism itself — not a simulated request pipeline — actually persists
// a row.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/staging/wave3-mcp-audit-probe.ts

import { logMcpToolCall } from '../../services/edge/src/mcp-audit-log.js';

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const env = {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    // MCP_IP_HASH_PEPPER intentionally omitted: pseudonymizeIp fails closed
    // to ip_hash: null when unset, per mcp-audit-log.ts's own contract.
  } as never;

  await logMcpToolCall(env, {
    toolName: 'anchor_document',
    userId: '5eed0000-0000-0000-0000-0000000000a1',
    apiKeyId: null,
    argsJson: JSON.stringify({ content_hash: 'a'.repeat(64), source: 'wave3-soak-driver' }),
    outcome: 'success',
    latencyMs: 42,
    clientIp: '203.0.113.7',
  });

  console.log('logMcpToolCall invoked — check audit_events for event_type=MCP_TOOL_CALL, target_id=anchor_document');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
