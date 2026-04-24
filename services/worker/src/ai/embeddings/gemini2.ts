/**
 * Gemini Embedding 2 via Vertex AI — reference implementation (GEMB2-01)
 *
 * SCRUM-1050. This is the P0 unblocker for Gemini Golden eval iteration and
 * Nessie RAG recall work (GEMB2-02/03). The production `embeddings.ts` module
 * currently calls the older `gemini-embedding-001` endpoint via API key; this
 * file adds a Vertex-AI-authenticated Gemini Embedding 2 path that supports:
 *
 *   1. Matryoshka output truncation (3072 full → 1536 → 768 hot-path).
 *   2. US-only residency via explicit location parameter.
 *   3. Service-account auth (no raw API keys passed).
 *   4. Multimodal input (text today; PDF / image slots stubbed for follow-up).
 *
 * Wire-up path:
 *   - This module is *not* called from the production hot path yet.
 *   - `ENABLE_GEMB2` feature flag gates the switch-over in GEMB2-02.
 *   - Until the spike benchmark lands in Confluence, consumers stay on
 *     `embeddings.ts` / `gemini-embedding-001`.
 *
 * Constitution refs:
 *   - §1.4 — Service-account auth only. No raw API keys in client-reachable
 *     code paths. Credentials resolved via `google-auth-library` default
 *     chain → Cloud Run → Workload Identity.
 *   - §1.6 — Document bytes never cross the boundary to this module. Only
 *     PII-stripped structured metadata text + fingerprint.
 */

import { logger } from '../../utils/logger.js';

/**
 * Vertex AI location. US-only residency for all Arkova calls. CLAUDE.md §1.4
 * requires Arkova customer data stay in US; Vertex regional endpoints accept
 * data residency pinning via the `{location}-aiplatform.googleapis.com` host.
 */
export const GEMB2_LOCATION = 'us-central1';

/**
 * Model ID for Gemini Embedding 2. The `@` suffix pins the stable version —
 * Vertex silently rotates `latest` which is a non-starter for eval
 * reproducibility (past incident: Gemini Golden F1 dropped 3 pts overnight
 * after a silent rotate).
 */
export const GEMB2_MODEL = 'gemini-embedding-2@001';

/**
 * HTTP auth scheme for Vertex bearer tokens. Pulled out so the one call-site
 * doesn't hide a stringly-typed literal; keeps scheme changes (unlikely but
 * possible, e.g. regional GCP variants) auditable.
 */
const AUTH_SCHEME = 'Bearer';

/**
 * Follow-up: swap the standalone `Gemini2Client` below for a class that
 * implements `IAIProvider` (services/worker/src/ai/types.ts) so the factory
 * selects it via the `AI_PROVIDER` env var alongside the existing Gemini /
 * Cloudflare providers. Out of scope for the GEMB2-01 spike — lands with
 * GEMB2-02 (SCRUM-1051) when we also wire the RAG hot path over.
 */

/**
 * Matryoshka dimensions supported by Gemini Embedding 2. Caller picks one
 * per call; Vertex server truncates (and optionally re-normalizes) before
 * returning. Storage cost scales linearly with dim — always use the
 * smallest that meets the recall bar for the task.
 *
 * Calibration notes (pending Confluence benchmark page):
 *   - 768:  Nessie RAG hot-path retrieval; ~3.5x cheaper storage than 3072.
 *   - 1536: mid-tier when 768 recall falls short (re-evaluate per corpus).
 *   - 3072: full dimension for top-K re-rank + gemini-golden semantic scoring.
 */
export type GembDim = 768 | 1536 | 3072;

export interface EmbedRequest {
  /** UTF-8 text to embed. PII-stripped by caller. */
  text: string;
  /** Matryoshka output dim. Default 768 (hot path). */
  dim?: GembDim;
  /** Optional task-type hint passed to Vertex for embedding head selection. */
  taskType?:
    | 'RETRIEVAL_DOCUMENT'
    | 'RETRIEVAL_QUERY'
    | 'SEMANTIC_SIMILARITY'
    | 'CLASSIFICATION';
  /**
   * Optional abort signal. When it aborts, the in-flight Vertex call is
   * cancelled and `embed()` rejects with an `AbortError`. Matches the
   * pattern established by cc4767c on the sibling gemini.ts client — a
   * stalled Vertex response would otherwise hang callers indefinitely
   * because node's `fetch` has no default timeout.
   */
  signal?: AbortSignal;
}

export interface EmbedResponse {
  vector: number[];
  dim: GembDim;
  /** Vertex-side latency in ms, surfaced for observability. */
  latencyMs: number;
  /** Pinned model ID — echo back so callers can detect silent rotates. */
  model: string;
}

export interface Gemini2Client {
  embed(req: EmbedRequest): Promise<EmbedResponse>;
}

/**
 * Auth provider abstraction. Production uses GoogleAuth from
 * google-auth-library with the default credentials chain (Cloud Run metadata
 * service → Workload Identity). Tests inject a stub to avoid importing the
 * SDK during unit runs.
 */
export interface AuthProvider {
  /** Resolve a short-lived access token for the Vertex API audience. */
  getAccessToken(): Promise<string>;
}

/**
 * HTTP fetch abstraction. Defaults to global `fetch`. Tests override to assert
 * request shape + return canned bytes without a network hop.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Gemini2ClientOptions {
  /** GCP project ID. Defaults to `GCP_PROJECT_ID` env var. */
  projectId?: string;
  /** Vertex location. Must remain US-pinned — see GEMB2_LOCATION. */
  location?: string;
  /** Model ID override for canary / A-B testing. */
  model?: string;
  auth: AuthProvider;
  fetch?: FetchLike;
  /**
   * Default timeout in ms for any embed() call that doesn't pass its own
   * `signal`. Matches gemini.ts (cc4767c) at 30_000. Set to 0 to disable.
   */
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createGemini2Client(opts: Gemini2ClientOptions): Gemini2Client {
  const projectId = opts.projectId ?? process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error(
      'GEMB2: projectId missing. Set GCP_PROJECT_ID env var or pass opts.projectId.',
    );
  }
  const location = opts.location ?? GEMB2_LOCATION;
  if (location !== GEMB2_LOCATION) {
    // Hard gate — US-only residency. If a future region rollout happens,
    // update GEMB2_LOCATION and the Confluence residency page in the same PR.
    throw new Error(
      `GEMB2: location must be ${GEMB2_LOCATION} for US-only residency; got ${location}.`,
    );
  }
  const model = opts.model ?? GEMB2_MODEL;
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const endpoint =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
    `/locations/${location}/publishers/google/models/${model}:predict`;

  async function embed(req: EmbedRequest): Promise<EmbedResponse> {
    if (!req.text || !req.text.trim()) {
      throw new Error('GEMB2: text is empty.');
    }
    const dim: GembDim = req.dim ?? 768;
    if (![768, 1536, 3072].includes(dim)) {
      throw new Error(`GEMB2: unsupported dim ${dim}. Allowed: 768 | 1536 | 3072.`);
    }

    const token = await opts.auth.getAccessToken();
    if (!token) {
      throw new Error('GEMB2: auth provider returned empty access token.');
    }

    const body = {
      instances: [
        {
          content: req.text,
          task_type: req.taskType ?? 'RETRIEVAL_DOCUMENT',
        },
      ],
      parameters: {
        outputDimensionality: dim,
        autoTruncate: true,
      },
    };

    // If the caller didn't pass a signal but defaultTimeoutMs > 0, install a
    // timeout controller so a hung Vertex call can't stall the worker. When
    // defaultTimeoutMs = 0 the call runs without a bound (caller's problem).
    let timeoutController: AbortController | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let effectiveSignal: AbortSignal | undefined = req.signal;
    if (!effectiveSignal && defaultTimeoutMs > 0) {
      timeoutController = new AbortController();
      effectiveSignal = timeoutController.signal;
      timeoutHandle = setTimeout(
        () => timeoutController?.abort(),
        defaultTimeoutMs,
      );
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `${AUTH_SCHEME} ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: effectiveSignal,
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error(
        { status: res.status, latencyMs, detail: detail.slice(0, 500) },
        'GEMB2: Vertex predict call failed',
      );
      throw new Error(`GEMB2: Vertex responded ${res.status}`);
    }

    const parsed = (await res.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };
    const values = parsed.predictions?.[0]?.embeddings?.values;
    if (!Array.isArray(values) || values.length !== dim) {
      logger.error(
        { gotLength: values?.length, expectedDim: dim },
        'GEMB2: response shape mismatch',
      );
      throw new Error(
        `GEMB2: expected ${dim} dimensions, got ${values?.length ?? 'undefined'}`,
      );
    }

    return { vector: values, dim, latencyMs, model };
  }

  return { embed };
}
