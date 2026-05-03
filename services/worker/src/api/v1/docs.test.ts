/**
 * Tests for OpenAPI Documentation (P4.5-TS-04)
 */

import { describe, it, expect } from 'vitest';
import { openApiSpec } from './docs.js';
import { API_KEY_SCOPES } from '../apiScopes.js';

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

  it('has all four tags', () => {
    const tagNames = openApiSpec.tags.map((t: { name: string }) => t.name);
    expect(tagNames).toContain('Verification');
    expect(tagNames).toContain('Jobs');
    expect(tagNames).toContain('Usage');
    expect(tagNames).toContain('Key Management');
  });
});
