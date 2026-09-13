/**
 * Agentic Verification Search Endpoint (P8-S19)
 *
 * GET /api/v1/verify/search?q={query} — Search-based verification for AI agents.
 * Combines semantic search with frozen verification schema results.
 *
 * Designed for ATS systems, background check integrations, and AI agents
 * that need natural language credential lookup rather than exact IDs.
 *
 * Gated behind ENABLE_VERIFICATION_API (worker-wide, router.ts). API key
 * required (no anonymous access). Credits deducted per search, semantic
 * mode only.
 *
 * SCRUM-3906 (N3 / BUG-2026-09-02-001 follow-up): this route used to sit
 * behind `aiSemanticSearchGate()` at the router mount, so with
 * ENABLE_SEMANTIC_SEARCH off (prod default today) EVERY call 503'd —
 * including every direct API-key caller (npm SDKs, the `arkova` package).
 * The edge MCP tool already tolerates that 503 by re-running a lexical
 * query itself (`services/edge/src/mcp-tools.ts` handleSearchCredentials /
 * searchCredentialsFallback), but a caller hitting this worker route
 * directly had no such fallback. This route now owns its own lexical
 * fallback — mirroring the edge's `search_public_credentials` RPC path —
 * instead of relying on every caller to reimplement it.
 *
 * Mode selection (see `search_mode` on the response):
 *   - ENABLE_SEMANTIC_SEARCH on AND the embed+RPC path succeeds → 'semantic_vector'.
 *   - ENABLE_SEMANTIC_SEARCH off, OR the embed/RPC path throws or errors  →
 *     'lexical_substring', via `search_public_credentials` (the same
 *     ILIKE-based RPC the edge uses; the edge does NOT need to be told
 *     about this — it degrades to this route returning a 503 today, and
 *     continues to work once this ships, just via a shorter path).
 * The mode is a real vocabulary shared with `services/edge/src/mcp-tools.ts`
 * (`SEARCH_MODE_SEMANTIC` / `SEARCH_MODE_LEXICAL`) — not redefined loosely —
 * so a future edge change can read this field directly instead of inferring
 * mode from HTTP status. As of this PR the edge does NOT read it (see PR
 * body pre-mortem): `searchCredentialsWorkerSemantic()` in mcp-tools.ts
 * still treats ANY 2xx worker response as semantic, so an MCP caller
 * proxied through the edge will mislabel this route's lexical fallback as
 * `semantic_vector` until the edge is updated to check this field. That is
 * a separate, edge-owned follow-up (out of lane for this worker-only PR) —
 * flagged, not fixed, here.
 *
 * Never fails open silently: the flag-off path and the RPC/embedding
 * failure path both log at warn with a bounded reason, and the response
 * always carries `search_mode` so a caller can tell which path answered.
 *
 * Constitution 4A: Only public credential data is returned (no org-private
 * data, no internal ids — §6).
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAIProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { isSemanticSearchEnabled } from '../../middleware/aiFeatureGate.js';
import { buildVerifyUrl } from '../../lib/urls.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { callRpc } from '../../utils/rpc.js';

const router = Router();

const VerifySearchSchema = z.object({
  q: z.string().min(1, 'Search query is required').max(500),
  threshold: z.coerce.number().min(0).max(1).default(0.75),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

/**
 * `search_mode` vocabulary. Deliberately the SAME string values as
 * `services/edge/src/mcp-tools.ts` (`SEARCH_MODE_SEMANTIC` /
 * `SEARCH_MODE_LEXICAL`, per the SCRUM-3941 spec) rather than a
 * worker-local vocabulary — the two surfaces describe the same underlying
 * search paths and a caller that talks to both should see one vocabulary.
 * Not imported from the edge package: worker and edge are separately built
 * services (Cloud Run vs Cloudflare Worker) with no shared runtime module
 * boundary today, so the values are duplicated here rather than coupling
 * the two builds. If they ever drift, that is a contract bug in whichever
 * side changed.
 */
const SEARCH_MODE_SEMANTIC = 'semantic_vector';
const SEARCH_MODE_LEXICAL = 'lexical_substring';

/** One row of the frozen v1 VerificationResult shape this route emits. */
interface VerificationSearchResult {
  verified: boolean;
  status: string;
  issuer_name?: string | null;
  credential_type?: string | null;
  issued_date?: string | null;
  expiry_date?: string | null;
  anchor_timestamp?: string;
  record_uri: string;
  similarity?: number;
}

interface SemanticEmbeddingRow {
  public_id: string;
  status: string;
  issuer_name: string | null;
  credential_type: string | null;
  issued_date: string | null;
  expiry_date: string | null;
  anchor_timestamp: string;
  similarity: number;
}

/** One row of `search_public_credentials`'s `jsonb_build_object(...)` shape. */
interface LexicalCredentialRow {
  public_id: string;
  title: string;
  credential_type: string | null;
  status: string;
  created_at: string;
  // org_id is present on the row but MUST NEVER be forwarded in a v1
  // response (CLAUDE.md §6) — deliberately not read below.
}

/**
 * Attempt the real semantic path: embed the query with the worker's Gemini
 * provider, then match via `search_public_credential_embeddings`.
 *
 * Returns `null` on ANY condition that means "semantic did not actually
 * run" (embedding threw, the RPC errored for any reason including the
 * function not existing yet) — logging a bounded warn reason so the
 * fallback is auditable, never silent. A zero-hit semantic response is NOT
 * null — that is a real answer and is returned as such (mirrors the edge's
 * documented distinction in mcp-tools.ts).
 */
async function trySemanticSearch(
  q: string,
  threshold: number,
  limit: number,
): Promise<VerificationSearchResult[] | null> {
  let queryEmbedding: { embedding: number[] };
  try {
    const provider = createAIProvider();
    queryEmbedding = await provider.generateEmbedding(q);
  } catch (err) {
    logger.warn(
      { reason: 'embedding_failed', message: err instanceof Error ? err.message : String(err) },
      'Verification search: query embedding failed, falling back to lexical search',
    );
    return null;
  }

  const { data: matches, error: searchError } = await callRpc<SemanticEmbeddingRow[]>(
    db,
    'search_public_credential_embeddings',
    {
      p_query_embedding: queryEmbedding.embedding,
      p_match_threshold: threshold,
      p_match_count: limit,
    },
  );

  if (searchError) {
    logger.warn(
      { reason: 'embedding_rpc_error', code: searchError.code, message: searchError.message },
      'Verification search: search_public_credential_embeddings RPC failed, falling back to lexical search',
    );
    return null;
  }

  return (matches ?? []).map((m) => ({
    verified: m.status === 'SECURED',
    status: m.status,
    issuer_name: m.issuer_name,
    credential_type: m.credential_type,
    issued_date: m.issued_date,
    expiry_date: m.expiry_date,
    anchor_timestamp: m.anchor_timestamp,
    record_uri: buildVerifyUrl(m.public_id),
    similarity: m.similarity,
  }));
}

/**
 * Lexical fallback via `search_public_credentials` — the same anon-callable
 * ILIKE substring RPC the edge falls back to (`services/edge/src/mcp-tools.ts`
 * `searchCredentialsFallback`). No embedding, no AI credit cost, no
 * similarity score: `issuer_name`, `issued_date`, `expiry_date` and
 * `anchor_timestamp` are omitted rather than backfilled from `created_at` —
 * `created_at` is not the Bitcoin-observed anchor time (§1.5) and this path
 * never queries it, so asserting it would misstate what was measured.
 *
 * Throws on RPC error; the caller (the route handler) owns turning that
 * into a 500 so a lexical failure is never mistaken for "0 results".
 */
async function runLexicalSearch(q: string, limit: number): Promise<VerificationSearchResult[]> {
  const { data: rows, error } = await callRpc<LexicalCredentialRow[]>(
    db,
    'search_public_credentials',
    { p_query: q, p_limit: limit },
  );

  if (error) {
    throw new Error(`search_public_credentials RPC failed: ${error.code ?? 'unknown'} ${error.message}`);
  }

  return (rows ?? []).map((row) => ({
    verified: row.status === 'SECURED',
    status: row.status,
    credential_type: row.credential_type,
    record_uri: buildVerifyUrl(row.public_id),
  }));
}

/** GET /api/v1/verify/search — Semantic verification search, lexical fallback */
router.get('/', async (req: Request, res: Response) => {
  // Require API key (not anonymous)
  if (!req.apiKey) {
    res.status(401).json({
      error: 'api_key_required',
      message: 'API key authentication required for verification search',
    });
    return;
  }

  const parsed = VerifySearchSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { q, threshold, limit } = parsed.data;
  const keyOrgId = req.apiKey.orgId;

  try {
    const semanticEnabled = await isSemanticSearchEnabled();
    let results: VerificationSearchResult[] | null = null;
    let mode: typeof SEARCH_MODE_SEMANTIC | typeof SEARCH_MODE_LEXICAL = SEARCH_MODE_LEXICAL;

    if (!semanticEnabled) {
      logger.warn(
        { reason: 'semantic_search_disabled' },
        'Verification search: ENABLE_SEMANTIC_SEARCH is off, serving lexical fallback',
      );
    } else {
      // Check credits for the API key's org — only the semantic path costs
      // an AI credit, so this gate applies only when we are about to
      // attempt it, not to the lexical fallback.
      const credits = keyOrgId ? await checkAICredits(keyOrgId) : null;
      if (credits && !credits.hasCredits) {
        res.status(402).json({
          error: 'insufficient_credits',
          message: 'No AI credits remaining.',
        });
        return;
      }

      const startMs = Date.now();
      const semanticResults = await trySemanticSearch(q, threshold, limit);

      if (semanticResults !== null) {
        results = semanticResults;
        mode = SEARCH_MODE_SEMANTIC;

        const durationMs = Date.now() - startMs;
        if (keyOrgId) {
          await deductAICredits(keyOrgId, undefined, 1);
        }
        logAIUsageEvent({
          orgId: keyOrgId,
          eventType: 'embedding',
          provider: createAIProvider().name,
          creditsConsumed: 1,
          durationMs,
          success: true,
        }).catch(() => {});
      }
      // semanticResults === null: trySemanticSearch already logged the
      // bounded warn reason. Fall through to the lexical path below —
      // never deduct a credit or log usage for a search that didn't run.
    }

    if (results === null) {
      results = await runLexicalSearch(q, limit);
      mode = SEARCH_MODE_LEXICAL;
    }

    res.json({
      query: q,
      results,
      count: results.length,
      threshold,
      search_mode: mode,
    });
  } catch (err) {
    logger.error({ error: err }, 'Agentic verification search failed');
    res.status(500).json({ error: 'search_failed', message: 'Internal error' });
  }
});

export { router as aiVerifySearchRouter, SEARCH_MODE_SEMANTIC, SEARCH_MODE_LEXICAL };
