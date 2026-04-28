/**
 * SCRUM-900 PROOF-SIG-01 — public-key registry route.
 *
 * Serves the published Arkova proof signing keys at
 *   GET /.well-known/arkova-keys.json
 *
 * Court clerks, regulators, and third-party auditors fetch this once,
 * cache locally, and verify any signed proof bundle offline by matching
 * `bundle.signing_key_id` against `keys[].id` and validating the
 * signature with `keys[].public_key_pem`. Historical bundles remain
 * verifiable across rotations because retired keys stay in the registry
 * with `status: "retired"` and a `retired_at` timestamp.
 *
 * The registry is sourced from a static JSON file checked into the
 * repo at `services/worker/proof-keys.public.json`. Production rotates
 * by editing the JSON + redeploying — there's no live KMS round-trip
 * on the request path, so the endpoint stays sub-ms and CDN-cacheable.
 */

import { Router, type Request, type Response } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export interface ProofKey {
  id: string;
  alg: 'Ed25519';
  status: 'active' | 'retired';
  public_key_pem: string;
  created_at: string;
  retired_at?: string;
  /** Optional — short note about the rotation reason, lifecycle, etc. */
  notes?: string;
}

export interface ProofKeyRegistry {
  registry_version: string;
  updated_at: string;
  keys: ProofKey[];
}

// Resolved at module load. The JSON file ships with the worker so the
// endpoint never depends on an external store.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let registryPath = resolve(__dirname, '../../proof-keys.public.json');

/** Tests override the on-disk registry path before exercising the route. */
export function __testOverridePath(path: string): void {
  registryPath = path;
  cachedRegistry = null;
  cachedAt = 0;
}

let cachedRegistry: ProofKeyRegistry | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

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

const router = Router();

router.get('/.well-known/arkova-keys.json', async (_req: Request, res: Response) => {
  const registry = await loadRegistry();
  if (!registry) {
    res.status(503).json({
      error:
        'Proof key registry not configured. Deploy services/worker/proof-keys.public.json with at least one active key.',
    });
    return;
  }
  // Long-cache: registry rotation requires a redeploy, so the file
  // hash is stable until then. CDNs / proxies can hold this aggressively.
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.json(registry);
});

export { router as proofKeysRouter };
