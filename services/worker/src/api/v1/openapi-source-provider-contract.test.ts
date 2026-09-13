/**
 * SCRUM-4507 — `source.provider` must exist identically on BOTH published
 * contract surfaces.
 *
 * `docs.ts` is the spec the running worker serves at `/api/v1/docs`;
 * `docs/api/openapi.yaml` is the spec integrators are handed out of band. The
 * proof-bundle drift that `openapi-proof-bundle-contract.test.ts` exists to
 * catch (0427 fields added to one, not the other) is the same failure mode a
 * new response field invites, so the parity is asserted at the moment the
 * field is introduced rather than after someone notices.
 *
 * The YAML is read with a narrow, asserted text extraction rather than a new
 * parser dependency — same approach, and same rule, as the proof-bundle test:
 * every extraction is checked for non-emptiness so a parse that silently finds
 * nothing cannot pass as agreement.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openApiSpec } from './docs.js';
import { CONNECTOR_FETCH_SOURCE_MARKERS_SORTED } from '../../constants/connectorFingerprint.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// services/worker/src/api/v1 -> repo root
const OPENAPI_PATH = resolve(HERE, '../../../../../docs/api/openapi.yaml');

/**
 * Pull the enum members of `VerificationResult.properties.source.properties.provider`
 * out of the YAML. Scoped by indentation: the `source:` property sits at 8
 * spaces inside `VerificationResult:` (4 spaces), and the block ends at the
 * next line indented 8 spaces or less that is not part of it.
 */
function readYamlSourceProviderEnum(yaml: string): string[] {
  const lines = yaml.split('\n');
  const vrIndex = lines.findIndex((l) => l === '    VerificationResult:');
  expect(vrIndex, 'VerificationResult schema not found in openapi.yaml').toBeGreaterThan(-1);

  // End of the VerificationResult block: the next sibling at 4-space indent.
  let vrEnd = lines.length;
  for (let i = vrIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^ {4}\S/.test(line)) { vrEnd = i; break; }
  }

  const block = lines.slice(vrIndex, vrEnd);
  const sourceIndex = block.findIndex((l) => l === '        source:');
  expect(sourceIndex, '`source:` property not found under VerificationResult').toBeGreaterThan(-1);

  let sourceEnd = block.length;
  for (let i = sourceIndex + 1; i < block.length; i += 1) {
    const line = block[i];
    if (line.trim() === '') continue;
    if (/^ {8}\S/.test(line)) { sourceEnd = i; break; }
  }

  const sourceBlock = block.slice(sourceIndex, sourceEnd).join('\n');
  const enumMatch = /enum:\s*\[([^\]]+)\]/.exec(sourceBlock);
  expect(enumMatch, 'no inline provider enum found in the source block').not.toBeNull();

  return enumMatch![1]
    .split(',')
    .map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
    .filter((v) => v.length > 0);
}

describe('source.provider parity between docs.ts and docs/api/openapi.yaml', () => {
  it('the published YAML exists and is non-empty', () => {
    expect(existsSync(OPENAPI_PATH)).toBe(true);
    expect(readFileSync(OPENAPI_PATH, 'utf8').length).toBeGreaterThan(1000);
  });

  it('both surfaces declare the SAME provider vocabulary', () => {
    const yaml = readFileSync(OPENAPI_PATH, 'utf8');
    const yamlEnum = readYamlSourceProviderEnum(yaml);
    const servedEnum = openApiSpec.components.schemas.VerificationResult.properties.source
      .properties.provider.enum as string[];

    expect(yamlEnum.length).toBeGreaterThan(0);
    expect([...yamlEnum].sort()).toEqual([...servedEnum].sort());
  });

  /**
   * The served spec object is built ONCE at module scope and handed out to
   * every `/api/v1/docs` request, so the enum array it holds is long-lived
   * shared state. Frozen rather than merely `readonly`-typed: `readonly` is
   * erased at runtime and says nothing to a JS caller, and a single stray
   * `push`/`sort` anywhere in the process would silently change the published
   * contract for every later reader of a FROZEN v1 schema (§1.8). Pinned here
   * because the same array now backs both published surfaces.
   */
  it('the served provider enum is the shared vocabulary, frozen and deterministically ordered', () => {
    const servedEnum = openApiSpec.components.schemas.VerificationResult.properties.source
      .properties.provider.enum as string[];

    expect(servedEnum).toEqual([...CONNECTOR_FETCH_SOURCE_MARKERS_SORTED]);
    expect(Object.isFrozen(CONNECTOR_FETCH_SOURCE_MARKERS_SORTED)).toBe(true);
    // Explicit, not "whatever .sort() did": the order is part of the published
    // contract, so it is written down where a diff will show a change to it.
    expect(servedEnum).toEqual(['connector', 'docusign', 'google_drive', 'microsoft_365']);
  });

  it('the YAML source block documents no identifier or deep link', () => {
    const yaml = readFileSync(OPENAPI_PATH, 'utf8');
    const lines = yaml.split('\n');
    const vrIndex = lines.findIndex((l) => l === '    VerificationResult:');
    const sourceIndex = lines.findIndex((l, i) => i > vrIndex && l === '        source:');
    expect(sourceIndex).toBeGreaterThan(-1);

    let sourceEnd = lines.length;
    for (let i = sourceIndex + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      if (/^ {1,8}\S/.test(lines[i])) { sourceEnd = i; break; }
    }
    const sourceBlock = lines.slice(sourceIndex, sourceEnd).join('\n');

    for (const banned of ['file_id:', 'folder_id:', 'revision_id:', 'shared_drive_id:', 'deep_link:']) {
      expect(sourceBlock).not.toContain(banned);
    }
  });
});
