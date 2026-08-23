/**
 * Nessie capability gate — BUG-008 / BUG-027 (CTO ruling R-1 STRENGTHENED).
 *
 * The defect this pins: `/api/v1/nessie/query` was mounted unconditionally and
 * answered **HTTP 200 with a success-shaped body** (`{"results":[],"count":0}`)
 * for a capability that is permanently disabled by standing founder directive.
 * A caller could not tell "this feature is off" from "the feature ran and found
 * nothing" — the fail-open pattern §1.13 R-7 exists to prevent.
 *
 * The contract asserted here is therefore not merely "returns non-200". It is:
 * a disabled response must be STRUCTURALLY distinguishable from an empty
 * result. It carries `enabled: false` and carries NONE of the success-shape
 * keys (`results` / `count` / `answer` / `confidence` / `citations`).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { enableNessieQuery: false } as { enableNessieQuery: boolean },
}));

vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from 'supertest';
import {
  NESSIE_DISABLED_CODE,
  isNessieQueryEnabled,
  nessieCapabilityGate,
  nessieDisabledBody,
} from './nessieCapabilityGate.js';

/** Keys that mean "the capability ran and produced a result". */
const SUCCESS_SHAPE_KEYS = ['results', 'count', 'answer', 'confidence', 'citations'];

function buildApp() {
  const app = express();
  app.use(
    '/nessie/query',
    nessieCapabilityGate(),
    // Stand-in for the real router. If the gate ever fails open, this 200
    // success-shaped body is exactly what a caller would receive.
    (_req, res) => {
      res.json({ results: [], count: 0, query: 'q' });
    },
  );
  return app;
}

beforeEach(() => {
  mockConfig.enableNessieQuery = false;
});

describe('nessieCapabilityGate — fails CLOSED by default', () => {
  it('defaults to disabled when ENABLE_NESSIE_QUERY is unset (permanently-off capability)', () => {
    expect(isNessieQueryEnabled()).toBe(false);
  });

  it('blocks the request with 503 rather than letting the router answer 200', async () => {
    const res = await request(buildApp()).get('/nessie/query?q=anything');
    expect(res.status).toBe(503);
  });

  it('emits an EXPLICIT disabled body — enabled:false plus a stable machine code', async () => {
    const res = await request(buildApp()).get('/nessie/query?q=anything');

    expect(res.body).toMatchObject({
      error: 'capability_disabled',
      code: NESSIE_DISABLED_CODE,
      capability: 'nessie',
      enabled: false,
    });
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  /**
   * THE regression test for BUG-008/027. Before this gate, "disabled" and
   * "found nothing" were the same 200 `{results:[],count:0}` payload.
   */
  it('is DISTINGUISHABLE from an empty result — carries no success-shape key', async () => {
    const disabled = await request(buildApp()).get('/nessie/query?q=anything');

    for (const key of SUCCESS_SHAPE_KEYS) {
      expect(disabled.body).not.toHaveProperty(key);
    }

    // And the enabled path (the stand-in router below the gate) still produces
    // the success shape — so the two are separable on BOTH status and body.
    mockConfig.enableNessieQuery = true;
    const empty = await request(buildApp()).get('/nessie/query?q=anything');

    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ results: [], count: 0 });
    expect(empty.body).not.toHaveProperty('enabled');
    expect(disabled.status).not.toBe(empty.status);
  });

  it('passes the request through when the capability is explicitly enabled', async () => {
    mockConfig.enableNessieQuery = true;
    const res = await request(buildApp()).get('/nessie/query?q=anything');
    expect(res.status).toBe(200);
  });
});

describe('nessieDisabledBody — shared envelope', () => {
  it('never contains a success-shape key (the envelope itself is the guarantee)', () => {
    const body = nessieDisabledBody() as Record<string, unknown>;
    for (const key of SUCCESS_SHAPE_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.enabled).toBe(false);
  });

  it('returns a fresh object so a caller cannot mutate the shared envelope', () => {
    const a = nessieDisabledBody() as Record<string, unknown>;
    a.enabled = true;
    expect((nessieDisabledBody() as Record<string, unknown>).enabled).toBe(false);
  });
});
