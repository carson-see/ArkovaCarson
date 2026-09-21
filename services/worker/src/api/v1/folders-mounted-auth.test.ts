import express, { type Request } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'uat24-mounted-folder-auth-secret';
vi.mock('../../config.js', () => ({ config: { supabaseJwtSecret: 'uat24-mounted-folder-auth-secret', environment: 'test' } }));
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('../../utils/db.js', () => ({ db: {} }));
vi.mock('../../webhooks/delivery.js', () => ({ dispatchWebhookEvent: vi.fn() }));

import { requireFolderAuth } from './folder-auth.js';
import { createFoldersRouter, type FolderApiDeps } from './folders.js';

const USER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

async function token(aal: 'aal1' | 'aal2', expiresIn: string | number = '1h') {
  return new SignJWT({ sub: USER, role: 'authenticated', aal })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function deps(): FolderApiDeps {
  const member = { id: MEMBER, email: 'member@example.com', full_name: null, avatar_url: null,
    role: 'INDIVIDUAL' as const, created_at: '2026-01-01T00:00:00Z', org_id: ORG, membership_role: 'member' as const };
  return {
    listFolders: vi.fn().mockResolvedValue([]), createFolder: vi.fn(), updateFolder: vi.fn(), deleteFolder: vi.fn(), bulkMove: vi.fn(),
    canReadOrg: vi.fn().mockResolvedValue(true), canAdminOrg: vi.fn().mockResolvedValue(true), canAdminOrgExact: vi.fn().mockResolvedValue(true),
    isPlatformAdmin: vi.fn().mockResolvedValue(false), canUsePersonalContext: vi.fn().mockResolvedValue(true),
    getMemberContext: vi.fn().mockResolvedValue(member), listMemberContexts: vi.fn().mockResolvedValue([member]), emitFolderEvent: vi.fn(),
  };
}

function app(apiKey = false) {
  const server = express();
  server.use((req, _res, next) => {
    if (apiKey) (req as Request & { apiKey: object }).apiKey = { keyId: 'key', orgId: ORG, userId: USER, scopes: ['anchor:read'], rateLimitTier: 'free', keyPrefix: 'ak_test' };
    next();
  });
  server.use('/api/v1/folders', requireFolderAuth, createFoldersRouter(deps()));
  return server;
}

describe('mounted folder member authentication', () => {
  for (const endpoint of [
    `/api/v1/folders/member-context?owner_user_id=${MEMBER}&context_org_id=${ORG}`,
    `/api/v1/folders/member-contexts?context_org_id=${ORG}`,
  ]) {
    it(`requires an AAL2 JWT for ${endpoint.split('?')[0]}`, async () => {
      expect((await request(app()).get(endpoint)).status).toBe(401);
      expect((await request(app()).get(endpoint).set('Authorization', `Bearer ${await token('aal1')}`)).status).toBe(401);
      expect((await request(app()).get(endpoint).set('Authorization', `Bearer ${await token('aal2')}`)).status).toBe(200);
      expect((await request(app()).get(endpoint).set('Authorization', `Bearer ${await token('aal2', -1)}`)).status).toBe(401);
      expect((await request(app()).get(endpoint).set('Authorization', 'Bearer invalid-jwt')).status).toBe(401);
      expect((await request(app(true)).get(endpoint).set('Authorization', 'Bearer ak_test')).status).toBe(403);
    });
  }
});
