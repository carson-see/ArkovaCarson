/**
 * DocuSign Record Deep Links (bilateral rollout, frontend-targeted T2)
 *
 * Authenticated record-detail page ONLY — the public verification page is
 * explicitly out of scope for this module and must never import it.
 *
 * Turns DocuSign account/envelope/recipient identifiers already present on
 * an anchor's metadata into deep links back into DocuSign's own console, so
 * a record owner can jump straight to the source envelope. DocuSign account,
 * envelope, and recipient ids are all UUIDs — that is the entire security
 * property this module leans on: a candidate value is validated as a STRICT
 * UUID before it is ever interpolated into a URL, and every builder returns
 * `null` (never a partially-built or best-effort URL) on anything that does
 * not match. There is no code path from an arbitrary metadata string to an
 * href — a value that is not a UUID never reaches the template literal that
 * builds the URL, so this is immune to `javascript:`/open-redirect injection
 * BY CONSTRUCTION, not by downstream sanitization.
 *
 * The two bases are fixed constants, never derived from metadata or any
 * other caller-supplied string — only WHICH of the two is selected varies,
 * via the `env` argument (resolved from the anchor's `_docusign_env`
 * metadata field with {@link resolveDocusignEnv}, which itself only ever
 * returns one of the two literal values, defaulting to `'prod'`).
 *
 * DocuSign exposes no per-signer profile URL, so `signerUrl` intentionally
 * resolves to the same envelope-details URL as `envelopeUrl` — the envelope
 * is the only signer-verification surface DocuSign has.
 */

/** Which DocuSign environment a record's identifiers belong to. */
export type DocusignEnv = 'prod' | 'demo';

/**
 * Strict UUID/GUID shape: exactly 8-4-4-4-12 hex digits, anchored at both
 * ends (no partial match, no leading/trailing whitespace or characters) and
 * case-insensitive (DocuSign ids are observed lowercase; accepting uppercase
 * costs nothing and avoids a false rejection on a re-cased value).
 *
 * Deliberately does NOT enforce RFC 4122 version/variant bits. The property
 * this regex exists to guarantee is "safe to interpolate into a URL" — only
 * `[0-9a-f-]` can ever match — not "is a v4 UUID". Some legitimate ids in
 * this codebase are valid UUID text with zeroed version/variant fields (see
 * `e2e/fixtures/supabase.ts` `POSTGRES_UUID_RE` for the same reasoning
 * applied to deterministic seed ids); over-constraining here would risk a
 * false rejection of a real DocuSign id, not just of an attack payload.
 */
const STRICT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only for a value that is a string matching {@link STRICT_UUID_RE}
 * exactly. A TypeScript type guard so callers narrow `unknown` metadata
 * straight to `string`. Every builder below calls this FIRST and returns
 * `null` immediately when it fails, before any URL is built — this is the
 * single choke point every candidate value must pass through.
 */
export function isStrictUuid(value: unknown): value is string {
  return typeof value === 'string' && STRICT_UUID_RE.test(value);
}

/** Fixed DocuSign console origins. Never derived from metadata or input. */
const DOCUSIGN_BASE_URLS: Record<DocusignEnv, string> = {
  prod: 'https://apps.docusign.com',
  demo: 'https://apps-d.docusign.com',
};

/**
 * Resolves an arbitrary metadata value (typically `metadata._docusign_env`)
 * to a {@link DocusignEnv}. Anything other than the exact string `'demo'`
 * resolves to `'prod'` — including `undefined`/absent, null, and any other
 * type — so an anchor with no `_docusign_env` field (every anchor from
 * before this rollout) defaults to prod, per spec.
 */
export function resolveDocusignEnv(value: unknown): DocusignEnv {
  return value === 'demo' ? 'demo' : 'prod';
}

/** Defensive fallback to prod for a runtime value outside the DocusignEnv union. */
function baseUrl(env: DocusignEnv): string {
  return DOCUSIGN_BASE_URLS[env] ?? DOCUSIGN_BASE_URLS.prod;
}

/**
 * Deep link to a DocuSign account's Send/home console.
 * `null` when `accountId` is not a strict UUID — the ONLY way this can fail.
 */
export function accountUrl(accountId: unknown, env: DocusignEnv = 'prod'): string | null {
  if (!isStrictUuid(accountId)) return null;
  // encodeURIComponent here is defense-in-depth, not load-bearing: isStrictUuid
  // already constrained accountId to [0-9a-f-], so this is a guaranteed no-op.
  return `${baseUrl(env)}/send/home?account=${encodeURIComponent(accountId)}`;
}

/**
 * Deep link to a DocuSign envelope's details page.
 * `null` when `envelopeId` is not a strict UUID.
 */
export function envelopeUrl(envelopeId: unknown, env: DocusignEnv = 'prod'): string | null {
  if (!isStrictUuid(envelopeId)) return null;
  // encodeURIComponent here is defense-in-depth, not load-bearing: isStrictUuid
  // already constrained envelopeId to [0-9a-f-], so this is a guaranteed no-op.
  return `${baseUrl(env)}/send/documents/details/${encodeURIComponent(envelopeId)}`;
}

/**
 * Deep link for a signer. DocuSign exposes no per-recipient profile URL, so
 * this intentionally resolves to the SAME envelope-details URL as
 * {@link envelopeUrl} — the envelope is the only signer-verification
 * surface DocuSign has. In practice this is called with a recipient GUID
 * (`metadata._signers[i].recipient_id_guid`), not the anchor's own top-level
 * envelope id; the validation and URL shape are identical either way, since
 * both are plain UUIDs and DocuSign has exactly one details route for both.
 * `null` under the same condition as `envelopeUrl`.
 */
export function signerUrl(id: unknown, env: DocusignEnv = 'prod'): string | null {
  return envelopeUrl(id, env);
}
