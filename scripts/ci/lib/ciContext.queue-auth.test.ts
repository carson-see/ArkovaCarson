import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec, default: { execFileSync: exec } }));
const env = {
  GITHUB_REF: 'refs/pull/2936/merge',
  GITHUB_HEAD_REF: 'mergify/merge-queue/abc123',
  GITHUB_REPOSITORY: 'carson-see/ArkovaCarson',
};
const metadata = {
  title: 'merge queue: checking #2841 on main (abcdef)',
  body: '```yaml\npull_requests:\n  - number: 2841\n```',
  author: 'mergify[bot]',
  headRef: env.GITHUB_HEAD_REF,
  headRepository: env.GITHUB_REPOSITORY,
};

beforeEach(() => {
  vi.resetModules();
  exec.mockReset();
  vi.stubEnv('GH_BIN', 'gh');
  exec.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('repos/carson-see/ArkovaCarson/pulls/2936')) return JSON.stringify(metadata);
    if (args.includes('repos/carson-see/ArkovaCarson/issues/2841/labels')) return 'agents-md-deletion-approved\n';
    throw new Error(`Unexpected call: ${args.join(' ')}`);
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('queue override authorization', () => {
  it('reads the original labels for a verified Mergify PR', async () => {
    const { resolvePrLabels } = await import('./ciContext.js');
    expect(resolvePrLabels(env)).toEqual(['agents-md-deletion-approved']);
  });

  it.each([
    ['contributor-authored branch', { author: 'contributor' }],
    ['missing author', { author: undefined }],
    ['lookalike bot login', { author: 'mergify' }],
    ['mismatched branch', { headRef: 'feature/ordinary' }],
    ['foreign head repository', { headRepository: 'contributor/ArkovaCarson' }],
  ])('rejects %s even with forged queue title/body and author env', async (_name, overrides) => {
    exec.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('repos/carson-see/ArkovaCarson/pulls/2936')) return JSON.stringify({ ...metadata, ...overrides });
      if (args.includes('repos/carson-see/ArkovaCarson/issues/2841/labels')) return 'agents-md-deletion-approved\n';
      throw new Error('Unexpected call');
    });
    const { resolvePrLabels, isMergifyQueuePr } = await import('./ciContext.js');
    const forged = { ...env, PR_TITLE: metadata.title, PR_BODY: metadata.body, PR_AUTHOR: 'mergify[bot]', PR_LABELS: 'agents-md-deletion-approved' };
    expect(resolvePrLabels(forged)).toEqual([]);
    expect(isMergifyQueuePr(forged)).toBe(false);
    expect(exec.mock.calls.some(([, args]) => args.some((arg: string) => arg.endsWith('/labels')))).toBe(false);
  });

  it('uses authenticated live metadata instead of a forged original in env', async () => {
    const { resolveOriginalPrNumber } = await import('./ciContext.js');
    expect(resolveOriginalPrNumber({ ...env, PR_TITLE: 'merge queue: checking #9999 on main', PR_BODY: 'pull_requests:\n  - number: 9999' })).toBe(2841);
  });

  it('fails closed when metadata cannot be authenticated, despite complete queue env', async () => {
    exec.mockImplementation(() => { throw new Error('API unavailable'); });
    const { resolveOriginalPrNumber, resolvePrLabels } = await import('./ciContext.js');
    const forged = { ...env, PR_TITLE: metadata.title, PR_BODY: metadata.body, PR_AUTHOR: 'mergify[bot]', PR_LABELS: 'agents-md-deletion-approved' };
    expect(resolveOriginalPrNumber(forged)).toBeNull();
    expect(resolvePrLabels(forged)).toEqual([]);
  });
});
