import { describe, expect, it } from 'vitest';

import { isAdminRouterPath } from './admin-paths.js';

describe('admin router path guard', () => {
  it('matches admin-owned paths mounted below /api', () => {
    expect(isAdminRouterPath('/admin/users')).toBe(true);
    expect(isAdminRouterPath('/treasury/status')).toBe(true);
    expect(isAdminRouterPath('/queue/pending')).toBe(true);
    expect(isAdminRouterPath('/rules/test')).toBe(true);
  });

  it('does not let /api/v1 traffic enter the admin checkout limiter', () => {
    expect(isAdminRouterPath('/v1/webhooks/self-service/dlq')).toBe(false);
    expect(isAdminRouterPath('/v1/verify/ARK-2026-ABC123/proof')).toBe(false);
  });
});
