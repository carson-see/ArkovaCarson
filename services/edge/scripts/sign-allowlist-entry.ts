#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1283 (R3-10) sub-issue A — operator helper.
 *
 * Wraps a per-API-key allowlist entry into the signed envelope shape
 * `{ value, signature }` that the edge worker's `mcp-origin-allowlist.ts`
 * read path verifies before parsing.
 *
 * Usage:
 *   echo '{"mode":"allowlist","cidrs":["1.2.3.4/32"]}' \
 *     | MCP_ALLOWLIST_HMAC_SECRET=<secret> npx tsx services/edge/scripts/sign-allowlist-entry.ts \
 *     | wrangler kv key put --binding=MCP_ORIGIN_ALLOWLIST_KV "allow:<api_key_id>" --
 *
 * The script reads the inner-entry JSON from stdin, signs it with the
 * HMAC secret from the env, and prints the signed envelope JSON to
 * stdout. It deliberately does not call `wrangler` itself so the
 * operator can pipe the output to any KV-write workflow.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const secret = process.env.MCP_ALLOWLIST_HMAC_SECRET;
if (!secret) {
  console.error('error: MCP_ALLOWLIST_HMAC_SECRET env var is required');
  process.exit(2);
}

let value: string;
try {
  value = readFileSync(0, 'utf8').trim();
} catch (err) {
  console.error(`error: failed to read stdin: ${(err as Error).message}`);
  process.exit(2);
}

if (!value) {
  console.error('error: stdin was empty (expected inner-entry JSON)');
  process.exit(2);
}

// Minimal JSON.parse + serialize round-trip so the signed bytes are the
// exact serialization the read path will hash. (The read path stores
// the operator-supplied `value` string verbatim, so we sign whatever
// the operator handed us, but bail loudly if it isn't valid JSON.)
try {
  JSON.parse(value);
} catch (err) {
  console.error(`error: stdin is not valid JSON: ${(err as Error).message}`);
  process.exit(2);
}

const signature = createHmac('sha256', secret).update(value).digest('hex');
process.stdout.write(JSON.stringify({ value, signature }));
process.stdout.write('\n');
