import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/s33-wave2-batch-acceptance.yml', 'utf8');
const mergify = readFileSync('.mergify.yml', 'utf8');

describe('S3.3 Wave-2 trusted-main workflow contract', () => {
  it('supports both GitHub transports and a post-merge trusted-main consumer', () => {
    expect(workflow).toContain('issue_comment:');
    expect(workflow).toContain('pull_request_review:');
    expect(workflow).toContain("types: [closed]");
    expect(workflow).toContain('arkova-s33-detached-acceptance:v2');
    expect(workflow).not.toContain('arkova-s33-wave2-authenticated-acceptance:v1');
    expect(workflow).toContain("jq -r '.request.payload.reviewer.transport'");
    expect(workflow).toContain("jq -r '.request.payload.reviewer.evidence.id'");
    expect(workflow).toContain('s33-wave2-github-transport.ts verify');
    expect(workflow).toContain('s33-wave2-batch-acceptance.ts accept');
    expect(workflow).toContain('s33-wave2-batch-acceptance.ts consume-merged');
    expect(workflow.match(/--verified-at-utc/gu)).toHaveLength(2);
    expect(workflow.match(/actions\/runs\/\$\{GITHUB_RUN_ID\}.*run_started_at/gu)).toHaveLength(2);
    expect(workflow).not.toContain('date -');
  });

  it('installs trusted code before fetching candidate data and never checks candidate code out', () => {
    const firstInstall = workflow.indexOf('Install trusted evaluator dependencies before candidate fetch');
    const firstPrivilegedFetch = workflow.indexOf('Fetch candidate into an inert bare object store', firstInstall);
    expect(firstInstall).toBeGreaterThan(0);
    expect(firstPrivilegedFetch).toBeGreaterThan(firstInstall);
    expect(workflow).toContain('git init --bare "$RUNNER_TEMP/candidate.git"');
    expect(workflow).toContain('--candidate-repository "$RUNNER_TEMP/candidate.git"');
    expect(workflow).not.toContain('path: candidate');
    expect(workflow).not.toContain('working-directory: candidate');
    expect(workflow).not.toMatch(/ref:\s*\$\{\{[^\n]*head\.sha/iu);
    expect(workflow).not.toMatch(/cache:\s*npm/iu);
    expect(workflow).not.toContain('actions/checkout@');
    expect(workflow).toContain('refs/heads/main');
    expect(workflow).toContain('merge-base --is-ancestor');
  });

  it('publishes success only after preserving authenticated evidence at the exact head', () => {
    const verifyIndex = workflow.indexOf('Verify authenticated whole-batch acceptance at the exact head');
    const uploadIndex = workflow.indexOf('Preserve authenticated acceptance before publishing status');
    const statusIndex = workflow.indexOf('Publish the exact-head required merge status');
    expect(verifyIndex).toBeGreaterThan(0);
    expect(uploadIndex).toBeGreaterThan(verifyIndex);
    expect(statusIndex).toBeGreaterThan(uploadIndex);
    expect(workflow).toContain("context='S3.3 Wave 2 Exact-Head Acceptance'");
    expect(workflow).toContain('statuses: write');
  });

  it('re-verifies the signed artifact and identical packet before trusted-main consumption', () => {
    expect(workflow).toContain('Locate the successful exact-head acceptance artifact');
    expect(workflow).toContain('Re-verify the signature-bound live GitHub transport');
    expect(workflow).toContain('Re-verify acceptance and consume only the identical merged packet');
    expect(workflow).toContain('--merged-main-head "${{ github.event.pull_request.merge_commit_sha }}"');
    expect(workflow).toContain("context='S3.3 Wave 2 Trusted-Main Consumption'");
  });

  it('does not grant authority to GitHub review state or account distinctness', () => {
    expect(workflow).not.toContain("github.event.review.state == 'approved'");
    expect(workflow).not.toContain('authorLogin');
    expect(workflow).not.toContain('reviewerLogin');
    expect(workflow).not.toContain('AUTHOR_LOGIN');
    expect(workflow).not.toContain('REVIEWER_LOGIN');
  });

  it('uses lifecycle-script suppression and immutable action pins', () => {
    expect(workflow).not.toContain('write-all');
    expect(workflow).toContain('permissions: {}');
    expect(workflow.match(/statuses: write/gu)).toHaveLength(2);
    expect(workflow.match(/npm (?:--prefix services\/worker )?ci --ignore-scripts/gu)?.length).toBeGreaterThanOrEqual(6);
    const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
    expect(actionUses.length).toBeGreaterThan(0);
    expect(actionUses.every((value) => /@[0-9a-f]{40}$/u.test(value))).toBe(true);
  });

  it('requires exact-head acceptance for every corpus-touching PR, including mixed-path PRs', () => {
    expect(mergify).toContain('name: s33-wave2-corpus');
    expect(mergify).toContain('files~=^(docs/lane4/s33-wave2-batches/|services/worker/');
    expect(mergify).toContain('check-success = S3.3 Wave 2 Exact-Head Acceptance');
    expect(mergify.match(/-files~=\^\(docs\/lane4\/s33-wave2-batches\//gu)?.length).toBeGreaterThanOrEqual(4);
  });
});
