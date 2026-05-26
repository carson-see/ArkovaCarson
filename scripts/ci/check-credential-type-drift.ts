#!/usr/bin/env tsx
/**
 * CI guard: credential_type enum drift detector (SCRUM-2013).
 *
 * Extracts credential type arrays from all known locations and verifies
 * they contain exactly the same set of values as the canonical source
 * (services/worker/src/lib/credential-evidence.ts ANCHOR_CREDENTIAL_TYPES).
 *
 * Exit 0 = all in sync. Exit 1 = drift detected.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface SourceLocation {
  file: string;
  pattern: RegExp;
  description: string;
}

const CANONICAL: SourceLocation = {
  file: 'services/worker/src/lib/credential-evidence.ts',
  pattern: /ANCHOR_CREDENTIAL_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/,
  description: 'Canonical source (worker credential-evidence.ts)',
};

const LOCATIONS: SourceLocation[] = [
  {
    file: 'src/lib/validators.ts',
    pattern: /export const CREDENTIAL_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/,
    description: 'Frontend validators.ts',
  },
  {
    file: 'src/lib/csvParser.ts',
    pattern: /VALID_CREDENTIAL_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/,
    description: 'CSV parser',
  },
  {
    file: 'services/worker/src/api/v1/anchor-bulk.ts',
    pattern: /const CREDENTIAL_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/,
    description: 'Bulk anchor endpoint',
  },
];

function extractTypes(content: string, pattern: RegExp): string[] {
  const match = pattern.exec(content);
  if (!match?.[1]) return [];
  const raw = match[1];
  return [...raw.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
}

function extractRecordKeys(content: string, varName: string): string[] {
  const pattern = new RegExp(String.raw`${varName}[^=]*=\s*\{([\s\S]*?)\};`);
  const match = pattern.exec(content);
  if (!match?.[1]) return [];
  return [...match[1].matchAll(/^\s*([A-Z_]+)\s*:/gm)].map(m => m[1]);
}

let failures = 0;

const canonicalContent = readFileSync(resolve(ROOT, CANONICAL.file), 'utf-8');
const canonicalTypes = extractTypes(canonicalContent, CANONICAL.pattern);

if (canonicalTypes.length === 0) {
  console.error(`ERROR: Could not extract types from ${CANONICAL.file}`);
  process.exit(1);
}

const canonicalSet = new Set(canonicalTypes);
console.log(`Canonical source: ${canonicalTypes.length} types in ${CANONICAL.file}`);

for (const loc of LOCATIONS) {
  const content = readFileSync(resolve(ROOT, loc.file), 'utf-8');
  const types = extractTypes(content, loc.pattern);
  const locSet = new Set(types);

  const missing = canonicalTypes.filter(t => !locSet.has(t));
  const extra = types.filter(t => !canonicalSet.has(t));

  if (missing.length > 0 || extra.length > 0) {
    failures++;
    console.error(`\nDRIFT in ${loc.description} (${loc.file}):`);
    if (missing.length > 0) console.error(`  Missing: ${missing.join(', ')}`);
    if (extra.length > 0) console.error(`  Extra:   ${extra.join(', ')}`);
  } else {
    console.log(`  OK: ${loc.description} (${types.length} types)`);
  }
}

// Check embed CREDENTIAL_LABELS record keys
const embedFile = 'packages/embed/src/render.ts';
const embedContent = readFileSync(resolve(ROOT, embedFile), 'utf-8');
const embedKeys = extractRecordKeys(embedContent, 'CREDENTIAL_LABELS');

if (embedKeys.length > 0) {
  const embedSet = new Set(embedKeys);
  const missing = canonicalTypes.filter(t => !embedSet.has(t));
  const extra = embedKeys.filter(t => !canonicalSet.has(t));

  if (missing.length > 0 || extra.length > 0) {
    failures++;
    console.error(`\nDRIFT in Embed widget (${embedFile}):`);
    if (missing.length > 0) console.error(`  Missing: ${missing.join(', ')}`);
    if (extra.length > 0) console.error(`  Extra:   ${extra.join(', ')}`);
  } else {
    console.log(`  OK: Embed widget (${embedKeys.length} types)`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} location(s) have drifted from the canonical credential type list.`);
  console.error('Fix: update the drifted file(s) to match ANCHOR_CREDENTIAL_TYPES in credential-evidence.ts');
  process.exit(1);
} else {
  console.log('\nAll credential type locations are in sync.');
}
