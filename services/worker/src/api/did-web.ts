/**
 * SCRUM-1922 R-CTDL-FR9 — did:web identity endpoints.
 *
 * Serves W3C DID Core documents over did:web for:
 *   - Arkova platform:  did:web:app.arkova.ai
 *       GET /.well-known/did.json
 *   - Issuing orgs:     did:web:app.arkova.ai:orgs:{org-public-id}
 *       GET /orgs/{org-public-id}/did.json
 *
 * A did:web resolver maps the DID to an HTTPS fetch (W3C did:web spec): the
 * bare-host DID uses /.well-known/did.json, while a path-segment (sub-)DID
 * drops .well-known and serves a plain did.json under the path:
 *   did:web:app.arkova.ai            -> https://app.arkova.ai/.well-known/did.json
 *   did:web:app.arkova.ai:orgs:{id}  -> https://app.arkova.ai/orgs/{id}/did.json
 *
 * OPS PREREQUISITE: app.arkova.ai is the public verification host; the edge
 * routes that host (and `/orgs/*`) to this worker so the DIDs resolve. The
 * routes are built + tested here; the domain wiring is a deploy-time step,
 * not a code change.
 *
 * Key source: the SAME published Ed25519 key the proof-bundle registry serves
 * (services/worker/proof-keys.public.json, `status: "active"`). The public PEM
 * is converted to an OKP/Ed25519 JWK with Node crypto. The private key lives in
 * Secret Manager and is never touched here. Org sub-DIDs reuse the platform key
 * and are `controller`-ed by the Arkova DID (Arkova controls org identities).
 *
 * Mirrors services/worker/src/api/proof-keys.ts for registry loading (module-
 * level path + 60s cache + `__testOverridePath` seam + 503 when unreadable) and
 * services/worker/src/api/badge.ts for the public org lookup (DI seam + zod
 * public-id charset guard) so the endpoint stays sub-ms and CDN-cacheable.
 */

import { Router, type Request, type Response } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { z } from 'zod';
import type { ProofKey, ProofKeyRegistry } from './proof-keys.js';

// ─── Domain / DID constants ──────────────────────────────────────────────
// app.arkova.ai is the public verification host the edge routes to this worker.
// It is the did:web authority for the platform DID and all org sub-DIDs. There
// is no env var for this today; the host routing is a deploy-time ops step.
export const DID_WEB_DOMAIN = 'app.arkova.ai';
export const ARKOVA_DID = `did:web:${DID_WEB_DOMAIN}`;
const ARKOVA_HOMEPAGE = `https://${DID_WEB_DOMAIN}`;

// W3C DID Core v1 + the JWS-2020 suite context (required for a JsonWebKey2020
// verificationMethod carrying an OKP/Ed25519 publicKeyJwk).
const DID_CONTEXT = [
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/jws-2020/v1',
] as const;

// ─── Registry loading (mirrors proof-keys.ts) ────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Default: the same static registry the proof-bundle endpoint serves.
const DEFAULT_REGISTRY_PATH = resolve(__dirname, '../../proof-keys.public.json');
let registryPath: string = DEFAULT_REGISTRY_PATH;

let cachedRegistry: ProofKeyRegistry | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Tests override the on-disk registry path before exercising the route.
 * Pass `null` to restore the default path (and clear the cache).
 */
export function __testOverridePath(path: string | null): void {
  registryPath = path ?? DEFAULT_REGISTRY_PATH;
  cachedRegistry = null;
  cachedAt = 0;
}

async function loadRegistry(): Promise<ProofKeyRegistry | null> {
  const now = Date.now();
  if (cachedRegistry && now - cachedAt < CACHE_TTL_MS) {
    return cachedRegistry;
  }
  try {
    const raw = await readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as ProofKeyRegistry;
    cachedRegistry = parsed;
    cachedAt = now;
    return parsed;
  } catch {
    return null;
  }
}

/** The single active Ed25519 key, or null if none is published. */
async function getActiveKey(): Promise<ProofKey | null> {
  const registry = await loadRegistry();
  if (!registry || !Array.isArray(registry.keys)) return null;
  return registry.keys.find((k) => k.status === 'active') ?? null;
}

interface Ed25519Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

/**
 * Convert an Ed25519 SPKI PEM public key to its OKP JWK. Defensive: throws if
 * the PEM is not an Ed25519 public key so the route can fail to a 503 rather
 * than publish a malformed verification method.
 */
function pemToEd25519Jwk(pem: string): Ed25519Jwk {
  const jwk = createPublicKey(pem).export({ format: 'jwk' }) as Record<string, unknown>;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('active proof key is not an Ed25519 public key');
  }
  // Never expose a private scalar even if a malformed PEM somehow carried one.
  return { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
}

// ─── DID document builders (pure) ─────────────────────────────────────────

interface VerificationMethod {
  id: string;
  type: 'JsonWebKey2020';
  controller: string;
  publicKeyJwk: Ed25519Jwk;
}

interface ServiceEntry {
  id: string;
  type: string;
  serviceEndpoint: string;
}

interface DidDocument {
  '@context': readonly string[];
  id: string;
  controller?: string;
  name?: string;
  verificationMethod: VerificationMethod[];
  assertionMethod: string[];
  authentication: string[];
  service?: ServiceEntry[];
}

/** Build the Arkova platform DID document. */
export function buildArkovaDidDocument(activeKey: ProofKey): DidDocument {
  const jwk = pemToEd25519Jwk(activeKey.public_key_pem);
  const vmId = `${ARKOVA_DID}#${activeKey.id}`;
  return {
    '@context': DID_CONTEXT,
    id: ARKOVA_DID,
    verificationMethod: [
      { id: vmId, type: 'JsonWebKey2020', controller: ARKOVA_DID, publicKeyJwk: jwk },
    ],
    assertionMethod: [vmId],
    authentication: [vmId],
    service: [
      { id: `${ARKOVA_DID}#homepage`, type: 'LinkedDomains', serviceEndpoint: ARKOVA_HOMEPAGE },
    ],
  };
}

export interface DidWebOrgRow {
  public_id: string;
  display_name: string;
  website_url: string | null;
  suspended: boolean;
}

/**
 * Build an issuing-org sub-DID document. Reuses the platform key; `controller`
 * is the Arkova DID (Arkova controls org sub-DIDs). The org homepage is a
 * LinkedDomains service (omitted when null).
 *
 * The org's display name is carried as a top-level `name`. This is NOT a
 * DID-Core core property — it is a permitted human-readable extension, present
 * so a resolver can render the controlling org without a second fetch. It is
 * advisory metadata only: trust derives from the controller + verification
 * method, never from this label.
 */
export function buildOrgDidDocument(org: DidWebOrgRow, activeKey: ProofKey): DidDocument {
  const jwk = pemToEd25519Jwk(activeKey.public_key_pem);
  const orgDid = `${ARKOVA_DID}:orgs:${org.public_id}`;
  const vmId = `${orgDid}#${activeKey.id}`;
  const doc: DidDocument = {
    '@context': DID_CONTEXT,
    id: orgDid,
    controller: ARKOVA_DID,
    name: org.display_name,
    verificationMethod: [
      // controller stays the Arkova DID — the key is Arkova's, bound under the org DID.
      { id: vmId, type: 'JsonWebKey2020', controller: ARKOVA_DID, publicKeyJwk: jwk },
    ],
    assertionMethod: [vmId],
    authentication: [vmId],
  };

  const homepage = sanitizeHomepage(org.website_url);
  if (homepage) {
    doc.service = [{ id: `${orgDid}#homepage`, type: 'LinkedDomains', serviceEndpoint: homepage }];
  }
  return doc;
}

/** Only emit http(s) homepages; drop anything else so the service stays valid. */
function sanitizeHomepage(websiteUrl: string | null): string | null {
  if (typeof websiteUrl !== 'string' || websiteUrl.trim() === '') return null;
  try {
    const url = new URL(websiteUrl.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ─── Org public-id charset guard ──────────────────────────────────────────
// The org public_id becomes a did:web path segment AND a URL path segment.
// `:` is the did:web segment delimiter and `/` `%` would break the path, so we
// allow only [A-Za-z0-9._-], 1..128 chars, starting + ending alphanumeric.
// This matches real org public_ids (PREFIX-UPPERHEX) while blocking injection.
const orgPublicIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/);

// ─── DB lookup (DI seam, mirrors badge.ts) ────────────────────────────────
export type DidWebOrgLookup = (publicId: string) => Promise<DidWebOrgRow | null>;

async function defaultLookupOrg(publicId: string): Promise<DidWebOrgRow | null> {
  const { db } = await import('../utils/db.js');
  const { data, error } = await db
    .from('organizations')
    .select('public_id, display_name, website_url, suspended')
    .eq('public_id', publicId)
    .maybeSingle();
  // A DB error is an outage, NOT "no such org". Throw so the route surfaces a
  // 5xx (resolvers retry) instead of masking it as a 404 (resolvers cache a
  // false negative). 404 is reserved for `data === null` — a real missing row.
  // Mirrors badge.ts `defaultLookupPublicAnchor`.
  if (error) {
    throw new Error(error.message ?? 'Failed to load organization DID');
  }
  if (!data) return null;
  return data as unknown as DidWebOrgRow;
}

/** Best-effort structured log for an org-lookup failure (mirrors badge.ts). */
async function logOrgLookupError(err: unknown, publicId: string): Promise<void> {
  try {
    const { logger } = await import('../utils/logger.js');
    logger.error({ err, publicId }, 'Failed to resolve org did:web document');
  } catch {
    // If config-bound logging is unavailable, still return the safe HTTP error.
  }
}

// ─── Router ───────────────────────────────────────────────────────────────
export interface DidWebRouterDeps {
  lookupOrg?: DidWebOrgLookup;
}

function setDidJson(res: Response): void {
  res.type('application/did+json');
  // 5-minute fresh window (max-age=300) + 1h stale-while-revalidate. The doc is
  // effectively stable (the key rotates only on redeploy, org rows change
  // rarely), but the short max-age bounds how long a CDN/resolver serves a
  // stale doc after a key rotation or org suspension — a deliberate tradeoff
  // over a multi-day TTL. Mirrors badge.ts.
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
}

export function createDidWebRouter(deps: DidWebRouterDeps = {}): Router {
  const lookupOrg = deps.lookupOrg ?? defaultLookupOrg;
  const router = Router();

  // ─── Arkova platform DID ───
  router.get('/.well-known/did.json', async (_req: Request, res: Response) => {
    const activeKey = await getActiveKey();
    if (!activeKey) {
      res.status(503).json({
        error:
          'No active signing key published. Deploy services/worker/proof-keys.public.json with an active Ed25519 key.',
      });
      return;
    }
    let doc: DidDocument;
    try {
      doc = buildArkovaDidDocument(activeKey);
    } catch {
      res.status(503).json({ error: 'Active signing key is not a valid Ed25519 public key.' });
      return;
    }
    setDidJson(res);
    res.json(doc);
  });

  // ─── Issuing-org sub-DID ───
  // W3C did:web: did:web:app.arkova.ai:orgs:{id} resolves to /orgs/{id}/did.json
  // (path-segment DIDs use a plain did.json; only the bare-host DID lives under
  // /.well-known/did.json).
  router.get('/orgs/:orgPublicId/did.json', async (req: Request, res: Response) => {
    // Validate the public id BEFORE any DB round-trip (injection / path safety).
    const parsed = orgPublicIdSchema.safeParse(req.params.orgPublicId);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid organization identifier.' });
      return;
    }
    const orgPublicId = parsed.data;

    const activeKey = await getActiveKey();
    if (!activeKey) {
      res.status(503).json({
        error:
          'No active signing key published. Deploy services/worker/proof-keys.public.json with an active Ed25519 key.',
      });
      return;
    }

    let org: DidWebOrgRow | null;
    try {
      org = await lookupOrg(orgPublicId);
    } catch (err) {
      // The lookup throws on a DB/transport error (not on a missing row). Surface
      // a 503 so resolvers retry, rather than masking the outage as a 404.
      void logOrgLookupError(err, orgPublicId);
      res.status(503).json({ error: 'Organization DID is temporarily unavailable.' });
      return;
    }
    // 404 for unknown OR suspended orgs — a suspended org has no resolvable,
    // advertisable W3C identity, and 404 (vs 403) avoids confirming existence.
    if (!org || org.suspended) {
      res.status(404).json({ error: 'No DID document for this organization.' });
      return;
    }

    let doc: DidDocument;
    try {
      doc = buildOrgDidDocument(org, activeKey);
    } catch {
      res.status(503).json({ error: 'Active signing key is not a valid Ed25519 public key.' });
      return;
    }
    setDidJson(res);
    res.json(doc);
  });

  return router;
}

/** Default router instance wired to the real service-role org lookup. */
export const didWebRouter = createDidWebRouter();
