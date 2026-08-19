/**
 * BUG-018 / D-8 — environment namespace derivation.
 *
 * The invariant every test here defends: two DIFFERENT deployment surfaces can
 * never derive the same namespace, and only the real production service can
 * derive the production one. Everything downstream (the Upstash rate-limit
 * keyspace) inherits its isolation from that guarantee, so a hole here is a
 * hole in prod's rate-limit budget.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  PROD_NAMESPACE,
  PROD_SERVICE_NAME,
  resolveEnvironmentNamespace,
} from './environmentNamespace.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('resolveEnvironmentNamespace — Cloud Run (K_SERVICE present)', () => {
  it('maps the one real production service to the production namespace', () => {
    expect(resolveEnvironmentNamespace({ kService: PROD_SERVICE_NAME, nodeEnv: 'production' }))
      .toBe(PROD_NAMESPACE);
  });

  it('gives every non-prod Cloud Run service its own namespace, even at NODE_ENV=production', () => {
    // Rigs and shared staging both run NODE_ENV=production — which is exactly
    // why NODE_ENV alone cannot be the discriminator (MT-1 / SCRUM-2901).
    const staging = resolveEnvironmentNamespace({
      kService: 'arkova-worker-staging',
      nodeEnv: 'production',
    });
    const sidecar = resolveEnvironmentNamespace({
      kService: 'arkova-worker-connector-sidecar-2026-08-staging',
      nodeEnv: 'production',
    });
    const prod = resolveEnvironmentNamespace({
      kService: PROD_SERVICE_NAME,
      nodeEnv: 'production',
    });

    expect(new Set([staging, sidecar, prod]).size).toBe(3);
    expect(staging).not.toBe(PROD_NAMESPACE);
    expect(sidecar).not.toBe(PROD_NAMESPACE);
  });

  it('does not let a service whose name merely PREFIXES the prod service claim prod', () => {
    // 'arkova-worker-staging'.startsWith('arkova-worker') — a prefix/substring
    // check here would hand shared staging production's bucket.
    expect(resolveEnvironmentNamespace({ kService: 'arkova-worker-staging', nodeEnv: 'production' }))
      .not.toBe(PROD_NAMESPACE);
    expect(resolveEnvironmentNamespace({ kService: 'arkova-worker2', nodeEnv: 'production' }))
      .not.toBe(PROD_NAMESPACE);
  });

  it('escapes a non-prod service that would otherwise sanitize INTO the reserved prod namespace', () => {
    // Someone stands up a Cloud Run service literally called `prod`. Without a
    // reserved-token guard it silently shares production's counters.
    const impostor = resolveEnvironmentNamespace({ kService: PROD_NAMESPACE, nodeEnv: 'production' });
    expect(impostor).not.toBe(PROD_NAMESPACE);
    expect(resolveEnvironmentNamespace({ kService: PROD_SERVICE_NAME, nodeEnv: 'production' }))
      .toBe(PROD_NAMESPACE);
  });

  it('K_SERVICE outranks NODE_ENV — a rig running NODE_ENV=development is still its own namespace', () => {
    expect(resolveEnvironmentNamespace({ kService: 'arkova-worker-staging', nodeEnv: 'development' }))
      .toBe(resolveEnvironmentNamespace({ kService: 'arkova-worker-staging', nodeEnv: 'production' }));
  });
});

describe('resolveEnvironmentNamespace — off Cloud Run (no K_SERVICE)', () => {
  it('never lets a bare NODE_ENV=production claim the prod namespace', () => {
    // A local shell or `docker run` with NODE_ENV=production must not write
    // into production's keyspace. Same §1.5 honesty rule as Sentry's.
    const local = resolveEnvironmentNamespace({ nodeEnv: 'production' });
    expect(local).not.toBe(PROD_NAMESPACE);
    expect(local).toBe('local-production');
  });

  it('uses NODE_ENV verbatim for development and test', () => {
    expect(resolveEnvironmentNamespace({ nodeEnv: 'development' })).toBe('development');
    expect(resolveEnvironmentNamespace({ nodeEnv: 'test' })).toBe('test');
  });

  it('treats a blank or absent K_SERVICE as absent, not as an empty namespace', () => {
    expect(resolveEnvironmentNamespace({ kService: '   ', nodeEnv: 'test' })).toBe('test');
    expect(resolveEnvironmentNamespace({ kService: '', nodeEnv: 'test' })).toBe('test');
  });

  it('falls back to a named unknown rather than an empty namespace segment', () => {
    // An empty segment would produce `arkova:rl::<ip>` — every unidentified
    // surface silently sharing one bucket.
    expect(resolveEnvironmentNamespace({ nodeEnv: '' })).toBe('unknown');
    expect(resolveEnvironmentNamespace({})).toBe('unknown');
  });
});

describe('resolveEnvironmentNamespace — key hygiene', () => {
  it('produces a Redis-safe token: lowercase, no whitespace, no colons', () => {
    // A colon would forge an extra keyspace segment; whitespace breaks the
    // path-style REST transport.
    const ns = resolveEnvironmentNamespace({ kService: 'Weird Service:Name!' });
    expect(ns).toMatch(/^[a-z0-9._-]+$/);
    expect(ns).not.toContain(':');
    expect(ns).not.toContain(' ');
  });

  it('bounds the namespace length so an oversized env var cannot bloat every key', () => {
    const ns = resolveEnvironmentNamespace({ kService: 'x'.repeat(500) });
    expect(ns.length).toBeLessThanOrEqual(64);
  });

  it('keeps real Cloud Run service names intact (no lossy rewrite)', () => {
    expect(resolveEnvironmentNamespace({ kService: 'arkova-worker-fullsoak-2026-08-staging' }))
      .toBe('arkova-worker-fullsoak-2026-08-staging');
  });
});

describe('resolveEnvironmentNamespace — process.env default', () => {
  it('reads K_SERVICE / NODE_ENV from process.env when called with no arguments', () => {
    process.env.K_SERVICE = 'arkova-worker-staging';
    process.env.NODE_ENV = 'production';
    expect(resolveEnvironmentNamespace()).toBe('arkova-worker-staging');

    process.env.K_SERVICE = PROD_SERVICE_NAME;
    expect(resolveEnvironmentNamespace()).toBe(PROD_NAMESPACE);

    delete process.env.K_SERVICE;
    expect(resolveEnvironmentNamespace()).toBe('local-production');
  });
});
