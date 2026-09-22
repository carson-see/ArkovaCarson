import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { evaluateDependabotConfig, run, SUM_LIMIT } from './dependabot-pr-limit.js';
import { REPO } from '../lib/ciContext.js';

describe('feedback_dependabot_pr_limit_sum', () => {
  it('SUM_LIMIT is 7', () => {
    expect(SUM_LIMIT).toBe(7);
  });

  it('passes against the real, current .github/dependabot.yml (sum 7)', () => {
    const raw = readFileSync(resolve(REPO, '.github/dependabot.yml'), 'utf8');
    const result = evaluateDependabotConfig(load(raw));
    expect(result.ok).toBe(true);
    expect(result.message).toContain('sum=7');
  });

  it('run() reads and evaluates the real file end to end', () => {
    const result = run();
    expect(result.ok).toBe(true);
  });

  it('fails a fixture whose limits sum to 8', () => {
    const doc = {
      updates: [
        { 'package-ecosystem': 'npm', directory: '/', 'open-pull-requests-limit': 2 },
        { 'package-ecosystem': 'npm', directory: '/services/worker', 'open-pull-requests-limit': 2 },
        { 'package-ecosystem': 'npm', directory: '/services/edge', 'open-pull-requests-limit': 1 },
        { 'package-ecosystem': 'npm', directory: '/integrations/zapier', 'open-pull-requests-limit': 2 },
        { 'package-ecosystem': 'github-actions', directory: '/', 'open-pull-requests-limit': 1 },
      ],
    };
    const result = evaluateDependabotConfig(doc);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('sum to 8');
    expect(result.message).toContain('founder decision');
  });

  it('fails a fixture with an entry missing open-pull-requests-limit, even if the declared sum is small', () => {
    const doc = {
      updates: [
        { 'package-ecosystem': 'npm', directory: '/', 'open-pull-requests-limit': 2 },
        { 'package-ecosystem': 'npm', directory: '/services/worker' }, // omitted — GitHub defaults to 5
      ],
    };
    const result = evaluateDependabotConfig(doc);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('omits `open-pull-requests-limit`');
    expect(result.message).toContain('npm:/services/worker');
  });

  it('fails when both problems occur together and reports both', () => {
    const doc = {
      updates: [
        { 'package-ecosystem': 'npm', directory: '/', 'open-pull-requests-limit': 5 },
        { 'package-ecosystem': 'npm', directory: '/services/worker', 'open-pull-requests-limit': 5 },
        { 'package-ecosystem': 'npm', directory: '/services/edge' },
      ],
    };
    const result = evaluateDependabotConfig(doc);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('sum to 10');
    expect(result.message).toContain('omits `open-pull-requests-limit`');
  });

  it('fails closed on a missing or unparseable updates list', () => {
    expect(evaluateDependabotConfig({}).ok).toBe(false);
    expect(evaluateDependabotConfig(null).ok).toBe(false);
    expect(evaluateDependabotConfig({ updates: [] }).ok).toBe(false);
    expect(evaluateDependabotConfig('not an object').ok).toBe(false);
  });

  it('a boundary sum of exactly 7 with every field present passes', () => {
    const doc = {
      updates: [
        { 'package-ecosystem': 'npm', directory: '/', 'open-pull-requests-limit': 7 },
      ],
    };
    expect(evaluateDependabotConfig(doc).ok).toBe(true);
  });
});
