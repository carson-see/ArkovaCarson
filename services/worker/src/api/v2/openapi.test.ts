import { describe, it, expect } from 'vitest';
import { openApiV2Spec } from './openapi.js';
import { PUBLIC_ORG_ID_RE } from './resourceIdentifiers.js';

describe('openApiV2Spec', () => {
  it('publishes an OpenAPI 3.1 agent spec with x-agent-usage annotations', () => {
    expect(openApiV2Spec.openapi).toBe('3.1.0');
    expect(openApiV2Spec.paths['/search'].get.operationId).toBe('search');
    expect(openApiV2Spec.paths['/search'].get['x-agent-usage'].tool_name).toBe('search');
    expect(openApiV2Spec.paths['/verify/{fingerprint}'].get.operationId).toBe('verify');
    expect(openApiV2Spec.paths['/anchors/{public_id}'].get.operationId).toBe('get_anchor');
    expect(openApiV2Spec.paths['/orgs'].get.operationId).toBe('list_orgs');
    expect(openApiV2Spec.paths['/organizations/{public_id}'].get.operationId).toBe('get_organization');
    expect(openApiV2Spec.paths['/records/{public_id}'].get.operationId).toBe('get_record');
    expect(openApiV2Spec.paths['/fingerprints/{fingerprint}'].get.operationId).toBe('get_fingerprint');
    expect(openApiV2Spec.paths['/documents/{public_id}'].get.operationId).toBe('get_document');
  });

  it('documents detail endpoint scopes and public-id-only schemas', () => {
    expect(openApiV2Spec.paths['/organizations/{public_id}'].get['x-agent-usage'].auth).toContain('read:orgs');
    expect(openApiV2Spec.paths['/organizations/{public_id}'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: expect.objectContaining({ pattern: PUBLIC_ORG_ID_RE.source }),
        }),
      ]),
    );
    expect(openApiV2Spec.paths['/records/{public_id}'].get['x-agent-usage'].auth).toContain('read:records');
    expect(openApiV2Spec.paths['/fingerprints/{fingerprint}'].get['x-agent-usage'].auth).toContain('read:records');
    expect(openApiV2Spec.paths['/documents/{public_id}'].get['x-agent-usage'].auth).toContain('read:records');
    expect(openApiV2Spec.components.schemas.OrganizationDetail.properties).not.toHaveProperty('id');
    expect(openApiV2Spec.components.schemas.ResourceDetail.properties).not.toHaveProperty('id');
    expect(openApiV2Spec.components.schemas.ResourceDetail.properties).not.toHaveProperty('org_id');
    expect(openApiV2Spec.components.schemas.ResourceDetail.properties).not.toHaveProperty('user_id');
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
      expect(Object.hasOwn(operation, 'x-agent-usage')).toBe(false);
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
