import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/s33-wave2-batch-acceptance.yml', 'utf8');

describe('S3.3 Wave-2 trusted-main workflow contract', () => {
  it('runs candidate validation from the trusted base and authenticates exact-head review', () => {
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('pull_request_review:');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(workflow).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(workflow).toContain('REVIEW_COMMIT: ${{ github.event.review.commit_id }}');
    expect(workflow).toContain('--candidate-head "${{ github.event.pull_request.head.sha }}"');
  });

  it('installs and executes only trusted evaluator code', () => {
    expect(workflow.match(/working-directory: trusted/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(workflow).not.toMatch(/working-directory:\s*candidate/iu);
    expect(workflow).not.toMatch(/npm[^\n]*(?:test|run)[^\n]*candidate/iu);
    expect(workflow).toContain('Install trusted evaluator dependencies only');
    expect(workflow).toContain('without executing candidate code');
  });

  it('uses read-only permissions, lifecycle-script suppression, and pinned actions', () => {
    expect(workflow).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: read/u);
    expect(workflow).not.toContain('write-all');
    expect(workflow.match(/npm (?:--prefix services\/worker )?ci --ignore-scripts/gu)?.length).toBeGreaterThanOrEqual(6);
    const actionUses = [...workflow.matchAll(/uses:\s*([^\s#]+)/gu)].map((match) => match[1]);
    expect(actionUses.length).toBeGreaterThan(0);
    expect(actionUses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
  });
});
