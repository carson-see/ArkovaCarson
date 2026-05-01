#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1282 (R3-9) — block new inline `crypto.createHmac` in webhook handlers.
 *
 * Every inbound connector webhook MUST verify HMAC through one of the two
 * canonical helpers:
 *   - `services/worker/src/middleware/webhookHmac.ts` (Express middleware)
 *   - `services/worker/src/integrations/oauth/hmac.ts verifyHmacSha256*`
 *
 * 4+ separate inline reimplementations of `crypto.createHmac('sha256', ...)`
 * in webhook handlers existed at the time of SCRUM-1025 (which claimed
 * "uniform HMAC middleware… 12 unit tests — every reject path"). This lint
 * catches new ones at PR time.
 *
 * Override: PR labeled `webhook-hmac-inline-intentional` (rare; vendor
 * signature scheme that genuinely cannot delegate, e.g. ECDSA/RSA).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OVERRIDE_LABEL = 'webhook-hmac-inline-intentional';
const REPO = process.env.WEBHOOK_HMAC_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const prLabels = (process.env.PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// Webhook handler paths that must delegate.
const WEBHOOK_HANDLER_GLOBS = [
  /^services\/worker\/src\/api\/v1\/webhooks\/[^/]+\.ts$/,
  /^services\/worker\/src\/integrations\/(kyb|connectors)\/[^/]+\.ts$/,
];

// Canonical files that ARE allowed to use crypto.createHmac directly.
const CANONICAL_FILES = new Set<string>([
  'services/worker/src/middleware/webhookHmac.ts',
  'services/worker/src/integrations/oauth/hmac.ts',
]);

const HMAC_REGEX = /\bcrypto\.createHmac\b/g;

interface Finding {
  file: string;
  line: number;
  context: string;
}

function lineNumber(text: string, idx: number): number {
  return text.slice(0, idx).split('\n').length;
}

function lineContext(text: string, idx: number): string {
  const start = text.lastIndexOf('\n', idx) + 1;
  const end = text.indexOf('\n', idx);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 120);
}

function isWebhookHandler(file: string): boolean {
  if (CANONICAL_FILES.has(file)) return false;
  if (file.endsWith('.test.ts')) return false;
  return WEBHOOK_HANDLER_GLOBS.some((re) => re.test(file));
}

function scan(): Finding[] {
  const files = execSync('git ls-files services/worker/src', { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((p) => p.endsWith('.ts'))
    .filter(isWebhookHandler);

  const findings: Finding[] = [];
  for (const file of files) {
    const body = readFileSync(resolve(REPO, file), 'utf8');
    let match: RegExpExecArray | null;
    HMAC_REGEX.lastIndex = 0;
    while ((match = HMAC_REGEX.exec(body)) !== null) {
      const ctx = lineContext(body, match.index);
      // Skip if the match is in a comment line.
      if (/^\s*(?:\/\/|\*)/.test(ctx)) continue;
      findings.push({ file, line: lineNumber(body, match.index), context: ctx });
    }
  }
  return findings;
}

function main(): void {
  const findings = scan();
  if (findings.length === 0) {
    console.log('✅ No inline crypto.createHmac in webhook handlers — all delegate to canonical helpers.');
    return;
  }

  if (prLabels.includes(OVERRIDE_LABEL)) {
    console.log(`⚠️  PR labeled \`${OVERRIDE_LABEL}\` — allowing ${findings.length} inline occurrence(s).`);
    for (const f of findings) console.log(`  ${f.file}:${f.line} → ${f.context}`);
    return;
  }

  console.error(`::error::SCRUM-1282: ${findings.length} inline crypto.createHmac in webhook handler(s):`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.context}`);
  }
  console.error('');
  console.error('Webhook handlers must delegate HMAC verification to one of:');
  console.error('  - services/worker/src/middleware/webhookHmac.ts (Express middleware)');
  console.error('  - services/worker/src/integrations/oauth/hmac.ts verifyHmacSha256{,Hex,Base64}');
  console.error('');
  console.error('SCRUM-1025 (false-Done) claimed "uniform HMAC middleware" but 4+ inline');
  console.error('reimplementations were left behind. This lint blocks regression.');
  console.error(`Override label (rare, e.g. non-HMAC schemes): \`${OVERRIDE_LABEL}\`.`);
  process.exit(1);
}

main();
