/**
 * SCRUM-2483 — the credential-source provider fetch is SSRF-guarded.
 *
 * We can't drive real DNS here, but we CAN prove the helper is wired to the
 * safeFetch primitive (not the raw fetch global) by asserting it refuses a
 * literal private/metadata target before any socket is opened.
 */

import { describe, it, expect } from 'vitest';
import { createSafeProviderFetch } from './safe-provider-fetch.js';

describe('createSafeProviderFetch (SCRUM-2483)', () => {
  it('refuses a request to the cloud metadata IP', async () => {
    const fetchLike = createSafeProviderFetch();
    await expect(
      fetchLike('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toMatchObject({ code: 'private_target' });
  });

  it('refuses a request to an RFC 1918 host', async () => {
    const fetchLike = createSafeProviderFetch();
    await expect(fetchLike('http://10.0.0.5/')).rejects.toMatchObject({
      code: 'private_target',
    });
  });

  it('refuses a non-http(s) scheme', async () => {
    const fetchLike = createSafeProviderFetch();
    await expect(fetchLike('file:///etc/passwd')).rejects.toMatchObject({
      code: 'scheme_not_allowed',
    });
  });
});
