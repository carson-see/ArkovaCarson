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
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface SourceLocation {
  file: string;
  pattern: RegExp;
  description: string;
}

interface TypeLocation {
  file: string;
  description: string;
  types: string[];
}

export interface DriftViolation {
  file: string;
  description: string;
  missing: string[];
  extra: string[];
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

export function extractTypes(content: string, pattern: RegExp): string[] {
  const match = pattern.exec(content);
  if (!match?.[1]) return [];
  const raw = match[1];
  return [...raw.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
}

/**
 * Escape special regex metacharacters in a string so it can be safely
 * interpolated into a RegExp constructor without risk of regex injection
 * (SonarCloud S2631).
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRecordKeys(content: string, varName: string): string[] {
  const safeVarName = escapeRegExp(varName);
  const pattern = new RegExp(String.raw`${safeVarName}[^=]*=\s*\{([\s\S]*?)\};`);
  const match = pattern.exec(content);
  if (!match?.[1]) return [];
  return match[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[A-Z_]+:/.test(line))
    .map(line => line.split(':')[0]);
}

export function extractRecordValues(content: string, varName: string): string[] {
  const safeVarName = escapeRegExp(varName);
  const pattern = new RegExp(String.raw`${safeVarName}[^=]*=\s*\{([\s\S]*?)\};`);
  const match = pattern.exec(content);
  if (!match?.[1]) return [];

  return [...new Set([...match[1].matchAll(/:\s*'([A-Z_]+)'/g)].map(m => m[1]))];
}

export function collectCredentialTypeDrift(params: {
  canonicalTypes: string[];
  locations: TypeLocation[];
}): DriftViolation[] {
  const canonicalSet = new Set(params.canonicalTypes);

  return params.locations.flatMap(loc => {
    const locSet = new Set(loc.types);
    const missing = params.canonicalTypes.filter(t => !locSet.has(t));
    const extra = loc.types.filter(t => !canonicalSet.has(t));

    if (missing.length === 0 && extra.length === 0) return [];
    return [{ file: loc.file, description: loc.description, missing, extra }];
  });
}

export function checkCredentialTypeDrift(): number {
  let failures = 0;

  const canonicalContent = readFileSync(resolve(ROOT, CANONICAL.file), 'utf-8');
  const canonicalTypes = extractTypes(canonicalContent, CANONICAL.pattern);

  if (canonicalTypes.length === 0) {
    console.error(`ERROR: Could not extract types from ${CANONICAL.file}`);
    return 1;
  }

  const canonicalSet = new Set(canonicalTypes);
  console.log(`Canonical source: ${canonicalTypes.length} types in ${CANONICAL.file}`);

  const arrayLocations = LOCATIONS.map(loc => {
    const content = readFileSync(resolve(ROOT, loc.file), 'utf-8');
    const types = extractTypes(content, loc.pattern);
    return { ...loc, types };
  });

  for (const drift of collectCredentialTypeDrift({ canonicalTypes, locations: arrayLocations })) {
    failures++;
    console.error(`\nDRIFT in ${drift.description} (${drift.file}):`);
    if (drift.missing.length > 0) console.error(`  Missing: ${drift.missing.join(', ')}`);
    if (drift.extra.length > 0) console.error(`  Extra:   ${drift.extra.join(', ')}`);
  }

  for (const loc of arrayLocations) {
    if (loc.types.length === 0) {
      failures++;
      console.error(`\nFAIL: Could not extract credential types from ${loc.description} (${loc.file}) — treating as drift (fail-closed).`);
    } else if (!collectCredentialTypeDrift({ canonicalTypes, locations: [loc] }).length) {
      console.log(`  OK: ${loc.description} (${loc.types.length} types)`);
    }
  }

  const dialogFile = 'src/components/anchor/SecureDocumentDialog.tsx';
  const dialogContent = readFileSync(resolve(ROOT, dialogFile), 'utf-8');
  const dialogTypes = extractRecordValues(dialogContent, 'typeMap');
  if (dialogTypes.length === 0) {
    failures++;
    console.error(`\nFAIL: Could not extract SecureDocumentDialog typeMap values from ${dialogFile} — treating as drift (fail-closed).`);
  } else {
    const dialogViolations = collectCredentialTypeDrift({
      canonicalTypes,
      locations: [{
        file: dialogFile,
        description: 'SecureDocumentDialog fuzzy type map',
        types: dialogTypes,
      }],
    });
    if (dialogViolations.length > 0) {
      failures++;
      const [drift] = dialogViolations;
      console.error(`\nDRIFT in ${drift.description} (${drift.file}):`);
      if (drift.missing.length > 0) console.error(`  Missing: ${drift.missing.join(', ')}`);
      if (drift.extra.length > 0) console.error(`  Extra:   ${drift.extra.join(', ')}`);
    } else {
      console.log(`  OK: SecureDocumentDialog fuzzy type map (${dialogTypes.length} canonical target types)`);
    }
  }

  // Check embed CREDENTIAL_LABELS record keys
  const embedFile = 'packages/embed/src/render.ts';
  const embedContent = readFileSync(resolve(ROOT, embedFile), 'utf-8');
  const embedKeys = extractRecordKeys(embedContent, 'CREDENTIAL_LABELS');

  if (embedKeys.length === 0) {
    failures++;
    console.error(`\nFAIL: Could not extract CREDENTIAL_LABELS keys from ${embedFile} — treating as drift (fail-closed).`);
  } else {
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
    return 1;
  }

  console.log('\nAll credential type locations are in sync.');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(checkCredentialTypeDrift());
}
