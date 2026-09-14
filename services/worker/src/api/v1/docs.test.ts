/**
 * Tests for OpenAPI Documentation (P4.5-TS-04)
 */

import { describe, it, expect } from 'vitest';
import { openApiSpec } from './docs.js';
import { API_KEY_SCOPES } from '../apiScopes.js';
import { CONNECTOR_FETCH_SOURCE_MARKERS } from '../../constants/connectorFingerprint.js';

describe('OpenAPI spec', () => {
  it('has valid OpenAPI version', () => {
    expect(openApiSpec.openapi).toBe('3.0.3');
  });

  it('defines all required paths', () => {
    const paths = Object.keys(openApiSpec.paths);
    expect(paths).toContain('/verify/{publicId}');
    expect(paths).toContain('/verify/batch');
    expect(paths).toContain('/jobs/{jobId}');
    expect(paths).toContain('/usage');
    expect(paths).toContain('/keys');
    expect(paths).toContain('/keys/{keyId}');
  });

  it('defines VerificationResult schema matching frozen format', () => {
    const schema = openApiSpec.components.schemas.VerificationResult;
    expect(schema).toBeDefined();
    expect(schema.properties.verified).toBeDefined();
    expect(schema.properties.status).toBeDefined();
    expect(schema.properties.issuer_name).toBeDefined();
    expect(schema.properties.credential_type).toBeDefined();
    expect(schema.properties.anchor_timestamp).toBeDefined();
    expect(schema.properties.bitcoin_block).toBeDefined();
    expect(schema.properties.network_receipt_id).toBeDefined();
    expect(schema.properties.record_uri).toBeDefined();
    expect(schema.properties.jurisdiction).toBeDefined();
  });

  it('defines all security schemes', () => {
    const schemes = openApiSpec.components.securitySchemes;
    expect(schemes.ApiKeyBearer).toBeDefined();
    expect(schemes.ApiKeyHeader).toBeDefined();
    expect(schemes.SupabaseJWT).toBeDefined();
  });

  it('defines all error response types', () => {
    const responses = openApiSpec.components.responses;
    expect(responses.BadRequest).toBeDefined();
    expect(responses.Unauthorized).toBeDefined();
    expect(responses.Forbidden).toBeDefined();
    expect(responses.NotFound).toBeDefined();
    expect(responses.RateLimited).toBeDefined();
    expect(responses.ServiceUnavailable).toBeDefined();
  });

  it('verify endpoint allows anonymous access', () => {
    const verifyPath = openApiSpec.paths['/verify/{publicId}'];
    const security = verifyPath.get.security;
    // Should include an empty object for anonymous access
    expect(security).toContainEqual({});
  });

  it('documents the public CTDL credential endpoint without internal identifiers', () => {
    const ctdlPath = openApiSpec.paths['/credentials/{publicId}/ctdl'];
    expect(ctdlPath).toBeDefined();
    expect(ctdlPath.get.security).toContainEqual({});
    expect(ctdlPath.get.responses['200'].content['application/ld+json'].schema).toEqual({
      $ref: '#/components/schemas/CtdlCredential',
    });
    expect(ctdlPath.get.responses['410'].content['application/ld+json'].schema).toEqual({
      $ref: '#/components/schemas/CtdlCredential',
    });

    const schema = openApiSpec.components.schemas.CtdlCredential;
    expect(schema.required).toEqual(expect.arrayContaining([
      '@context',
      '@type',
      'ceterms:name',
      'ceterms:offeredBy',
      'ceterms:credentialStatusType',
      'ceterms:dateEffective',
      'ceterms:verificationServiceProfile',
      'ceterms:identifier',
    ]));
    expect(schema.required).not.toContain('ceterms:ctid');
    expect(schema.properties['ceterms:identifier'].required).toEqual([
      'ceterms:identifierType',
      'ceterms:identifierValue',
    ]);
    expect(JSON.stringify(schema)).not.toContain('org_id');
    expect(JSON.stringify(schema)).not.toContain('user_id');
    expect(JSON.stringify(schema)).not.toContain('fingerprint');
    expect(JSON.stringify(schema)).not.toContain('recipient_email');
  });

  it('batch endpoint requires API key', () => {
    const batchPath = openApiSpec.paths['/verify/batch'];
    const security = batchPath.post.security;
    // Should NOT include empty object (no anonymous access)
    expect(security).not.toContainEqual({});
  });

  it('keys endpoints require Supabase JWT', () => {
    const keysPath = openApiSpec.paths['/keys'];
    expect(keysPath.get.security).toContainEqual({ SupabaseJWT: [] });
    expect(keysPath.post.security).toContainEqual({ SupabaseJWT: [] });
  });

  it('documents public attestation detail includes without internal IDs', () => {
    const attestationPath = openApiSpec.paths['/attestations/{publicId}'];
    expect(attestationPath).toBeDefined();
    expect(openApiSpec.paths['/attestations/{attestationId}']).toBeUndefined();

    const parameters = attestationPath.get.parameters;
    expect(parameters).toContainEqual(expect.objectContaining({ name: 'publicId', in: 'path' }));
    expect(parameters).toContainEqual(expect.objectContaining({ name: 'include', in: 'query' }));

    const schema = openApiSpec.components.schemas.Attestation;
    expect(schema.properties.id).toBeUndefined();
    expect(schema.properties.evidence).toBeDefined();
    expect(schema.properties.attestor_credentials).toBeDefined();
  });

  it('documents attestation create evidence metadata and public alias response', () => {
    const createPath = openApiSpec.paths['/attestations'];
    const requestSchema = createPath.post.requestBody.content['application/json'].schema;
    expect(requestSchema.properties.evidence).toBeDefined();

    const responseSchema = openApiSpec.components.schemas.CreateAttestationResponse;
    expect(responseSchema.properties.attestation_id.format).toBeUndefined();
    expect(responseSchema.properties.attestation_id.description).toContain('public_id');
    expect(responseSchema.properties.evidence_count).toBeDefined();

    const metadataSchema = openApiSpec.components.schemas.AttestationMetadataInput;
    expect(requestSchema.properties.metadata).toEqual({ $ref: '#/components/schemas/AttestationMetadataInput' });
    expect(metadataSchema.additionalProperties).toBe(false);

    const evidenceInputSchema = openApiSpec.components.schemas.AttestationEvidenceInput;
    expect(evidenceInputSchema.additionalProperties).toBe(false);
    expect(evidenceInputSchema.properties.description.maxLength).toBe(500);

    const evidenceSchema = openApiSpec.components.schemas.AttestationEvidence;
    expect(evidenceSchema.properties.id.description).toContain('public_id');
    expect(evidenceSchema.properties.id.description).toContain('never an internal UUID');
  });

  it('publishes canonical API key scope metadata without narrowing v1 string arrays', () => {
    const keysPath = openApiSpec.paths['/keys'];
    const createScopes = keysPath.post.requestBody.content['application/json'].schema.properties.scopes;
    const updateScopes = openApiSpec.paths['/keys/{keyId}'].patch
      .requestBody.content['application/json'].schema.properties.scopes;
    const maskedScopes = openApiSpec.components.schemas.ApiKeyMasked.properties.scopes;
    const createdScopes = openApiSpec.components.schemas.ApiKeyCreated.properties.scopes;

    expect(createScopes.items).toEqual({ type: 'string' });
    expect(updateScopes.items).toEqual({ type: 'string' });
    expect(maskedScopes.items).toEqual({ type: 'string' });
    expect(createdScopes.items).toEqual({ type: 'string' });
    expect(createScopes.items.enum).toBeUndefined();
    expect(updateScopes.items.enum).toBeUndefined();
    expect(maskedScopes.items.enum).toBeUndefined();
    expect(createdScopes.items.enum).toBeUndefined();
    expect(createScopes['x-arkova-canonical-scopes']).toEqual(API_KEY_SCOPES);
    expect(updateScopes['x-arkova-canonical-scopes']).toEqual(API_KEY_SCOPES);
    expect(maskedScopes['x-arkova-canonical-scopes']).toEqual(API_KEY_SCOPES);
    expect(createdScopes['x-arkova-canonical-scopes']).toEqual(API_KEY_SCOPES);
  });

  it('documents required scopes for anchor submit and usage endpoints', () => {
    expect(openApiSpec.paths['/anchor'].post['x-arkova-required-scopes']).toEqual([
      'anchor:write',
      'write:anchors',
    ]);
    expect(openApiSpec.paths['/anchor/submit'].post['x-arkova-alias-for']).toBe('/anchor');
    expect(openApiSpec.paths['/usage'].get['x-arkova-required-scopes']).toEqual(['usage:read']);
  });

  // SCRUM-3981 — the served spec is what a partner reads before minting a key
  // (docs/api/canonical-sources.md: docs.ts is canonical for v1, openapi.yaml
  // is demoted). Every /webhooks* operation now declares the scope it requires
  // and the 403 it answers without it.
  it('documents webhooks:manage and a 403 on every webhook-management operation', () => {
    // Deliberately NOT `startsWith('/webhooks')`: `/webhooks/self-service/*`
    // (dashboard JWT), `/webhooks/drive` (channel token) and `/webhooks/ats/*`
    // (HMAC) share that prefix, carry their own auth, and are mounted ahead of
    // the scope-gated management router. When `docs.routeParity.test.ts` widens
    // the served spec to them, this test must keep saying the truth about them
    // rather than pressure someone into declaring a scope that is not required.
    const MANAGEMENT_PREFIX = /^\/webhooks(\/(\{id\}|test|deliveries|dlq)(\/.*)?)?$/;
    const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
    const webhookPaths = Object.keys(openApiSpec.paths).filter((p) => MANAGEMENT_PREFIX.test(p));
    expect(webhookPaths.length).toBeGreaterThan(0);

    let operationCount = 0;
    for (const path of webhookPaths) {
      for (const [method, operation] of Object.entries(openApiSpec.paths[path])) {
        // Path items may also carry `parameters` / `summary` keys, which are
        // not operations and must not be counted toward the ten.
        if (!HTTP_METHODS.has(method)) continue;
        const op = operation as Record<string, unknown>;
        operationCount += 1;
        expect(op['x-arkova-required-scopes'], `${method.toUpperCase()} ${path}`).toEqual(['webhooks:manage']);
        const responses = op.responses as Record<string, { description?: string }>;
        expect(responses['403'], `${method.toUpperCase()} ${path} must document its 403`).toBeDefined();
        expect(responses['403'].description).toContain('insufficient_scope');
      }
    }
    // Matches the 10 routes webhooksRouter registers (webhooks-scope.test.ts
    // asserts the same count off the Express stack).
    expect(operationCount).toBe(10);
  });

  it('/anchor/submit requestBody mirrors /anchor requestBody', () => {
    const anchorBody = openApiSpec.paths['/anchor'].post.requestBody;
    const submitBody = openApiSpec.paths['/anchor/submit'].post.requestBody;
    expect(submitBody).toBeDefined();
    expect(submitBody).toEqual(anchorBody);
  });

  it('has all four tags', () => {
    const tagNames = openApiSpec.tags.map((t: { name: string }) => t.name);
    expect(tagNames).toContain('Verification');
    expect(tagNames).toContain('Jobs');
    expect(tagNames).toContain('Usage');
    expect(tagNames).toContain('Key Management');
  });
});

/**
 * OpenAPI 3.0.3 STRUCTURAL validity (PR #2841 review V10: the version string
 * was asserted, the document's conformance to it was not).
 *
 * 3.0.3 has no `type: 'null'` and no type ARRAYS — both are 3.1 (JSON Schema
 * 2020-12) spellings. A 3.1-ism in a document declaring 3.0.3 is served to
 * every SDK generator and linter that reads this spec, so it breaks consumers
 * silently rather than failing our own build.
 */
describe('OpenAPI 3.0.3 structural conformance', () => {
  function walk(node: unknown, path: string, visit: (n: Record<string, unknown>, p: string) => void): void {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`, visit));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    visit(obj, path);
    for (const [key, child] of Object.entries(obj)) walk(child, `${path}.${key}`, visit);
  }

  it('uses no 3.1-only type spellings anywhere in the document', () => {
    const offenders: string[] = [];
    walk(openApiSpec, '$', (node, path) => {
      if (!('type' in node)) return;
      const t = node.type;
      if (t === 'null') offenders.push(`${path}.type === 'null'`);
      if (Array.isArray(t)) offenders.push(`${path}.type is an array (${JSON.stringify(t)})`);
    });
    expect(offenders).toEqual([]);
  });

  it('expresses optional-null with `nullable: true` instead', () => {
    // Positive control: the spec really does use the 3.0 spelling somewhere,
    // so the assertion above is not vacuously green on a spec with no
    // nullable fields at all.
    let sawNullable = false;
    walk(openApiSpec, '$', (node) => {
      if (node.nullable === true) sawNullable = true;
    });
    expect(sawNullable).toBe(true);
  });
});

/**
 * SCRUM-4507 — the `source` object must be documented wherever
 * VerificationResult is, and documented as identifier-free.
 */
describe('SCRUM-4507 source.provider is documented on VerificationResult', () => {
  it('declares source as an object with a single closed-enum provider property', () => {
    const source = openApiSpec.components.schemas.VerificationResult.properties.source;
    expect(source).toBeDefined();
    expect(source.type).toBe('object');
    expect(Object.keys(source.properties)).toEqual(['provider']);
    expect(source.properties.provider.type).toBe('string');
    expect(Array.isArray(source.properties.provider.enum)).toBe(true);
    expect(source.properties.provider.enum.length).toBeGreaterThan(0);
  });

  it('documents no identifier or deep-link property on source', () => {
    const source = openApiSpec.components.schemas.VerificationResult.properties.source;
    for (const banned of ['file_id', 'folder_id', 'revision_id', 'shared_drive_id', 'url', 'link', 'deep_link']) {
      expect(source.properties).not.toHaveProperty(banned);
    }
  });

  it('documents exactly the runtime recognised-marker vocabulary', () => {
    // Closes the loop: verify.ts's VERIFICATION_SOURCE_PROVIDERS is asserted
    // against the same set in verify-source-provider.test.ts, and the
    // published YAML is asserted against THIS enum in
    // openapi-source-provider-contract.test.ts. All three therefore agree by
    // construction, not by anyone remembering to update a list.
    const served = openApiSpec.components.schemas.VerificationResult.properties.source
      .properties.provider.enum as string[];
    expect([...served].sort()).toEqual([...CONNECTOR_FETCH_SOURCE_MARKERS].sort());
  });

  it('states the field is additive and omitted when unknown', () => {
    const source = openApiSpec.components.schemas.VerificationResult.properties.source;
    expect(source.description).toMatch(/omitted/i);
  });
});
