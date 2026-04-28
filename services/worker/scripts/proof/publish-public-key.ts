#!/usr/bin/env tsx
/**
 * Publish-public-key helper for SCRUM-900 (PROOF-SIG-01).
 *
 * Reads the public key for a deployed GCP KMS Ed25519 key (no private
 * material) and appends/updates the matching entry in
 * `docs/public-keys.json`. Operators run this after provisioning a new
 * KMS key version to keep the verifier-facing registry accurate.
 *
 * Usage:
 *   npx tsx services/worker/scripts/proof/publish-public-key.ts \
 *       projects/arkova1/.../cryptoKeyVersions/2 \
 *       arkova-proof-2027-04
 *
 * The script does NOT push to docs.arkova.ai directly — it edits the
 * file in-tree; you commit + ship that change through the normal docs
 * deploy. Reason: this avoids giving the worker SA write access to the
 * docs hosting bucket, and keeps the registry change auditable in git.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKmsPublicKeyPem } from '../../src/proof/kms-ed25519-signer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RegistryKey {
  signing_key_id: string;
  status: 'active' | 'retired' | 'compromised';
  algorithm: 'Ed25519';
  publicKeyPem: string;
  issued_at_utc: string;
  retired_at_utc: string | null;
  kms_key_name: string;
  notes?: string;
}

interface Registry {
  service: string;
  bundle_version: string;
  signature_algorithm: string;
  keys: RegistryKey[];
  [key: string]: unknown;
}

async function main() {
  const [, , kmsKeyName, signingKeyId] = process.argv;
  if (!kmsKeyName || !signingKeyId) {
    console.error('Usage: publish-public-key.ts <kmsKeyName> <signingKeyId>');
    process.exit(1);
  }

  const registryPath = resolve(__dirname, '..', '..', '..', '..', 'docs', 'public-keys.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as Registry;

  const pem = await fetchKmsPublicKeyPem(kmsKeyName);
  const nowIso = new Date().toISOString();

  // Normalize line endings + surrounding whitespace before comparing —
  // KMS may return CRLF while the JSON-stored PEM was saved with LF only,
  // and a stray trailing newline shouldn't trigger a false "different
  // key" rejection.
  const normalizePem = (s: string): string => s.replace(/\r\n/g, '\n').trim();
  const existing = registry.keys.find(k => k.signing_key_id === signingKeyId);
  if (existing) {
    if (normalizePem(existing.publicKeyPem) === normalizePem(pem)) {
      console.log(`Key '${signingKeyId}' already current — no change.`);
      return;
    }
    console.error(
      `Key '${signingKeyId}' is already in the registry with a DIFFERENT publicKeyPem. ` +
        'Refusing to overwrite. Use a fresh signing_key_id and retire the old one.',
    );
    process.exit(2);
  }

  // Mark prior `active` keys as retired.
  for (const k of registry.keys) {
    if (k.status === 'active') {
      k.status = 'retired';
      k.retired_at_utc = nowIso;
    }
  }

  const entry: RegistryKey = {
    signing_key_id: signingKeyId,
    status: 'active',
    algorithm: 'Ed25519',
    publicKeyPem: pem.trim(),
    issued_at_utc: nowIso,
    retired_at_utc: null,
    kms_key_name: kmsKeyName,
  };
  registry.keys.push(entry);

  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${registryPath} — added '${signingKeyId}' as active.`);
  console.log('Commit + ship via docs deploy so docs.arkova.ai/keys.json picks up.');
}

main().catch(err => {
  console.error('publish-public-key failed:', err);
  process.exit(1);
});
