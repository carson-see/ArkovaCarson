import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('killSwitch middleware', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_FLAG = process.env.ENABLE_DRIVE_OAUTH;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_DRIVE_OAUTH;
    else process.env.ENABLE_DRIVE_OAUTH = ORIGINAL_FLAG;
  });

  function makeRes() {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return res as unknown as import('express').Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
  }

  it('calls next() when flag is "true"', async () => {
    process.env.ENABLE_DRIVE_OAUTH = 'true';
    delete process.env.NODE_ENV;
    const { killSwitch } = await import('./integrationKillSwitch.js');
    const next = vi.fn();
    const res = makeRes();
    killSwitch('ENABLE_DRIVE_OAUTH')({} as never, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 503 with deny-body when flag is unset', async () => {
    delete process.env.ENABLE_DRIVE_OAUTH;
    delete process.env.NODE_ENV;
    const { killSwitch } = await import('./integrationKillSwitch.js');
    const next = vi.fn();
    const res = makeRes();
    killSwitch('ENABLE_DRIVE_OAUTH')({} as never, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'integration_disabled',
        flag: 'ENABLE_DRIVE_OAUTH',
      }),
    );
  });

  it('returns 503 when flag is "false"', async () => {
    process.env.ENABLE_DRIVE_OAUTH = 'false';
    delete process.env.NODE_ENV;
    const { killSwitch } = await import('./integrationKillSwitch.js');
    const next = vi.fn();
    const res = makeRes();
    killSwitch('ENABLE_DRIVE_OAUTH')({} as never, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 503 when flag is anything other than literal "true"', async () => {
    for (const val of ['1', 'yes', 'enabled', 'TRUE']) {
      process.env.ENABLE_DRIVE_OAUTH = val;
      delete process.env.NODE_ENV;
      vi.resetModules();
      const { killSwitch } = await import('./integrationKillSwitch.js');
      const next = vi.fn();
      const res = makeRes();
      killSwitch('ENABLE_DRIVE_OAUTH')({} as never, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    }
  });

  it('bypasses gate when NODE_ENV=test (test fixture convenience)', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_DRIVE_OAUTH;
    const { killSwitch } = await import('./integrationKillSwitch.js');
    const next = vi.fn();
    const res = makeRes();
    killSwitch('ENABLE_DRIVE_OAUTH')({} as never, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('resolves flag value at factory time, not per request', async () => {
    delete process.env.ENABLE_DRIVE_OAUTH;
    delete process.env.NODE_ENV;
    const { killSwitch } = await import('./integrationKillSwitch.js');
    const handler = killSwitch('ENABLE_DRIVE_OAUTH');
    process.env.ENABLE_DRIVE_OAUTH = 'true';
    const next = vi.fn();
    const res = makeRes();
    handler({} as never, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
