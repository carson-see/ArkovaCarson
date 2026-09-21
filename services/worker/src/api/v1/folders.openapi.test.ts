import { describe, expect, it } from 'vitest';
import { openApiSpec } from './docs.js';

describe('SCRUM-5142 folder OpenAPI parity', () => {
  it('publishes every folder management route and partial bulk response', () => {
    const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
    expect(paths['/folders']).toEqual(expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }));
    expect(paths['/folders/{folderId}']).toEqual(expect.objectContaining({ patch: expect.any(Object), delete: expect.any(Object) }));
    expect(paths['/folders/{folderId}/connector']).toEqual(expect.objectContaining({ put: expect.any(Object) }));
    expect(paths['/folders/bulk-move']).toEqual(expect.objectContaining({ post: expect.any(Object) }));
    expect((paths['/folders/bulk-move'].post as { responses: Record<string, unknown> }).responses).toHaveProperty('207');
  });

  it('keeps folder read/write scope declarations and connector binding schema explicit', () => {
    type Operation = { 'x-arkova-required-scopes': string[]; requestBody?: {
      content: { 'application/json': { schema: { required: string[] } } };
    } };
    const paths = openApiSpec.paths as Record<string, Record<string, Operation>>;
    expect(paths['/folders'].get['x-arkova-required-scopes']).toEqual(['anchor:read']);
    expect(paths['/folders'].post['x-arkova-required-scopes']).toEqual(['anchor:write']);
    expect(paths['/folders/{folderId}/connector'].put.requestBody!.content['application/json'].schema.required)
      .toEqual(['provider', 'source_id', 'connection_id']);
    expect(openApiSpec.components.schemas).toHaveProperty('Folder');
    expect(openApiSpec.components.schemas).toHaveProperty('FolderMoveResult');
  });
});
