import { describe, it, expect } from 'vitest';
import { openApiV2Spec } from './openapi.js';

type JsonSchema = {
  $ref?: string;
  type?: string | readonly string[];
  required?: readonly string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
};

function schemaFor(name: keyof typeof openApiV2Spec.components.schemas): JsonSchema {
  return openApiV2Spec.components.schemas[name] as JsonSchema;
}

function resolveSchema(schema: JsonSchema): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace('#/components/schemas/', '') as keyof typeof openApiV2Spec.components.schemas;
  return schemaFor(name);
}

function typeList(schema: JsonSchema): string[] {
  if (!schema.type) return [];
  return typeof schema.type === 'string' ? [schema.type] : [...schema.type];
}

function expectObjectMatchesSchema(schema: JsonSchema, value: unknown, path: string): void {
  expect(typeof value, `${path} is object`).toBe('object');
  expect(Array.isArray(value), `${path} is not array`).toBe(false);
  const objectValue = value as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    expect(objectValue, `${path}.${key} is required`).toHaveProperty(key);
  }
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(objectValue, key)) {
      expectMatchesSchema(childSchema, objectValue[key], `${path}.${key}`);
    }
  }
  const knownProperties = schema.properties ?? {};
  const extraKeys = Object.keys(objectValue).filter((key) => !Object.hasOwn(knownProperties, key));
  if (schema.additionalProperties === false) {
    expect(extraKeys, `${path} has no unexpected properties`).toEqual([]);
    return;
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    const additionalSchema = resolveSchema(schema.additionalProperties);
    for (const key of extraKeys) {
      expectMatchesSchema(additionalSchema, objectValue[key], `${path}.${key}`);
    }
  }
}

function expectArrayMatchesSchema(schema: JsonSchema, value: unknown, path: string): void {
  expect(Array.isArray(value), `${path} is array`).toBe(true);
  const child = schema.items;
  if (!child) return;
  for (const [index, item] of (value as unknown[]).entries()) {
    expectMatchesSchema(child, item, `${path}[${index}]`);
  }
}

function expectPrimitiveMatchesSchema(allowedTypes: string[], value: unknown, path: string): void {
  if (allowedTypes.includes('integer')) {
    expect(Number.isInteger(value), `${path} is integer`).toBe(true);
    return;
  }
  if (allowedTypes.includes('number')) {
    expect(typeof value, `${path} is number`).toBe('number');
    return;
  }
  if (allowedTypes.includes('boolean')) {
    expect(typeof value, `${path} is boolean`).toBe('boolean');
    return;
  }
  if (allowedTypes.includes('string')) {
    expect(typeof value, `${path} is string`).toBe('string');
  }
}

function expectMatchesSchema(schema: JsonSchema, value: unknown, path = '$'): void {
  const resolved = resolveSchema(schema);
  const allowedTypes = typeList(resolved);

  if (value === null) {
    expect(allowedTypes, `${path} allows null`).toContain('null');
    return;
  }

  if (allowedTypes.includes('object')) {
    expectObjectMatchesSchema(resolved, value, path);
    return;
  }

  if (allowedTypes.includes('array')) {
    expectArrayMatchesSchema(resolved, value, path);
    return;
  }

  expectPrimitiveMatchesSchema(allowedTypes, value, path);
}

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

  it('documents SCRUM-1132 resource detail endpoints', () => {
    expect(openApiV2Spec.paths['/organizations/{public_id}'].get.operationId).toBe('get_organization');
    expect(openApiV2Spec.paths['/records/{public_id}'].get.operationId).toBe('get_record');
    expect(openApiV2Spec.paths['/fingerprints/{fingerprint}'].get.operationId).toBe('get_fingerprint');
    expect(openApiV2Spec.paths['/documents/{public_id}'].get.operationId).toBe('get_document');
    expect(openApiV2Spec.paths['/records/{public_id}'].get['x-agent-usage'].tool_name).toBe('get_record');
  });

  it('does not publish internal id fields in v2 public schemas', () => {
    const searchResult = openApiV2Spec.components.schemas.SearchResult;
    const org = openApiV2Spec.components.schemas.Org;
    const organizationDetail = openApiV2Spec.components.schemas.OrganizationDetail;
    const recordDetail = openApiV2Spec.components.schemas.RecordDetail;
    const documentDetail = openApiV2Spec.components.schemas.DocumentDetail;
    const fingerprintDetail = openApiV2Spec.components.schemas.FingerprintDetail;

    expect(searchResult.required).not.toContain('id');
    expect(searchResult.properties).not.toHaveProperty('id');
    expect(org.required).not.toContain('id');
    expect(org.properties).not.toHaveProperty('id');
    for (const schema of [organizationDetail, recordDetail, documentDetail, fingerprintDetail]) {
      expect(schema.required).not.toContain('id');
      expect(schema.properties).not.toHaveProperty('id');
      expect(schema.properties).not.toHaveProperty('org_id');
      expect(schema.properties).not.toHaveProperty('user_id');
    }
  });

  it('documents all v2 error responses as application/problem+json', () => {
    const responses = openApiV2Spec.components.responses;
    for (const key of ['ValidationError', 'AuthenticationRequired', 'InvalidScope', 'NotFound', 'RateLimited', 'InternalError'] as const) {
      expect(responses[key].content).toHaveProperty('application/problem+json');
    }
  });

  it('schemas accept representative route output envelopes', () => {
    expectMatchesSchema(schemaFor('SearchResponse'), {
      results: [{
        type: 'org',
        public_id: 'org_acme',
        score: 1,
        snippet: 'Acme Corp',
        metadata: { domain: 'acme.com' },
      }],
      next_cursor: null,
    });

    expectMatchesSchema(schemaFor('FingerprintVerification'), {
      verified: true,
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      public_id: 'ARK-DOC-ABC',
      title: 'Contract.pdf',
      anchor_timestamp: '2026-04-24T12:00:00Z',
      network_receipt_id: 'tx-1',
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
    });

    expectMatchesSchema(schemaFor('Anchor'), {
      public_id: 'ARK-DOC-ABC',
      verified: true,
      status: 'ACTIVE',
      issuer_name: 'Acme Corp',
      credential_type: 'LICENSE',
      issued_date: null,
      expiry_date: null,
      anchor_timestamp: '2026-04-24T12:00:00Z',
      network_receipt_id: 'tx-1',
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
    });

    expectMatchesSchema(schemaFor('OrgList'), {
      organizations: [{
        public_id: 'org_acme',
        display_name: 'Acme Corp',
        domain: 'acme.com',
        website_url: 'https://acme.com',
        verification_status: 'VERIFIED',
      }],
    });

    expectMatchesSchema(schemaFor('OrganizationDetail'), {
      public_id: 'org_acme',
      display_name: 'Acme Corp',
      description: 'Verified healthcare org',
      domain: 'acme.com',
      website_url: 'https://acme.com',
      verification_status: 'VERIFIED',
      industry_tag: 'healthcare',
      org_type: 'employer',
      location: 'Detroit, MI',
      logo_url: null,
    });

    expectMatchesSchema(schemaFor('RecordDetail'), {
      public_id: 'ARK-DOC-ABC',
      verified: true,
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      title: 'Contract.pdf',
      description: 'Signed agreement',
      issuer_name: 'Acme Corp',
      credential_type: 'LEGAL',
      sub_type: 'contract',
      issued_date: '2026-04-01',
      expiry_date: null,
      anchor_timestamp: '2026-04-24T12:00:00Z',
      network_receipt_id: 'tx-1',
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
      compliance_controls: { soc2: true },
      chain_confirmations: 6,
      parent_public_id: null,
      version_number: 2,
      revocation_tx_id: null,
      revocation_block_height: null,
    });

    expectMatchesSchema(schemaFor('FingerprintDetail'), {
      verified: true,
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      public_id: 'ARK-DOC-ABC',
      title: 'Contract.pdf',
      issuer_name: 'Acme Corp',
      credential_type: 'LEGAL',
      sub_type: 'contract',
      description: 'Signed agreement',
      issued_date: '2026-04-01',
      expiry_date: null,
      anchor_timestamp: '2026-04-24T12:00:00Z',
      network_receipt_id: 'tx-1',
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
      compliance_controls: null,
      chain_confirmations: null,
      parent_public_id: null,
      version_number: null,
      revocation_tx_id: null,
      revocation_block_height: null,
      file_mime: 'application/pdf',
      file_size: 12345,
    });

    expectMatchesSchema(schemaFor('DocumentDetail'), {
      public_id: 'ARK-DOC-ABC',
      verified: true,
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      title: 'Contract.pdf',
      description: 'Signed agreement',
      issuer_name: 'Acme Corp',
      credential_type: 'LEGAL',
      sub_type: 'contract',
      issued_date: '2026-04-01',
      expiry_date: null,
      anchor_timestamp: '2026-04-24T12:00:00Z',
      network_receipt_id: 'tx-1',
      record_uri: 'https://app.arkova.ai/verify/ARK-DOC-ABC',
      compliance_controls: null,
      chain_confirmations: null,
      parent_public_id: null,
      version_number: null,
      revocation_tx_id: null,
      revocation_block_height: null,
      file_mime: 'application/pdf',
      file_size: 12345,
    });
  });
});
