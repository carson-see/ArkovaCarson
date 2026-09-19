import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiSpec } from './docs.js';

const PUBLISHED_OPENAPI = resolve(
  dirname(fileURLToPath(import.meta.url)), '../../../../../docs/api/openapi.yaml',
);

describe('SCRUM-5142 folder OpenAPI parity', () => {
  it('publishes every folder management route and partial bulk response', () => {
    const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
    expect(paths['/folders']).toEqual(expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }));
    expect(paths['/folders/member-context']).toEqual(expect.objectContaining({ get: expect.any(Object) }));
    expect(paths['/folders/member-contexts']).toEqual(expect.objectContaining({ get: expect.any(Object) }));
    expect((paths['/folders/member-context'].get as { security: unknown }).security).toEqual([{ SupabaseJWT: [] }]);
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

  it('documents UUID and public-id outcomes for both bulk move inputs', () => {
    const result = openApiSpec.components.schemas.FolderMoveResult as {
      properties: { moved: { items: { oneOf: Array<Record<string, string>> } } };
    };
    expect(result.properties.moved.items.oneOf).toEqual([
      { type: 'string', format: 'uuid' }, { type: 'string', pattern: '^ARK-' },
    ]);
  });

  it('keeps the checked-in integration spec aligned with every folder route and response mode', () => {
    const yaml = readFileSync(PUBLISHED_OPENAPI, 'utf8');
    for (const route of ['/folders:', '/folders/member-context:', '/folders/member-contexts:', '/folders/{folderId}:',
      '/folders/{folderId}/connector:', '/folders/bulk-move:']) {
      expect(yaml).toContain(`  ${route}`);
    }
    expect(yaml).toContain('    FolderMoveResult:');
    expect(yaml).toContain('pattern: "^ARK-"');
    expect(yaml).toContain('"207":');
  });

  it('keeps the member drill-down behind the mounted JWT/API-key discriminator', () => {
    const router = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'router.ts'), 'utf8');
    const auth = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'folder-auth.ts'), 'utf8');
    expect(router).toContain("router.use('/folders', requireFolderAuth, foldersRouter)");
    expect(auth).toContain("bearer?.startsWith('Bearer ')");
    expect(auth).toContain("!bearer.startsWith('Bearer ak_')");
  });
});
