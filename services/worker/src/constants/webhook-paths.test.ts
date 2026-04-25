import { describe, it, expect } from 'vitest';
import { API_V1_PREFIX, WEBHOOK_PATHS, relativeTo } from './webhook-paths.js';

describe('webhook-paths constants', () => {
  it('Drive webhook path is mounted under the v1 prefix', () => {
    expect(WEBHOOK_PATHS.GOOGLE_DRIVE.startsWith(API_V1_PREFIX)).toBe(true);
  });

  it('relativeTo strips the v1 prefix and preserves a leading slash', () => {
    expect(relativeTo(WEBHOOK_PATHS.GOOGLE_DRIVE, API_V1_PREFIX)).toBe('/webhooks/drive');
  });

  it('relativeTo throws when the prefix does not match', () => {
    expect(() => relativeTo(WEBHOOK_PATHS.GOOGLE_DRIVE, '/api/v2')).toThrow(/does not start/);
  });
});
