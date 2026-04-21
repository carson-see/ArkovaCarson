/**
 * MCP origin-allowlist gate tests — MCP-SEC-08 / SCRUM-985.
 *
 * Pure function tests — every branch of `computeAllowlistDecision`
 * exercised. KV is injected via a fake `env.MCP_ORIGIN_ALLOWLIST_KV`
 * in the `enforceOriginAllowlist` tests.
 */

import { describe, expect, it } from 'vitest';

// @ts-nocheck — edge source is outside worker rootDir; Vitest resolves at runtime
import {
  computeAllowlistDecision,
  enforceOriginAllowlist,
  ipInCidr,
  allowlistDecisionToResponse,
  type AllowlistEntry,
  type AllowlistRequest,
} from '../../edge/src/mcp-origin-allowlist.js';

function makeReq(over: Partial<AllowlistRequest> = {}): AllowlistRequest {
  return { clientIp: '10.0.0.5', origin: 'https://agent.example.com', cfBotVerdict: null, ...over };
}

describe('ipInCidr', () => {
  it('accepts wildcard 0.0.0.0/0', () => {
    expect(ipInCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });
  it('accepts a matching /24', () => {
    expect(ipInCidr('10.0.0.5', '10.0.0.0/24')).toBe(true);
  });
  it('rejects a non-matching /24', () => {
    expect(ipInCidr('10.0.1.5', '10.0.0.0/24')).toBe(false);
  });
  it('rejects malformed CIDR', () => {
    expect(ipInCidr('10.0.0.5', 'not-a-cidr')).toBe(false);
  });
  it('accepts exact-match /32', () => {
    expect(ipInCidr('192.168.1.1', '192.168.1.1/32')).toBe(true);
  });
});

describe('computeAllowlistDecision — no entry', () => {
  it('defaults to challenge when no entry is stored', () => {
    const result = computeAllowlistDecision(null, makeReq());
    expect(result).toEqual({ ok: false, reason: 'challenge', retryable: true });
  });
});

describe('computeAllowlistDecision — deny mode', () => {
  it('rejects immediately', () => {
    const entry: AllowlistEntry = { mode: 'deny' };
    const result = computeAllowlistDecision(entry, makeReq());
    expect(result).toEqual({ ok: false, reason: 'rejected', retryable: false });
  });
});

describe('computeAllowlistDecision — allowlist mode', () => {
  it('accepts when IP is in a listed CIDR', () => {
    const entry: AllowlistEntry = { mode: 'allowlist', cidrs: ['10.0.0.0/24'] };
    const result = computeAllowlistDecision(entry, makeReq({ clientIp: '10.0.0.5' }));
    expect(result.ok).toBe(true);
  });

  it('accepts when origin is in the listed origins', () => {
    const entry: AllowlistEntry = {
      mode: 'allowlist',
      origins: ['https://agent.example.com'],
    };
    const result = computeAllowlistDecision(entry, makeReq());
    expect(result.ok).toBe(true);
  });

  it('rejects when neither IP nor origin match', () => {
    const entry: AllowlistEntry = {
      mode: 'allowlist',
      cidrs: ['172.16.0.0/12'],
      origins: ['https://other.example.com'],
    };
    const result = computeAllowlistDecision(entry, makeReq());
    expect(result).toEqual({ ok: false, reason: 'rejected', retryable: false });
  });

  it('challenges when neither cidrs nor origins are configured', () => {
    const entry: AllowlistEntry = { mode: 'allowlist' };
    const result = computeAllowlistDecision(entry, makeReq());
    expect(result.reason).toBe('challenge');
  });

  it('accepts wildcard CIDR as explicit_wildcard', () => {
    const entry: AllowlistEntry = { mode: 'allowlist', cidrs: ['0.0.0.0/0'] };
    const result = computeAllowlistDecision(entry, makeReq());
    expect(result).toEqual({ ok: true, reason: 'explicit_wildcard' });
  });

  it('challenges when bot-verdict is required and not in the acceptable list', () => {
    const entry: AllowlistEntry = {
      mode: 'allowlist',
      origins: ['https://agent.example.com'],
      requireBotVerdict: true,
      acceptableVerdicts: ['LIKELY_HUMAN'],
    };
    const result = computeAllowlistDecision(entry, makeReq({ cfBotVerdict: 'LIKELY_AUTOMATED' }));
    expect(result.reason).toBe('challenge');
  });

  it('accepts when bot-verdict matches', () => {
    const entry: AllowlistEntry = {
      mode: 'allowlist',
      origins: ['https://agent.example.com'],
      requireBotVerdict: true,
      acceptableVerdicts: ['VERIFIED_BOT'],
    };
    const result = computeAllowlistDecision(entry, makeReq({ cfBotVerdict: 'VERIFIED_BOT' }));
    expect(result.ok).toBe(true);
  });
});

describe('computeAllowlistDecision — challenge mode', () => {
  it('accepts when IP matches', () => {
    const entry: AllowlistEntry = { mode: 'challenge', cidrs: ['10.0.0.0/24'] };
    const result = computeAllowlistDecision(entry, makeReq());
    expect(result.ok).toBe(true);
  });

  it('challenges when nothing matches', () => {
    const entry: AllowlistEntry = { mode: 'challenge', cidrs: ['192.168.0.0/16'] };
    const result = computeAllowlistDecision(entry, makeReq());
    expect(result.reason).toBe('challenge');
  });
});

describe('enforceOriginAllowlist', () => {
  function makeEnv(entries: Record<string, AllowlistEntry>): {
    MCP_ORIGIN_ALLOWLIST_KV: {
      get: (k: string) => Promise<string | null>;
    };
  } {
    return {
      MCP_ORIGIN_ALLOWLIST_KV: {
        get: async (k: string) => {
          const e = entries[k];
          return e ? JSON.stringify(e) : null;
        },
      },
    };
  }

  it('passes through when KV binding is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await enforceOriginAllowlist({} as any, 'key-1', makeReq());
    expect(result).toEqual({ ok: true, reason: 'no_kv_binding' });
  });

  it('passes through when api key is null', async () => {
    const env = makeEnv({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await enforceOriginAllowlist(env as any, null, makeReq());
    expect(result.ok).toBe(true);
  });

  it('loads the KV entry and applies the decision', async () => {
    const env = makeEnv({
      'allow:key-1': { mode: 'allowlist', cidrs: ['10.0.0.0/24'] },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await enforceOriginAllowlist(env as any, 'key-1', makeReq());
    expect(result.ok).toBe(true);
  });

  it('defaults to challenge when no entry exists for this key', async () => {
    const env = makeEnv({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await enforceOriginAllowlist(env as any, 'key-unknown', makeReq());
    expect(result.reason).toBe('challenge');
  });

  it('fails safe to challenge when KV throws', async () => {
    const env = {
      MCP_ORIGIN_ALLOWLIST_KV: {
        get: async () => {
          throw new Error('KV offline');
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await enforceOriginAllowlist(env as any, 'key-1', makeReq());
    expect(result.reason).toBe('challenge');
  });
});

describe('allowlistDecisionToResponse', () => {
  it('returns 403 + CF-MCP-Challenge header on challenge', async () => {
    const res = allowlistDecisionToResponse(
      { ok: false, reason: 'challenge', retryable: true },
      'https://app.arkova.ai',
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('CF-MCP-Challenge')).toBe('turnstile');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.arkova.ai');
    const body = await res.json();
    expect(body.error).toBe('origin_challenge_required');
  });

  it('returns 403 + origin_rejected on explicit rejection', async () => {
    const res = allowlistDecisionToResponse(
      { ok: false, reason: 'rejected', retryable: false },
      'https://app.arkova.ai',
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('CF-MCP-Challenge')).toBeNull();
    const body = await res.json();
    expect(body.error).toBe('origin_rejected');
  });
});
