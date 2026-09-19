/**
 * SCRUM-5023 — structural conformance of the published spec to OpenAPI 3.0.3.
 *
 * WHY THIS EXISTS. `docs.ts` declares `openapi: '3.0.3'` and is served to
 * partners at `/api/v1/docs`, but nothing in CI ever checked that its schema
 * objects are legal 3.0. They are not the same dialect as 3.1: 3.0 predates
 * JSON Schema's type union and has exactly six types, so the 3.1 spellings a
 * developer reaches for by habit — `type: 'null'`, `type: ['string','null']`,
 * `examples`, `const` — are silently invalid. `swagger-ui` renders most of
 * them anyway, so the first report comes from a partner's code generator.
 *
 * SCRUM-5023 shipped exactly that: `expires_at: { type: 'null' }` on the PATCH
 * request body. This walk is the ratchet that keeps the next one out.
 *
 * It is structural, not a full validator: no dependency, no network, and it
 * fails on a NAMED list of 3.1-isms rather than trying to be authoritative.
 */
import { describe, it, expect } from 'vitest';
import { openApiSpec } from './docs.js';

/** The complete set of `type` values OpenAPI 3.0.3 allows. */
const OPENAPI_30_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

/** Keywords that are JSON-Schema-2020-12 / OpenAPI 3.1 only. */
const OPENAPI_31_ONLY_KEYWORDS = ['const', 'examples', 'prefixItems', '$defs'] as const;

interface Violation {
  path: string;
  problem: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk every schema-shaped node. A node counts as a schema when it carries a
 * `type` or one of the 3.1-only keywords — deliberately loose, because the
 * point is to catch the spelling wherever it appears, not to model the
 * document's grammar.
 */
function findViolations(node: unknown, path: string, out: Violation[]): void {
  // `type` on a Security Scheme Object ('http', 'apiKey', 'oauth2', …) is a
  // different keyword that happens to share a name. Not a schema, not ours.
  if (path.startsWith('$.components.securitySchemes.')) return;

  if (Array.isArray(node)) {
    node.forEach((child, i) => findViolations(child, `${path}[${i}]`, out));
    return;
  }
  if (!isPlainObject(node)) return;

  if ('type' in node) {
    const type = node.type;
    if (Array.isArray(type)) {
      out.push({ path: `${path}.type`, problem: `type arrays are OpenAPI 3.1 only (got ${JSON.stringify(type)}); use a single type plus nullable: true` });
    } else if (typeof type === 'string' && !OPENAPI_30_TYPES.includes(type)) {
      out.push({ path: `${path}.type`, problem: `'${type}' is not an OpenAPI 3.0 type; use one of ${OPENAPI_30_TYPES.join('/')} plus nullable: true` });
    }
  }

  for (const keyword of OPENAPI_31_ONLY_KEYWORDS) {
    // `examples` is legal on a MEDIA TYPE object in 3.0; it is only illegal
    // inside a schema, which is where a `type` sits beside it.
    if (keyword === 'examples' && !('type' in node)) continue;
    if (keyword in node) {
      out.push({ path: `${path}.${keyword}`, problem: `'${keyword}' is OpenAPI 3.1 / JSON Schema 2020-12 only` });
    }
  }

  for (const [key, child] of Object.entries(node)) {
    findViolations(child, `${path}.${key}`, out);
  }
}

describe('openApiSpec conforms structurally to the version it declares', () => {
  it('declares 3.0.3', () => {
    expect(openApiSpec.openapi).toBe('3.0.3');
  });

  it('uses no OpenAPI 3.1-only schema syntax anywhere', () => {
    const violations: Violation[] = [];
    findViolations(openApiSpec, '$', violations);

    expect(
      violations.map((v) => `${v.path}: ${v.problem}`),
    ).toEqual([]);
  });

  it('expresses the nullable PATCH expiry field the 3.0 way', () => {
    const body = openApiSpec.paths['/keys/{keyId}'].patch.requestBody.content['application/json'].schema
      .properties.expires_in_days;

    expect(body.type).toBe('integer');
    expect(body.nullable).toBe(true);
  });

  it('does not mistake a Security Scheme Object type for a schema type', () => {
    // `securitySchemes` legitimately carries type: 'http' / 'apiKey'.
    const violations: Violation[] = [];
    findViolations(openApiSpec.components.securitySchemes, '$.components.securitySchemes', violations);
    expect(violations).toEqual([]);
  });

  it('walks deeply enough to reach a nested schema', () => {
    // Guards the walk itself: a traversal that stopped at the top level would
    // pass the assertion above while checking nothing.
    const violations: Violation[] = [];
    findViolations(
      { paths: { '/x': { get: { responses: { '200': { schema: { type: 'null' } } } } } } },
      '$',
      violations,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].path).toBe('$.paths./x.get.responses.200.schema.type');
  });
});
