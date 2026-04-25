/**
 * Secret handle resolver (SCRUM-1142).
 *
 * Rule configs reference webhook signing keys via opaque handles
 * (`sm:webhook_a`) instead of inlining the secret. The action dispatcher and
 * any other downstream that signs outbound traffic call `resolveSecretHandle`
 * to dereference a handle just-in-time.
 *
 * MVP resolution order:
 *   1. `RULE_FORWARD_SECRET_<UPPER_HANDLE>` env var (Cloud Run / local).
 *
 * GCP Secret Manager (`gcp-auth.ts`) is the next-step backend; the wrapper
 * here is intentionally narrow so we can swap the resolver without touching
 * call sites.
 */

const SECRET_HANDLE_PATTERN = /^sm:([a-z0-9_-]{1,64})$/i;

export interface SecretResolverDeps {
  /** Defaults to `process.env`; injected for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns the resolved secret bytes for a handle, or null if no backend
 * has a value for it. Callers MUST treat null as fail-closed — never
 * default to an empty string.
 */
export async function resolveSecretHandle(
  handle: string,
  deps: SecretResolverDeps = {},
): Promise<string | null> {
  const match = SECRET_HANDLE_PATTERN.exec(handle);
  if (!match) return null;
  const env = deps.env ?? process.env;
  const upper = match[1].toUpperCase().replace(/-/g, '_');
  const value = env[`RULE_FORWARD_SECRET_${upper}`];
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}
