/**
 * Tests for the PR #2525 soak driver.
 *
 * The driver decides what counts as merge-grade evidence for the attestation
 * park, so its own failure modes are evidence-integrity bugs: a row written
 * `status: 'pass', evidenceForSoak: true` that observed nothing, or a `fail`
 * row blamed on the application when Cloud Run refused the request, both make
 * a 12h window worthless. These pin the three ways that happened.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  classify,
  isInfraAbort,
  resolveBurst,
  runLive,
  type Probe,
} from './pr2525-attestation-park-driver.js';

const INFRA: Probe = {
  status: 500,
  body: 'The request was aborted because there was no available instance.',
  rateLimited: false,
};
const GOOD_WF: Probe = {
  status: 404,
  body: '{"verified":false,"error":"…not implemented…"}',
  rateLimited: true,
};
const GOOD_MF: Probe = {
  status: 400,
  body: '{"error":"Invalid attestation ID format — expected ARK-ATT-* prefix"}',
  rateLimited: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classify', () => {
  it('passes the correct parked shape', () => {
    expect(classify(GOOD_WF, GOOD_MF).status).toBe('pass');
  });

  it('fails the pre-park shape (501 + "not found")', () => {
    const v = classify({ status: 501, body: '{"error":"Attestation not found"}' }, { status: 501, body: '{}' });
    expect(v.status).toBe('fail');
  });

  it('does not blame the application for an infra-aborted well-formed probe', () => {
    const v = classify(INFRA, GOOD_MF);
    expect(v.counts.anyFivexx).toBe(false);
    expect(v.blockers.join(' ')).not.toMatch(/expected 404/);
  });

  it('does not report a lost ARK-ATT routing hint when the malformed probe was refused by infra', () => {
    // An infra abort body has no ARK-ATT in it, but that says nothing about
    // the 400 contract — the container never saw the request.
    const v = classify(GOOD_WF, INFRA);
    expect(v.blockers.join(' ')).not.toMatch(/routing hint/);
    expect(v.status).toBe('pass');
  });

  it('still reports a genuinely lost routing hint', () => {
    const v = classify(GOOD_WF, { status: 400, body: '{"error":"bad id"}', rateLimited: true });
    expect(v.blockers.join(' ')).toMatch(/routing hint/);
    expect(v.status).toBe('fail');
  });

  it('fails when the parked response carries no X-RateLimit-* headers', () => {
    // §1.10 says headers on every response. A park mounted above the rate
    // limiters drops them and takes a public endpoint off its budget — the
    // regression this soak has to be able to see, not just the unit tests.
    const v = classify({ ...GOOD_WF, rateLimited: false }, GOOD_MF);
    expect(v.status).toBe('fail');
    expect(v.blockers.join(' ')).toMatch(/rate.?limit/i);
  });

  it('does not demand rate-limit headers from a probe the application never answered', () => {
    expect(classify(INFRA, GOOD_MF).blockers.join(' ')).not.toMatch(/rate.?limit/i);
  });
});

describe('resolveBurst', () => {
  it('defaults when unset', () => {
    expect(resolveBurst(undefined)).toBe(8);
  });

  it.each([0, -3, NaN, 1.5, Infinity])('rejects %s and falls back to the default', (n) => {
    expect(resolveBurst(n)).toBe(8);
  });

  it('honours a valid burst', () => {
    expect(resolveBurst(4)).toBe(4);
  });
});

describe('runLive', () => {
  /** Stubs global fetch; `responses` is consumed in call order. */
  function stubFetch(responses: Array<Probe | Error>) {
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return {
        status: r.status,
        text: async () => r.body,
        headers: { get: (h: string) => (r.rateLimited && h.toLowerCase() === 'x-ratelimit-limit' ? '100' : null) },
      } as unknown as Response;
    }));
  }

  it('classifies against an OBSERVED probe, not whichever one happened to be first', async () => {
    // bursts[0] refused by Cloud Run, the rest are correct 404s. The cycle DID
    // observe the endpoint; it must not skip every check and record a pass
    // that verified nothing.
    stubFetch([INFRA, GOOD_WF, GOOD_WF, GOOD_WF, GOOD_MF]);

    const row = await runLive({ mode: 'live', targetUrl: 'https://rig.example', burst: 4 });

    expect(row.status).toBe('pass');
    expect(row.counts.wellFormedStatus).toBe(404);
    expect(row.counts.burstObserved).toBe(3);
  });

  it('fails the cycle when bursts[0] is infra and the observed probes are wrong', async () => {
    stubFetch([INFRA, { status: 200, body: '{}', rateLimited: true }, { status: 200, body: '{}', rateLimited: true }, GOOD_MF]);

    const row = await runLive({ mode: 'live', targetUrl: 'https://rig.example', burst: 3 });

    expect(row.status).toBe('fail');
    expect(row.blockers?.join(' ')).toMatch(/expected 404/);
  });

  it('fails, rather than throwing, when the rig is unreachable', async () => {
    // A thrown fetch used to escape runLive and abort main() before the JSONL
    // append — so a down rig produced NO row, which reads as an uninterrupted
    // healthy window.
    stubFetch([new Error('ECONNREFUSED')]);

    const row = await runLive({ mode: 'live', targetUrl: 'https://rig.example', burst: 2 });

    expect(row.status).toBe('fail');
    expect(row.counts.anyFivexx).toBe(false);
    expect(row.blockers?.join(' ')).toMatch(/unreachable|transport/i);
  });

  it('fails a cycle where every burst request was refused', async () => {
    stubFetch([INFRA]);

    const row = await runLive({ mode: 'live', targetUrl: 'https://rig.example', burst: 3 });

    expect(row.status).toBe('fail');
    expect(row.blockers?.join(' ')).toMatch(/observed nothing/);
  });
});

describe('isInfraAbort', () => {
  it('recognises the Cloud Run refusal', () => {
    expect(isInfraAbort(INFRA)).toBe(true);
  });

  it('does not treat an application 500 as infra', () => {
    expect(isInfraAbort({ status: 500, body: '{"error":"Internal server error"}', rateLimited: true })).toBe(false);
  });

  it('does not treat a transport failure as infra', () => {
    expect(isInfraAbort({ status: 0, body: 'ECONNREFUSED', rateLimited: false })).toBe(false);
  });
});
