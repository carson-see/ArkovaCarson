/**
 * The SERVED `SubOrganization` schema and the PUBLISHED one must not disagree
 * (SCRUM-3971, review U8).
 *
 * There are two OpenAPI documents for the same v1 surface: the TypeScript
 * object in `docs.ts`, served live at `GET /api/docs/spec.json` and linked from
 * every v1 response, and `docs/api/openapi.yaml`, the file handed to
 * integrators. Nothing compared their component schemas, and they had already
 * drifted twice on the SAME object:
 *
 *   - `verification_status` carried the PRE-0407 three-value enum in `docs.ts`
 *     (`UNVERIFIED`/`PENDING`/`VERIFIED`) while
 *     `organizations_verification_status_valid` has admitted `REJECTED` and
 *     `REQUIRES_INPUT` since migration 0407. A partner generating a client from
 *     the served spec would have rejected a value the database stores.
 *   - The YAML carried NO enum at all and no `docusign_inherited` description,
 *     so the two documents described different objects under one name.
 *
 * §1.8 freezes this shape on publication, which means a drift caught after
 * publication is not fixable by narrowing — it can only be documented. So it
 * gets caught here instead.
 *
 * The YAML is read with a narrow, asserted parser rather than a new dependency
 * (`js-yaml` is not a `services/worker` dependency), matching
 * `openapi-proof-bundle-contract.test.ts`. Every extraction is checked for
 * non-emptiness so a parse that silently finds nothing cannot pass as
 * agreement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openApiSpec } from './docs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// services/worker/src/api/v1 -> repo root
const OPENAPI_PATH = resolve(HERE, '../../../../../docs/api/openapi.yaml');

/** The `    SubOrganization:` block, up to the next schema at the same indent. */
function subOrganizationBlock(): string {
  if (!existsSync(OPENAPI_PATH)) throw new Error(`openapi.yaml not found at ${OPENAPI_PATH}`);
  const src = readFileSync(OPENAPI_PATH, 'utf8');
  const start = src.indexOf('\n    SubOrganization:\n');
  if (start === -1) throw new Error(`SubOrganization schema not found in ${OPENAPI_PATH}`);
  const rest = src.slice(start + 1);
  const sibling = /\n {4}[A-Za-z][A-Za-z0-9_]*:\n/.exec(rest.slice(1));
  return sibling ? rest.slice(0, sibling.index + 1) : rest;
}

/** Property names: the eight-space keys under `      properties:`. */
function publishedProperties(block: string): string[] {
  const at = block.indexOf('\n      properties:\n');
  if (at === -1) throw new Error('SubOrganization has no properties block');
  const body = block.slice(at + '\n      properties:\n'.length);
  const names: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = /^ {8}([A-Za-z][A-Za-z0-9_]*):\s*$/.exec(line);
    if (m) { names.push(m[1]); continue; }
    // A key at six spaces or shallower ends the properties map.
    if (/^ {0,6}\S/.test(line)) break;
  }
  return names;
}

/** `required: [a, b, c]` — the flow-sequence form this file uses. */
function publishedRequired(block: string): string[] {
  const m = /\n {6}required: \[([^\]]+)\]/.exec(block);
  if (!m) throw new Error('SubOrganization has no inline required list');
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** `enum: [A, B, null]` under a named property. */
function publishedEnum(block: string, property: string): string[] {
  const at = block.indexOf(`\n        ${property}:\n`);
  if (at === -1) throw new Error(`property ${property} not found in the published schema`);
  const m = /\n {10}enum: \[([^\]]+)\]/.exec(block.slice(at));
  if (!m) throw new Error(`property ${property} publishes no enum`);
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

interface ServedSchema {
  required?: string[];
  properties?: Record<string, { enum?: (string | null)[]; description?: string }>;
}

function served(): ServedSchema {
  const schema = (openApiSpec.components as { schemas?: Record<string, ServedSchema> })
    ?.schemas?.SubOrganization;
  if (!schema) throw new Error('openApiSpec has no components.schemas.SubOrganization');
  return schema;
}

/** `enum: ['A', null]` in TS -> the tokens the YAML flow sequence writes. */
function asYamlTokens(values: (string | null)[]): string[] {
  return values.map((v) => (v === null ? 'null' : String(v)));
}

describe('SubOrganization — served spec vs published openapi.yaml (U8)', () => {
  const block = subOrganizationBlock();

  it('extracts a non-empty published schema (a silent parse miss must not pass)', () => {
    expect(block.length).toBeGreaterThan(100);
    expect(publishedProperties(block).length).toBeGreaterThan(0);
    expect(publishedRequired(block).length).toBeGreaterThan(0);
  });

  it('declares the same property set in both documents', () => {
    const yaml = publishedProperties(block).sort();
    const ts = Object.keys(served().properties ?? {}).sort();
    expect(ts.length).toBeGreaterThan(0);
    expect(yaml).toEqual(ts);
  });

  it('declares the same required list in both documents', () => {
    expect(publishedRequired(block).sort()).toEqual([...(served().required ?? [])].sort());
  });

  it.each(['verification_status', 'parent_approval_status'])(
    'publishes the same %s enum in both documents',
    (property) => {
      const tsEnum = served().properties?.[property]?.enum;
      expect(tsEnum, `${property} has no enum in docs.ts`).toBeDefined();
      expect(publishedEnum(block, property)).toEqual(asYamlTokens(tsEnum ?? []));
    },
  );

  it('publishes verification_status as the post-0407 CHECK list, not the baseline three', () => {
    // migration 0407 widened organizations_verification_status_valid. The enum
    // is the contract's copy of that constraint; if 0407's list ever widens
    // again this fails here rather than in a partner's generated client.
    expect(served().properties?.verification_status?.enum).toEqual(
      ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'REQUIRES_INPUT', null],
    );
  });
});
