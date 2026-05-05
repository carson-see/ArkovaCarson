/**
 * Shared test helpers for `services/worker/src/api/v1/*.test.ts`.
 *
 * Two near-verbatim copies of `buildApp()` + `makeBuilder()` lived in
 * `compliance-audit.test.ts` and `orgSubOrgs.test.ts`, tripping SonarCloud's
 * 3% New-Code duplication gate (10.9% measured on PR #626). Extracted here so
 * future router smoke tests reuse the same scaffolding instead of cloning it.
 *
 * NOT a public test framework — keep this scoped to v1 router tests. If a
 * helper is only used once, inline it back into the test file.
 */

import express, { type Router, type Request } from 'express';
import { vi } from 'vitest';

/**
 * Build an Express app with a single auth-injection middleware and the given
 * router mounted. Tests mock the rest of the dependency surface via `vi.mock`.
 *
 * The `userId` is written into either `req.authUserId` (the typed convention
 * used by most v1 routers, see `router.ts:184`) or via a caller-provided
 * `injectUserId` for routers that read a non-standard field — `orgSubOrgs.ts`
 * reads `req.userId` via `(req as unknown as { userId?: string }).userId`.
 */
export function buildApp(
  router: Router,
  mountPath: string,
  opts: { userId?: string; injectUserId?: (req: Request, userId: string) => void } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (opts.userId) {
      if (opts.injectUserId) {
        opts.injectUserId(req, opts.userId);
      } else {
        // Default: typed `req.authUserId` (declared in src/types/express.d.ts)
        req.authUserId = opts.userId;
      }
    }
    next();
  });
  app.use(mountPath, router);
  return app;
}

/**
 * Superset of fluent-chain methods used across v1 router tests. Consumers
 * cast to `unknown as never` at the `db.from()` call site (PostgREST's typed
 * builder is not narrowable from a `vi.fn` mock).
 */
export interface Builder {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
}

/**
 * Terminal-state seed for `makeBuilder()`. Different routers terminate the
 * chain on different methods — the audit list endpoint awaits `.limit()`,
 * the sub-orgs list awaits `.order()`, and detail endpoints await `.single()`
 * or `.maybeSingle()`. We seed every terminal method off the same `state`
 * so the same builder serves all chain shapes the test exercises.
 */
export interface BuilderState {
  /** Used by `.order()` (sub-orgs list) and `.limit()` hybrid (audit list). */
  data?: unknown;
  /** Error to attach to the same terminal payload. */
  error?: unknown;
  /** Used by `.single()` resolution. */
  singleData?: unknown;
  /** Used by `.single()` error branch. */
  singleError?: unknown;
  /** Used by `.maybeSingle()` resolution. */
  maybeSingleData?: unknown;
  /**
   * Convenience alias for `data` — matches the field name the
   * compliance-audit test file used. Either field works.
   */
  selectData?: unknown;
  /** Alias for `error` matching the compliance-audit field name. */
  selectError?: unknown;
}

/**
 * Build a fluent mock for the Supabase / PostgREST query builder. Every
 * non-terminal chain method returns the builder; terminal methods resolve
 * with the seeded state.
 *
 * `.limit()` is a Promise/Builder hybrid: it both resolves with the list
 * payload (`compliance-audit.test.ts` GET-list flow) AND remains chainable
 * (so a downstream `.single()` keeps working). This matches the prior
 * inline implementation 1:1 — do not "simplify" it without re-running both
 * test suites.
 */
export function makeBuilder(state: BuilderState = {}): Builder {
  const builder = {} as Builder;
  const chain = () => builder;
  const listData = state.selectData ?? state.data ?? [];
  const listError = state.selectError ?? state.error ?? null;

  // `.order()` and `.limit()` are both Promise/Builder hybrids: awaiting
  // them resolves with the seeded list payload, but chaining a further
  // `.limit()` / `.single()` / `.maybeSingle()` also works. This unifies the
  // two prior inline implementations (orgSubOrgs awaited `.order()`,
  // compliance-audit awaited `.limit()`).
  const listPayload = () =>
    Object.assign(
      Promise.resolve({ data: listData, error: listError }),
      builder,
    );

  builder.select = vi.fn(chain);
  builder.insert = vi.fn(chain);
  builder.update = vi.fn(chain);
  builder.delete = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.in = vi.fn(chain);
  builder.gte = vi.fn(chain);
  builder.or = vi.fn(chain);
  builder.order = vi.fn(listPayload);
  builder.limit = vi.fn(listPayload);
  builder.single = vi.fn(() =>
    Promise.resolve({ data: state.singleData ?? null, error: state.singleError ?? null }),
  );
  builder.maybeSingle = vi.fn(() =>
    Promise.resolve({ data: state.maybeSingleData ?? null, error: null }),
  );
  return builder;
}
