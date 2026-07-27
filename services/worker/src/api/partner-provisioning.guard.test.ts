/**
 * Static guard tests for the partner-provisioning skeleton (SCRUM-2990).
 *
 * Slice-plan constraints this file enforces:
 *
 *  1. NO LIVE PROVISIONING in the skeleton path — the domain module performs no
 *     side-effectful writes (no DB client, no RPC, no fetch); its only outputs
 *     are its own state-machine record + audit event BODY (persisted elsewhere
 *     by the service_role audit writer).
 *  2. NO SECRET HANDLING — zero API-key material, zero credential generation,
 *     zero Secret Manager touches. Enforced as a static import-guard (exact
 *     import allowlist + forbidden-module scan), in the spirit of the
 *     scripts/ci grep-style guards (e.g. ban-raw-fetch-worker.ts).
 *  3. FLAG WIRING — the whole surface prefix is mounted behind
 *     partnerProvisioningGate() in index.ts, and ENABLE_PARTNER_PROVISIONING is
 *     registered in the flagRegistry DB_FLAGS list.
 *
 * These are invariant guards: if a later change wires the provision step to a
 * real org/user/key creation path without moving it out of the skeleton module
 * (and through review), this suite goes red.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const moduleSource = readFileSync(
  fileURLToPath(new URL('./partner-provisioning.ts', import.meta.url)),
  'utf8',
);
const indexSource = readFileSync(
  fileURLToPath(new URL('../index.ts', import.meta.url)),
  'utf8',
);
const flagRegistrySource = readFileSync(
  fileURLToPath(new URL('../middleware/flagRegistry.ts', import.meta.url)),
  'utf8',
);

/** Every module specifier imported by partner-provisioning.ts (static imports). */
function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // Static imports (with or without bindings) + re-exports.
  const re = /^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const bare = /^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(re)) specifiers.push(m[1]);
  for (const m of source.matchAll(bare)) specifiers.push(m[1]);
  return specifiers;
}

describe('partner-provisioning skeleton: no live provisioning (SCRUM-2990)', () => {
  it('imports ONLY the exact allowlist (pure module: zod + randomUUID + audit type)', () => {
    const specifiers = importedSpecifiers(moduleSource).sort();
    expect(specifiers).toEqual(['./audit-event.js', 'node:crypto', 'zod']);
  });

  it('performs no side-effectful writes (no DB / RPC / HTTP / env / dynamic import)', () => {
    for (const forbidden of [
      '.insert(',
      '.update(',
      '.upsert(',
      '.delete(',
      '.rpc(',
      'fetch(',
      'axios',
      'process.env',
      'import(',
      'require(',
    ]) {
      expect(moduleSource, `skeleton must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('outputs are limited to its own record + audit body (audit-event import is type-only)', () => {
    // The audit writer is invoked by the API layer, never from the skeleton.
    expect(moduleSource).toMatch(/import\s+type\s+\{[^}]*AuditEventBody[^}]*\}\s+from\s+'\.\/audit-event\.js'/);
  });
});

describe('partner-provisioning skeleton: no secret handling (SCRUM-2990)', () => {
  it('imports no key-generation / secret / credential modules', () => {
    for (const forbidden of [
      'secret-manager', // @google-cloud/secret-manager
      'secretmanager',
      'apiKeyAuth', // API-key HMAC verification / issuance surface
      'apiScopes',
      'proof-keys', // proof signing key management
      'kms',
      'googleapis',
      'stripe',
      '@supabase',
      'utils/db', // service_role DB client
      'utils/rpc',
      'bitcoinjs',
      'child_process',
      'node:fs',
      "from 'fs'",
    ]) {
      expect(
        moduleSource.toLowerCase(),
        `skeleton must not reference "${forbidden}"`,
      ).not.toContain(forbidden.toLowerCase());
    }
  });

  it('uses node:crypto for randomUUID ONLY — no key/HMAC/cipher material', () => {
    const cryptoImport = moduleSource.match(
      /import\s+\{([^}]*)\}\s+from\s+'node:crypto'/,
    );
    expect(cryptoImport).not.toBeNull();
    const bindings = cryptoImport![1].split(',').map((b) => b.trim()).filter(Boolean);
    expect(bindings).toEqual(['randomUUID']);
    for (const forbidden of [
      'createHmac',
      'createHash',
      'createCipher',
      'createSign',
      'generateKey',
      'randomBytes',
      'pbkdf2',
      'scrypt',
      'privateKey',
      'publicKey',
    ]) {
      expect(moduleSource, `skeleton must not use crypto "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

describe('partner-provisioning surface: flag wiring (SCRUM-2990)', () => {
  it('index.ts mounts the reserved surface prefix behind partnerProvisioningGate()', () => {
    expect(indexSource).toContain("'/api/partner-provisioning'");
    expect(indexSource).toMatch(
      /app\.use\(\s*'\/api\/partner-provisioning'\s*,\s*partnerProvisioningGate\(\)/,
    );
  });

  it('ENABLE_PARTNER_PROVISIONING is registered as a DB-backed switchboard flag', () => {
    const dbFlagsBlock = flagRegistrySource.match(/const DB_FLAGS = \[([\s\S]*?)\] as const;/);
    expect(dbFlagsBlock).not.toBeNull();
    expect(dbFlagsBlock![1]).toContain("'ENABLE_PARTNER_PROVISIONING'");
  });
});
