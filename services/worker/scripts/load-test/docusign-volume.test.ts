import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const k6 = vi.hoisted(() => ({
  check: vi.fn(() => true),
  sleep: vi.fn(),
}));

const synth = vi.hoisted(() => ({
  DEFAULT_MIX: { health: 0.5, verify: 0.35, docusign: 0.15 },
  pickScenario: vi.fn(),
}));

const docusign = vi.hoisted(() => ({
  executeScenario: vi.fn(),
}));

vi.mock('k6', () => k6, { virtual: true });
vi.mock('./lib/docusign-synth.js', () => synth);
vi.mock('./lib/k6-docusign.js', () => docusign);

async function importProfile(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubGlobal('__ENV', env);
  vi.stubGlobal('__VU', 7);
  vi.stubGlobal('__ITER', 11);
  return import('./docusign-volume.js');
}

describe('docusign-volume profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docusign.executeScenario.mockReturnValue({ status: 200, headers: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fails setup when DOCUSIGN_HMAC_KEY is missing', async () => {
    const profile = await importProfile();

    expect(() => profile.setup()).toThrow(/DOCUSIGN_HMAC_KEY/);
  });

  it('rejects invalid DOCUSIGN_NOTARY_RATE values at import time', async () => {
    await expect(importProfile({ DOCUSIGN_HMAC_KEY: 'secret', DOCUSIGN_NOTARY_RATE: '1.5' }))
      .rejects.toThrow(/DOCUSIGN_NOTARY_RATE/);
    await expect(importProfile({ DOCUSIGN_HMAC_KEY: 'secret', DOCUSIGN_NOTARY_RATE: 'nope' }))
      .rejects.toThrow(/DOCUSIGN_NOTARY_RATE/);
  });

  it('parses unset, empty, and bounded notary rates', async () => {
    const profile = await importProfile({ DOCUSIGN_HMAC_KEY: 'secret' });

    expect(profile.parseNotaryRate()).toBe(0);
    expect(profile.parseNotaryRate('')).toBe(0);
    expect(profile.parseNotaryRate('0')).toBe(0);
    expect(profile.parseNotaryRate('1')).toBe(1);
    expect(profile.parseNotaryRate('0.25')).toBe(0.25);
  });

  it('selects a docusign scenario and samples notary when NOTARY_RATE is positive', async () => {
    synth.pickScenario.mockReturnValue('docusign');
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.91)
      .mockReturnValueOnce(0.2);
    const profile = await importProfile({
      WORKER_URL: 'https://worker.test',
      DOCUSIGN_HMAC_KEY: 'secret',
      DOCUSIGN_ACCOUNT_ID: 'acct-1',
      DOCUSIGN_NOTARY_RATE: '0.5',
    });

    profile.default();

    expect(synth.pickScenario).toHaveBeenCalledWith(0.91, synth.DEFAULT_MIX);
    expect(docusign.executeScenario).toHaveBeenCalledWith('docusign', {
      workerUrl: 'https://worker.test',
      key: 'secret',
      accountId: 'acct-1',
      vu: 7,
      iter: 11,
      withNotary: true,
    });
    expect(k6.sleep).toHaveBeenCalledWith(0.05);
  });

  it('does not sample notary when NOTARY_RATE is zero', async () => {
    synth.pickScenario.mockReturnValue('docusign');
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.91);
    const profile = await importProfile({
      DOCUSIGN_HMAC_KEY: 'secret',
      DOCUSIGN_NOTARY_RATE: '0',
    });

    profile.default();

    expect(docusign.executeScenario).toHaveBeenCalledWith('docusign', expect.objectContaining({
      withNotary: false,
    }));
  });

  it('passes only non-5xx and intentional 503 responses through the check predicate', async () => {
    synth.pickScenario.mockReturnValue('health');
    const profile = await importProfile({ DOCUSIGN_HMAC_KEY: 'secret' });

    profile.default();

    const checks = k6.check.mock.calls[0][1] as Record<string, (response: { status: number; headers: Record<string, string> }) => boolean>;
    const predicate = checks['no 5xx (except intentional 503)'];
    expect(predicate({ status: 499, headers: {} })).toBe(true);
    expect(predicate({ status: 500, headers: {} })).toBe(false);
    expect(predicate({ status: 503, headers: {} })).toBe(false);
    expect(predicate({ status: 503, headers: { 'Retry-After': '1' } })).toBe(true);
  });
});
