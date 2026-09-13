/**
 * SCRUM-3981 — `webhooks:manage` is enforced on the whole `/api/v1/webhooks`
 * mount, not merely offered in the scope vocabulary.
 *
 * Before this test existed, `router.ts` mounted `webhooksRouter` behind
 * `batchRateLimiter` only. Every handler checked that *an* API key was
 * present (`requireApiKey`), and the five ORG_ADMIN routes (create, patch,
 * delete, and both DLQ routes) additionally checked the actor's role, but
 * nothing checked a scope — so a key minted with the
 * default `['read:search']` could list an org's endpoints, read a single
 * endpoint, fire test pings, read delivery logs, replay a delivery, and work
 * the dead-letter queue. `webhooks:manage` existed in `apiScopes.ts`, in the
 * docs, and in the dashboard's scope picker, and gated nothing.
 *
 * Four properties are pinned here, and they are deliberately different:
 *
 *   1. insufficient scope → 403 on EVERY route the router owns. The route
 *      list is read from `webhooksRouter.stack` (Express's own registry),
 *      not hand-transcribed, so a route added later is covered on the day it
 *      is added rather than the day someone remembers this file.
 *   2. `webhooks:manage` passes the guard — the guard is not a blanket deny.
 *      Asserted by a marker middleware between the guard and the router, so
 *      the assertion does not depend on what the (db-mocked) handler answers.
 *   3. no key at all → 401 `authentication_required`, NOT a fall-through 200.
 *      `requireScope` opens with `if (!req.apiKey) { next(); return; }`
 *      (apiKeyAuth.ts), which is safe here ONLY because every handler still
 *      calls `requireApiKey` downstream. That pairing is load-bearing and is
 *      what this case guards: drop the handler-level check and this fails.
 *   4. holding `webhooks:manage` is not authority over another org. The
 *      per-org `.eq('org_id', ...)` filter still shapes a cross-org read as
 *      404, not 403 — scope is capability, org_id is ownership.
 */
import { readFileSync } from 'node:fs';
import express, { type Request } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../webhooks/delivery.js', () => ({
  getDeadLetterEntries: vi.fn(async () => []),
  isPrivateUrlResolved: vi.fn(async () => false),
  replayDelivery: vi.fn(),
  resolveDlqEntry: vi.fn(async () => true),
  signPayload: vi.fn(() => 'sig-test'),
}));

const mockDbFrom = vi.fn();
vi.mock('../../utils/db.js', () => ({ db: { from: mockDbFrom, rpc: vi.fn() } }));

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { webhooksRouter } = await import('./webhooks.js');
const { requireScope } = await import('../../middleware/apiKeyAuth.js');

type ExpressMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteLayer {
  route?: { path: string; methods: Partial<Record<ExpressMethod, boolean>> };
}

interface MountedRoute {
  method: ExpressMethod;
  path: string;
}

/**
 * The router's own `.stack` — populated by Express from the `router.get(...)`
 * / `router.post(...)` calls in webhooks.ts. Same extraction technique as
 * `docs.routeParity.test.ts`, for the same reason: a hand-written list goes
 * stale silently.
 */
function ownRoutes(): MountedRoute[] {
  const stack = (webhooksRouter as unknown as { stack: RouteLayer[] }).stack;
  const routes: MountedRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods) as ExpressMethod[]) {
      if (layer.route.methods[method]) routes.push({ method, path: layer.route.path });
    }
  }
  return routes;
}

const ENDPOINT_ID = '11111111-1111-4111-8111-111111111111';

/** Concrete request for a route: `:id` filled in, plus the minimum body. */
function requestFor(route: MountedRoute): {
  method: ExpressMethod;
  url: string;
  body: Record<string, string> | undefined;
} {
  const url = `/api/v1/webhooks${route.path === '/' ? '' : route.path.replace(':id', ENDPOINT_ID)}`;
  const body =
    route.method === 'post' || route.method === 'patch'
      ? { url: 'https://example.com/hook', endpoint_id: ENDPOINT_ID }
      : undefined;
  return { method: route.method, url, body };
}

const API_KEY_BASE = {
  keyId: 'key-1',
  keyPrefix: 'ak_test',
  orgId: 'org-A',
  userId: 'user-001',
  rateLimitTier: 'paid' as const,
};

/**
 * The production mount from `router.ts`, minus the rate limiter (its bucket
 * state is irrelevant here): key → scope guard → router. The marker records
 * whether the guard passed control on.
 */
function buildApp(scopes: string[] | null) {
  const reached = { value: false };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/webhooks',
    (req: Request, _res, next) => {
      if (scopes) req.apiKey = { ...API_KEY_BASE, scopes };
      next();
    },
    requireScope('webhooks:manage'),
    (_req, _res, next) => {
      reached.value = true;
      next();
    },
    webhooksRouter,
  );
  return { app, reached };
}

function send(app: express.Express, route: MountedRoute) {
  const { method, url, body } = requestFor(route);
  const agent = request(app)[method](url);
  return body === undefined ? agent : agent.send(body);
}

describe('SCRUM-3981 — /api/v1/webhooks requires the webhooks:manage scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbFrom.mockReturnValue({});
  });

  const routes = ownRoutes();

  it('reads a non-empty route list off the Express stack', () => {
    // A zero-length list would make every it.each below vacuously green.
    expect(routes.length).toBeGreaterThan(0);
  });

  it('covers all 10 routes webhooks.ts registers today', () => {
    // Ratchet, not decoration: an 11th route must be considered here rather
    // than inheriting coverage silently.
    expect(routes.length).toBe(10);
  });

  it.each(routes)('$method $path → 403 insufficient_scope for a read:search key', async (route) => {
    const { app, reached } = buildApp(['read:search']);
    const res = await send(app, route);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required).toBe('webhooks:manage');
    expect(reached.value).toBe(false);
  });

  it.each(routes)('$method $path → the guard passes a webhooks:manage key through', async (route) => {
    const { app, reached } = buildApp(['webhooks:manage']);
    const res = await send(app, route);

    expect(res.body?.error).not.toBe('insufficient_scope');
    expect(reached.value).toBe(true);
  });

  it.each(routes)('$method $path → 401 authentication_required with no key (never a fall-through 200)', async (route) => {
    const { app, reached } = buildApp(null);
    const res = await send(app, route);

    // The scope guard itself falls through for an anonymous caller...
    expect(reached.value).toBe(true);
    // ...and the handler-level requireApiKey is what stops it.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('authentication_required');
  });
});

describe('SCRUM-3981 — router.ts actually mounts the guard', () => {
  // The behavioural cases above build the chain themselves, so they would stay
  // green if router.ts dropped the guard. This reads the real mount.
  const routerSource = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');

  it('mounts webhooksRouter behind requireScope(\'webhooks:manage\')', () => {
    expect(routerSource).toContain(
      "router.use('/webhooks', batchRateLimiter, requireScope('webhooks:manage'), webhooksRouter);",
    );
  });

  it('keeps the rate limiter ahead of the scope guard', () => {
    // Cheapest check first: an unscoped flood is rejected before a DB-backed
    // key lookup is worth anything to the caller.
    //
    // Slice to the END OF THE MOUNT STATEMENT, not to end-of-file: router.ts
    // carries ten other `requireScope(` call sites, six of them BELOW this
    // mount, so an open-ended slice finds one of those and the assertion holds
    // even when this mount has no scope guard at all.
    const start = routerSource.indexOf("router.use('/webhooks', ");
    expect(start, "the broad '/webhooks' mount is no longer a single statement").toBeGreaterThan(-1);
    const mount = routerSource.slice(start, routerSource.indexOf('\n', start));

    expect(mount).toContain('batchRateLimiter');
    expect(mount).toContain("requireScope('webhooks:manage')");
    expect(mount.indexOf('batchRateLimiter')).toBeLessThan(mount.indexOf('requireScope('));
  });

  it('leaves the handler-level API-key check in webhooks.ts in place', () => {
    // requireScope falls through for anonymous callers; this is the check that
    // turns that fall-through into a 401 instead of a 200.
    const webhooksSource = readFileSync(new URL('./webhooks.ts', import.meta.url), 'utf8');
    expect(webhooksSource).toMatch(/function requireApiKey\(/);
    expect(webhooksSource).toMatch(/error: 'authentication_required'/);
  });
});

describe('SCRUM-3981 — webhooks:manage is capability, not cross-org authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** `webhook_endpoints` select chain that honours the `org_id` filter. */
  function mockEndpointOwnedBy(ownerOrgId: string) {
    mockDbFrom.mockImplementation((table: string) => {
      if (table !== 'webhook_endpoints') return {};
      let requestedOrg: string | null = null;
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => {
          if (column === 'org_id') requestedOrg = value;
          return chain;
        },
        maybeSingle: async () =>
          requestedOrg === ownerOrgId
            ? { data: { id: ENDPOINT_ID, url: 'https://example.com/hook' }, error: null }
            : { data: null, error: null },
      };
      return chain;
    });
  }

  it('lets org A read its own endpoint', async () => {
    mockEndpointOwnedBy('org-A');
    const { app } = buildApp(['webhooks:manage']);
    const res = await request(app).get(`/api/v1/webhooks/${ENDPOINT_ID}`);

    expect(res.status).toBe(200);
  });

  it('answers 404 (not 403) when org B holds webhooks:manage and asks for org A’s endpoint', async () => {
    mockEndpointOwnedBy('org-A');
    const reached = { value: false };
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/webhooks',
      (req: Request, _res, next) => {
        req.apiKey = { ...API_KEY_BASE, orgId: 'org-B', scopes: ['webhooks:manage'] };
        next();
      },
      requireScope('webhooks:manage'),
      (_req, _res, next) => {
        reached.value = true;
        next();
      },
      webhooksRouter,
    );

    const res = await request(app).get(`/api/v1/webhooks/${ENDPOINT_ID}`);

    expect(reached.value).toBe(true);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
