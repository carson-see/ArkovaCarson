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

  it('publishes the canonical API key scope enum for key management', () => {
    const keysPath = openApiSpec.paths['/keys'];
    const createScopeEnum = keysPath.post.requestBody.content['application/json'].schema.properties.scopes.items.enum;
    const updateScopeEnum = openApiSpec.paths['/keys/{keyId}'].patch
      .requestBody.content['application/json'].schema.properties.scopes.items.enum;
    const maskedScopeEnum = openApiSpec.components.schemas.ApiKeyMasked.properties.scopes.items.enum;
    const createdScopeEnum = openApiSpec.components.schemas.ApiKeyCreated.properties.scopes.items.enum;

    expect(createScopeEnum).toEqual(API_KEY_SCOPES);
    expect(updateScopeEnum).toEqual(API_KEY_SCOPES);
    expect(maskedScopeEnum).toEqual(API_KEY_SCOPES);
    expect(createdScopeEnum).toEqual(API_KEY_SCOPES);
  });

  it('has all four tags', () => {
    const tagNames = openApiSpec.tags.map((t: { name: string }) => t.name);
    expect(tagNames).toContain('Verification');
    expect(tagNames).toContain('Jobs');
    expect(tagNames).toContain('Usage');
    expect(tagNames).toContain('Key Management');
  });
});
