/**
 * Shared OAuth `state` HMAC secret resolution for integration connectors.
 *
 * 2026-04-24 forensic audit finding H1 / SCRUM-1236: the OAuth `state` parameter
 * must be signed with a dedicated `INTEGRATION_STATE_HMAC_SECRET` — never the
 * Supabase JWT secret or service-role key, which would collapse the user-auth
 * and OAuth-CSRF trust boundaries. Centralized here so the DocuSign org + member
 * routers share one fail-closed implementation instead of copy-pasting it.
 * (Drive `drive-oauth.ts` and GRC `grc.ts` retain their established inline
 * copies; they can adopt this helper in a future cleanup.)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';

export interface StateSecretDeps {
  stateSecret?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the dedicated HMAC secret for OAuth state signing. Returns an explicit
 * `stateSecret` (test override) or `INTEGRATION_STATE_HMAC_SECRET` from the
 * environment. Throws — fail-closed — when neither is present; it never falls
 * back to a general-purpose secret. `context` names the flow for the error.
 */
export function resolveIntegrationStateSecret(deps: StateSecretDeps, context: string): string {
  if (deps.stateSecret) return deps.stateSecret;
  const envSecret = (deps.env ?? process.env).INTEGRATION_STATE_HMAC_SECRET;
  if (envSecret && envSecret.length > 0) return envSecret;
  throw new Error(
    `INTEGRATION_STATE_HMAC_SECRET is required for ${context} OAuth state signing — fail-closed (audit H1)`,
  );
}

/**
 * Wrap a router factory so the real router — which validates
 * INTEGRATION_STATE_HMAC_SECRET at construction and throws when it is missing —
 * is built lazily on the first request rather than at module import. Eager
 * construction at import time would crash unrelated tests that import the module
 * without setting the env var.
 */
export function createLazyOAuthRouter(factory: () => Router): Router {
  let cached: Router | null = null;
  const wrapper = Router();
  wrapper.use((req: Request, res: Response, next: NextFunction) => {
    if (!cached) cached = factory();
    return cached(req, res, next);
  });
  return wrapper;
}
