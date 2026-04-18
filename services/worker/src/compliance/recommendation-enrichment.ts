/**
 * Nessie Contextual Recommendation Enrichment.
 *
 * Turns the static `remediation_hint` descriptions emitted by the
 * recommendation engine into contextual prose written by Nessie Intelligence,
 * grounded in the active jurisdiction + rule citations.
 *
 * NVI: Nessie training data has not yet been attorney-reviewed, so customer-
 * facing recommendation prose is flag-gated in production by
 * `ENABLE_NESSIE_RAG_RECOMMENDATIONS`. Once the Opus-judge benchmark passes,
 * the flag can default on.
 *
 * Design: pure orchestrator with an injected RAG fn so tests stay sync. One
 * batch prompt per audit caps latency to a single Nessie round-trip. Any
 * error, cold start, or unparseable response falls back to static descriptions.
 */

import type { BuildRecommendationsResult, Recommendation } from './recommendation-engine.js';
import type { AuditGap } from './org-audit.js';

export interface NessieRagFn {
  (systemPrompt: string, userPrompt: string): Promise<{ text: string }>;
}

export interface EnrichRecommendationsInput {
  result: BuildRecommendationsResult;
  gaps: AuditGap[];
  rag: NessieRagFn;
  /** Hard cap on the Nessie call — default 4000ms. */
  timeoutMs?: number;
  /** Dependency-injected clock for deterministic tests. */
  now?: () => number;
}

interface NessieDescription {
  id: string;
  description: string;
}

const SYSTEM_PROMPT =
  'You are Arkova Nessie, a compliance intelligence assistant. You receive a ' +
  'JSON array of recommendations and their associated gaps. For each ' +
  'recommendation, rewrite the `description` field as a grounded, 1–2 sentence ' +
  'action paragraph that mentions the specific jurisdiction, the cited ' +
  'regulation when present, and the concrete next step. Do NOT invent statutes ' +
  'or case law. Preserve the recommendation `id`. Respond with a JSON array of ' +
  '{ id, description } only.';

export async function enrichRecommendationsWithNessie(
  input: EnrichRecommendationsInput,
): Promise<BuildRecommendationsResult> {
  if (input.result.recommendations.length === 0) return input.result;

  const userPrompt = buildUserPrompt(input.result.recommendations, input.gaps);
  const timeoutMs = input.timeoutMs ?? 4000;

  let text: string;
  try {
    const ragCall = input.rag(SYSTEM_PROMPT, userPrompt);
    const timeoutGuard = new Promise<{ text: string }>((_, reject) => {
      setTimeout(() => reject(new Error('nessie-enrich-timeout')), timeoutMs);
    });
    const response = await Promise.race([ragCall, timeoutGuard]);
    text = response.text;
  } catch {
    // Timeout, circuit-breaker, cold start — keep the static descriptions.
    return input.result;
  }

  const parsed = parseNessieDescriptions(text);
  if (!parsed || parsed.length === 0) return input.result;

  const byId = new Map(parsed.map((d) => [d.id, d.description]));
  const enriched = input.result.recommendations.map((r) => enrichOne(r, byId));

  return {
    recommendations: enriched,
    overflow_count: input.result.overflow_count,
    grouped: {
      quick_wins: enriched.filter((r) => r.group === 'QUICK_WIN'),
      critical: enriched.filter((r) => r.group === 'CRITICAL'),
      upcoming: enriched.filter((r) => r.group === 'UPCOMING'),
      standard: enriched.filter((r) => r.group === 'STANDARD'),
    },
  };
}

function enrichOne(
  rec: Recommendation,
  byId: Map<string, string>,
): Recommendation {
  const next = byId.get(rec.id);
  if (!next || next.trim().length === 0) return rec;
  // Never let Nessie wipe out the original hint if it returns suspiciously
  // short prose — fall back below a 20-char floor.
  if (next.trim().length < 20) return rec;
  return { ...rec, description: next.trim() };
}

function buildUserPrompt(recs: Recommendation[], gaps: AuditGap[]): string {
  const gapsById = new Map<string, AuditGap[]>();
  for (const g of gaps) {
    const key = `${g.jurisdiction_code}::${g.type}::${g.category}`;
    const bucket = gapsById.get(key) ?? [];
    bucket.push(g);
    gapsById.set(key, bucket);
  }
  const payload = recs.map((r) => {
    const relatedGaps = r.gap_keys
      .map((k) => (gapsById.get(k) ?? [])[0])
      .filter((g): g is AuditGap => Boolean(g));
    return {
      id: r.id,
      title: r.title,
      static_description: r.description,
      affected_jurisdictions: r.affected_jurisdictions,
      severity: r.severity,
      gaps: relatedGaps.map((g) => ({
        type: g.type,
        category: g.category,
        requirement: g.requirement,
        regulatory_reference: g.regulatory_reference,
      })),
    };
  });
  return JSON.stringify(payload);
}

// Nessie returns either a raw JSON array or JSON wrapped in a prose preamble.
// Tolerate both shapes; reject anything else.
/**
 * Lazily instantiated Nessie client. Hoisted out of the request handler so
 * each /compliance/audit call reuses the same provider + circuit-breaker
 * state instead of constructing a new one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedProvider: { generateRAGResponse(system: string, user: string): Promise<{ text: string; tokensUsed?: number }> } | null = null;

async function getProvider() {
  if (cachedProvider) return cachedProvider;
  const { NessieProvider } = await import('../ai/nessie.js');
  cachedProvider = new NessieProvider();
  return cachedProvider;
}

/**
 * Wrapper used by the /compliance/audit route. Respects the
 * `ENABLE_NESSIE_RAG_RECOMMENDATIONS` flag, short-circuits when there are no
 * recommendations to enrich, and swallows every provider error (Nessie is
 * never allowed to break an audit response).
 */
export async function maybeEnrichWithNessieProvider(
  result: BuildRecommendationsResult,
  gaps: AuditGap[],
): Promise<BuildRecommendationsResult> {
  if (process.env.ENABLE_NESSIE_RAG_RECOMMENDATIONS !== 'true') return result;
  if (result.recommendations.length === 0) return result;
  try {
    const provider = await getProvider();
    return await enrichRecommendationsWithNessie({
      result,
      gaps,
      rag: (system, user) => provider.generateRAGResponse(system, user),
    });
  } catch {
    return result;
  }
}

function parseNessieDescriptions(text: string): NessieDescription[] | null {
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket <= firstBracket) return null;
  const jsonSlice = text.slice(firstBracket, lastBracket + 1);
  try {
    const value: unknown = JSON.parse(jsonSlice);
    if (!Array.isArray(value)) return null;
    const out: NessieDescription[] = [];
    for (const row of value) {
      if (
        row &&
        typeof row === 'object' &&
        typeof (row as Record<string, unknown>).id === 'string' &&
        typeof (row as Record<string, unknown>).description === 'string'
      ) {
        out.push({
          id: (row as { id: string }).id,
          description: (row as { description: string }).description,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}
