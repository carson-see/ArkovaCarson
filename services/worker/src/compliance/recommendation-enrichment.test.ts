/**
 * NCA-FU1 item #4 — Nessie contextual recommendation enrichment.
 */

import { describe, expect, it, vi } from 'vitest';
import { enrichRecommendationsWithNessie } from './recommendation-enrichment.js';
import { buildRecommendations } from './recommendation-engine.js';
import type { AuditGap } from './org-audit.js';

function gap(partial: Partial<AuditGap> = {}): AuditGap {
  return {
    type: partial.type ?? 'LICENSE',
    category: partial.category ?? 'MISSING',
    requirement: partial.requirement ?? 'Required: LICENSE',
    jurisdiction_code: partial.jurisdiction_code ?? 'US-CA',
    industry_code: partial.industry_code ?? 'accounting',
    regulatory_reference: partial.regulatory_reference ?? 'Cal. Bus. & Prof. Code §5051',
    severity: partial.severity ?? 'high',
    remediation_hint: partial.remediation_hint ?? 'Upload the issued license.',
    days_remaining: partial.days_remaining,
    anchor_id: partial.anchor_id,
  };
}

describe('NCA-FU1 enrichRecommendationsWithNessie', () => {
  it('returns the static result unchanged when there are no recommendations', async () => {
    const base = buildRecommendations({ gaps: [] });
    const rag = vi.fn();
    const out = await enrichRecommendationsWithNessie({ result: base, gaps: [], rag });
    expect(out).toBe(base);
    expect(rag).not.toHaveBeenCalled();
  });

  it('rewrites descriptions from Nessie JSON response and preserves ids', async () => {
    const base = buildRecommendations({ gaps: [gap()] });
    const first = base.recommendations[0];
    const rag = vi.fn().mockResolvedValue({
      text: JSON.stringify([
        { id: first.id, description: 'Under Cal. Bus. & Prof. Code §5051 you must upload the active license for US-CA accounting before filings resume.' },
      ]),
    });
    const out = await enrichRecommendationsWithNessie({ result: base, gaps: [gap()], rag });
    expect(out.recommendations[0].id).toBe(first.id);
    expect(out.recommendations[0].description).toContain('§5051');
    expect(out.recommendations[0].description).toContain('US-CA');
    expect(rag).toHaveBeenCalledTimes(1);
  });

  it('falls back to static descriptions when Nessie throws', async () => {
    const base = buildRecommendations({ gaps: [gap()] });
    const rag = vi.fn().mockRejectedValue(new Error('circuit open'));
    const out = await enrichRecommendationsWithNessie({ result: base, gaps: [gap()], rag });
    expect(out.recommendations[0].description).toBe(base.recommendations[0].description);
  });

  it('falls back when Nessie returns non-JSON text', async () => {
    const base = buildRecommendations({ gaps: [gap()] });
    const rag = vi.fn().mockResolvedValue({ text: 'I cannot answer that.' });
    const out = await enrichRecommendationsWithNessie({ result: base, gaps: [gap()], rag });
    expect(out.recommendations[0].description).toBe(base.recommendations[0].description);
  });

  it('falls back when Nessie returns suspiciously short prose (<20 chars)', async () => {
    const base = buildRecommendations({ gaps: [gap()] });
    const first = base.recommendations[0];
    const rag = vi.fn().mockResolvedValue({
      text: JSON.stringify([{ id: first.id, description: 'do it' }]),
    });
    const out = await enrichRecommendationsWithNessie({ result: base, gaps: [gap()], rag });
    expect(out.recommendations[0].description).toBe(first.description);
  });

  it('times out and falls back if Nessie blocks past timeoutMs', async () => {
    const base = buildRecommendations({ gaps: [gap()] });
    const rag = vi.fn().mockImplementation(() => new Promise(() => { /* never */ }));
    const start = Date.now();
    const out = await enrichRecommendationsWithNessie({
      result: base,
      gaps: [gap()],
      rag,
      timeoutMs: 50,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
    expect(out.recommendations[0].description).toBe(base.recommendations[0].description);
  });

  it('clears the timeout timer when the RAG call wins the race', async () => {
    const base = buildRecommendations({ gaps: [gap()] });
    const first = base.recommendations[0];
    const rag = vi.fn().mockResolvedValue({
      text: JSON.stringify([{ id: first.id, description: 'Grounded description that is long enough to pass the floor.' }]),
    });
    const setSpy = vi.spyOn(global, 'setTimeout');
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    try {
      await enrichRecommendationsWithNessie({
        result: base,
        gaps: [gap()],
        rag,
        timeoutMs: 10_000,
      });
      expect(setSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('regroups enriched recommendations into the same group buckets', async () => {
    const base = buildRecommendations({
      gaps: [
        gap({ severity: 'critical', category: 'EXPIRED' }),
        gap({ severity: 'medium', category: 'EXPIRING_SOON', days_remaining: 14 }),
      ],
    });
    const ids = base.recommendations.map((r) => r.id);
    const rag = vi.fn().mockResolvedValue({
      text: JSON.stringify(ids.map((id) => ({ id, description: `Contextual description that is sufficiently long for ${id}.` }))),
    });
    const out = await enrichRecommendationsWithNessie({
      result: base,
      gaps: [gap({ severity: 'critical', category: 'EXPIRED' }), gap({ severity: 'medium', category: 'EXPIRING_SOON', days_remaining: 14 })],
      rag,
    });
    expect(out.grouped.critical.length).toBe(base.grouped.critical.length);
    expect(out.grouped.upcoming.length).toBe(base.grouped.upcoming.length);
    expect(out.grouped.critical.every((r) => r.description.startsWith('Contextual description'))).toBe(true);
  });

  it('tolerates Nessie responses that wrap JSON in a prose preamble', async () => {
    const base = buildRecommendations({ gaps: [gap()] });
    const first = base.recommendations[0];
    const rag = vi.fn().mockResolvedValue({
      text: `Here is the array you requested:\n[{"id":"${first.id}","description":"Under Cal. Bus. & Prof. Code §5051 the US-CA license must be reissued within 30 days."}]`,
    });
    const out = await enrichRecommendationsWithNessie({ result: base, gaps: [gap()], rag });
    expect(out.recommendations[0].description).toContain('§5051');
  });
});
