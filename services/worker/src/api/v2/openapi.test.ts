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

  it('documents implemented resource search aliases', () => {
    expect(openApiV2Spec.paths['/organizations'].get.operationId).toBe('search_organizations');
    expect(openApiV2Spec.paths['/records'].get.operationId).toBe('search_records');
    expect(openApiV2Spec.paths['/fingerprints'].get.operationId).toBe('search_fingerprints');
    expect(openApiV2Spec.paths['/documents'].get.operationId).toBe('search_documents');
  });

  it('does not publish internal id fields in v2 public schemas', () => {
    const searchResult = openApiV2Spec.components.schemas.SearchResult;
    const org = openApiV2Spec.components.schemas.Org;

    expect(searchResult.required).not.toContain('id');
    expect(searchResult.properties).not.toHaveProperty('id');
    expect(org.required).not.toContain('id');
    expect(org.properties).not.toHaveProperty('id');
  });

  it('documents all v2 error responses as application/problem+json', () => {
    const responses = openApiV2Spec.components.responses;
    for (const key of ['ValidationError', 'AuthenticationRequired', 'InvalidScope', 'NotFound', 'RateLimited', 'InternalError'] as const) {
      expect(responses[key].content).toHaveProperty('application/problem+json');
    }
  });
});
