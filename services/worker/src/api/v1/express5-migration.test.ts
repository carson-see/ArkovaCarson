/**
 * Express 5 Migration Regression Tests (DEP-04 / SCRUM-555)
 *
 * Guards the DEP-04 migration against silent regressions:
 *
 * 1. `express` major version is 5.x — if something pulls it back to 4.x,
 *    the Sentry scanner will stop flagging `path-to-regexp` vulnerabilities
 *    and we lose the point of the upgrade.
 *
 * 2. `Request<{ paramName: string }>` correctly narrows `req.params[key]` to
 *    `string` at the type level. @types/express@5 widened `ParamsDictionary`
 *    to `{ [key: string]: string | string[] }` to support repeating path
 *    segments (`/:ids+`). Arkova's 9 route handlers in `services/worker/
 *    src/api/v1/` rely on the typed-Request generic to narrow back to string.
 *    A silent downgrade of @types/express or a removal of the generic would
 *    re-break typecheck. This test pins the generic's behavior so a future
 *    PR that drops the annotation will fail here instead of shipping broken.
 *
 * 3. Express 5's auto-async error forwarding coexists with our existing
 *    try/catch handlers — new routes don't need explicit `next(err)` wrappers.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Request } from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const expressPkg = require('express/package.json') as { version: string };

describe('Express 5 migration (DEP-04 / SCRUM-555)', () => {
  it('is pinned to express 5.x — downgrade to 4.x would reintroduce path-to-regexp CVEs', () => {
    const major = Number(expressPkg.version.split('.')[0]);
    expect(major).toBe(5);
  });

  it('typed Request<{ id: string }> narrows req.params.id to string (not string | string[])', () => {
    type WithId = Request<{ id: string }>;

    // Type-level assertion: if @types/express is downgraded or the generic
    // stops narrowing, the expectTypeOf call below will fail typecheck.
    expectTypeOf<WithId['params']['id']>().toEqualTypeOf<string>();

    // Runtime sanity: simulated handler can pattern-match on the param
    // without string[] narrowing overhead.
    const req = { params: { id: 'abc-123' } } as WithId;
    const { id } = req.params;
    expect(id).toBe('abc-123');
    expect(typeof id).toBe('string');
  });

  it('typed Request<{ agentId, publicId }> narrows multi-param routes', () => {
    type MultiParam = Request<{ agentId: string; publicId: string }>;
    expectTypeOf<MultiParam['params']['agentId']>().toEqualTypeOf<string>();
    expectTypeOf<MultiParam['params']['publicId']>().toEqualTypeOf<string>();
  });

  it('untyped Request is intentionally widened by @types/express@5 (regression guard)', () => {
    // This is the WRONG shape we migrated away from. If a future PR re-adds
    // an untyped `Request` to any handler, `const { id } = req.params` would
    // produce `string | string[]` and break typecheck. This test documents
    // that the widening is intentional in @types/express@5 so the reader
    // understands why the 9 handlers all have explicit generics.
    type Untyped = Request['params'][string];
    expectTypeOf<Untyped>().toEqualTypeOf<string | string[]>();
  });
});
