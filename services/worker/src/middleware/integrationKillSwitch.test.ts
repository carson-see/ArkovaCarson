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

  async function setupHandler(opts: { flag?: string | undefined; testEnv?: boolean } = {}) {
    if (opts.flag === undefined) delete process.env.ENABLE_DRIVE_OAUTH;
    else process.env.ENABLE_DRIVE_OAUTH = opts.flag;
    if (opts.testEnv) process.env.NODE_ENV = 'test';
    else delete process.env.NODE_ENV;
    vi.resetModules();
    const { killSwitch } = await import('./integrationKillSwitch.js');
    return {
      handler: killSwitch('ENABLE_DRIVE_OAUTH'),
      next: vi.fn(),
      res: makeRes(),
    };
  }

  it('calls next() when flag is "true"', async () => {
    const { handler, next, res } = await setupHandler({ flag: 'true' });
    handler({} as never, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 503 with deny-body when flag is unset', async () => {
    const { handler, next, res } = await setupHandler({});
    handler({} as never, res, next);
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
    const { handler, next, res } = await setupHandler({ flag: 'false' });
    handler({} as never, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('returns 503 when flag is anything other than literal "true"', async () => {
    for (const val of ['1', 'yes', 'enabled', 'TRUE']) {
      const { handler, next, res } = await setupHandler({ flag: val });
      handler({} as never, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
    }
  });

  it('bypasses gate when NODE_ENV=test (test fixture convenience)', async () => {
    const { handler, next, res } = await setupHandler({ testEnv: true });
    handler({} as never, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('resolves flag value at factory time, not per request', async () => {
    const { handler, next, res } = await setupHandler({});
    process.env.ENABLE_DRIVE_OAUTH = 'true';
    handler({} as never, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
