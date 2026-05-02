import { describe, it, expect } from 'vitest';
import { openApiV2Spec } from './openapi.js';

describe('openApiV2Spec', () => {
  it('publishes an OpenAPI 3.1 agent spec with x-agent-usage annotations', () => {
    expect(openApiV2Spec.openapi).toBe('3.1.0');
    expect(openApiV2Spec.paths['/search'].get.operationId).toBe('search');
    expect(openApiV2Spec.paths['/search'].get['x-agent-usage'].tool_name).toBe('search');
    expect(openApiV2Spec.paths['/verify/{fingerprint}'].get.operationId).toBe('verify');
    expect(openApiV2Spec.paths['/anchors/{public_id}'].get.operationId).toBe('get_anchor');
    expect(openApiV2Spec.paths['/orgs'].get.operationId).toBe('list_orgs');
  });

  it('documents the implemented direct search aliases', () => {
    const aliases = [
      ['/organizations', 'search_organizations', '/search?type=org'],
      ['/records', 'search_records', '/search?type=record'],
      ['/fingerprints', 'search_fingerprints', '/search?type=fingerprint'],
      ['/documents', 'search_documents', '/search?type=document'],
    ] as const;

    for (const [path, operationId, aliasTarget] of aliases) {
      const operation = openApiV2Spec.paths[path].get;
      expect(operation.operationId).toBe(operationId);
      expect(operation['x-arkova-alias-for']).toBe(aliasTarget);
      expect(Object.prototype.hasOwnProperty.call(operation, 'x-agent-usage')).toBe(false);
    }
  });

  it('keeps the search response schema aligned with the public response shape', () => {
    const schema = openApiV2Spec.components.schemas.SearchResult;
    expect(schema.required).toEqual(['type', 'public_id', 'score', 'snippet']);
    expect(schema.properties).not.toHaveProperty('id');
  });

  it('documents all v2 error responses as application/problem+json', () => {
    const responses = openApiV2Spec.components.responses;
    for (const key of ['ValidationError', 'AuthenticationRequired', 'InvalidScope', 'NotFound', 'RateLimited', 'InternalError'] as const) {
      expect(responses[key].content).toHaveProperty('application/problem+json');
    }
  });
});
