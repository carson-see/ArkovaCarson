/**
 * Tests for the shared Arkova API base URL default, used (directly or via
 * a local copy) by every partner integration.
 */

import { describe, it, expect } from 'vitest';
import { ARKOVA_DEFAULT_URL } from './constants';

describe('ARKOVA_DEFAULT_URL', () => {
  // 2026-09-21 (SCRUM-3888): the raw Cloud Run host has no Cloudflare origin
  // guard in front of it and is slated to be 403'd directly once that guard
  // enforces. Every default base URL in this repo must point at the public
  // gateway host instead — see packages/sdk/src/client.ts and
  // packages/embed/src/index.ts for the sibling fixes.
  it('is the public API gateway, not the raw Cloud Run host', () => {
    expect(ARKOVA_DEFAULT_URL).toBe('https://api.arkova.ai');
  });
});
