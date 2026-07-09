/**
 * integration.test.ts — end-to-end wiring of the eval path against a STUB worker
 * (no real network). Proves: build payload → HTTP extract → map fields → score →
 * gate verdict, using the real vendored golden set + scorer.
 *
 * A "perfect" stub that echoes ground truth must PASS the SCRUM-2382 gate; a
 * "mock-provider" stub must be caught by certifyRound under --require-live.
 */
import { describe, it, expect } from 'vitest';

import { gateGoldenEntries } from './golden.js';
import { callAiEndpoint, type FetchLike, type WorkerIdentity } from './ai-client.js';
import {
  buildExtractPayload,
  fieldsFromExtractResponse,
  scoreEntry,
  buildEvalRecord,
  certifyRound,
  providerFromBody,
} from './eval-core.js';
import type { EntryEvalResult } from './scoring.js';

const ID: WorkerIdentity = { label: 'u', jwt: 'eyJ.a.b' };

/** Stub worker: returns the entry's ground-truth fields as the "extraction". */
function perfectWorker(provider: string): FetchLike {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { strippedText: string; credentialType: string };
    // The golden set text encodes the id; recover ground truth by matching text.
    const entry = gateGoldenEntries().find((e) => e.strippedText === body.strippedText)!;
    const fields = Object.fromEntries(
      Object.entries(entry.groundTruth).filter(([, v]) => v !== undefined),
    );
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ fields, confidence: 0.95, provider }),
    };
  }) as unknown as FetchLike;
}

async function runRoundWith(fetchImpl: FetchLike): Promise<{ scored: EntryEvalResult[]; providers: Set<string> }> {
  const scored: EntryEvalResult[] = [];
  const providers = new Set<string>();
  for (const entry of gateGoldenEntries()) {
    const outcome = await callAiEndpoint('https://pr-1---x.run.app', 'extract', buildExtractPayload(entry), ID, fetchImpl);
    providers.add(providerFromBody(outcome.body));
    scored.push(
      outcome.ok
        ? scoreEntry(entry, fieldsFromExtractResponse(outcome.body))
        : scoreEntry(entry, {}, `HTTP ${outcome.status}`),
    );
  }
  return { scored, providers };
}

describe('end-to-end eval against a perfect stub worker', () => {
  it('passes the SCRUM-2382 gate at weighted F1 = 1 when extraction echoes ground truth', async () => {
    const { scored, providers } = await runRoundWith(perfectWorker('gemini'));
    const record = buildEvalRecord({ sampledAt: 't', apiBase: 'x', provider: 'gemini', scored });
    expect(record.gate.matchingEntries).toBe(48);
    expect(record.gate.passed).toBe(true);
    expect(record.gate.weightedF1).toBe(1);
    expect(record.perField.creditHours.f1).toBe(1);
    expect(record.extractionErrorCount).toBe(0);
    expect(certifyRound(record, providers, true).merited).toBe(true);
  });

  it('refuses merge-grade certification when the stub reports the mock provider', async () => {
    const { scored, providers } = await runRoundWith(perfectWorker('mock'));
    const record = buildEvalRecord({ sampledAt: 't', apiBase: 'x', provider: 'mock', scored });
    // Gate still "passes" on echoed truth, but --require-live blocks certification.
    expect(record.gate.passed).toBe(true);
    const cert = certifyRound(record, providers, true);
    expect(cert.merited).toBe(false);
    expect(cert.notes.join(' ')).toMatch(/GEMINI_API_KEY/);
  });

  it('surfaces extraction errors when the worker 503s (gate fails, not silently 0)', async () => {
    const failing = (async () => ({
      status: 503, ok: false, headers: { get: () => null },
      text: async () => JSON.stringify({ error: 'service_unavailable' }),
    })) as unknown as FetchLike;
    const { scored } = await runRoundWith(failing);
    const record = buildEvalRecord({ sampledAt: 't', apiBase: 'x', provider: 'unknown', scored });
    expect(record.extractionErrorCount).toBe(48);
    expect(record.gate.passed).toBe(false);
  });
});
