import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('.github/workflows/sonatype-scan.yml', 'utf8');

function admitted(event: { name: string; draft?: boolean; head?: string; dependabot?: boolean }): boolean {
  return event.dependabot !== true
    && (event.name !== 'pull_request' || event.head?.startsWith('mergify/') === true || event.draft !== true);
}

describe('Sonatype draft admission', () => {
  it('runs after readiness transitions and retains scheduled coverage', () => {
    expect(source).toContain('types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]');
    expect(source).toContain("- cron: '0 12 * * 1'");
  });

  it('defers ordinary drafts without suppressing ready, Mergify, or scheduled scans', () => {
    expect(admitted({ name: 'pull_request', draft: true, head: 'feature/x' })).toBe(false);
    expect(admitted({ name: 'pull_request', draft: false, head: 'feature/x' })).toBe(true);
    expect(admitted({ name: 'pull_request', draft: true, head: 'mergify/merge-queue/1' })).toBe(true);
    expect(admitted({ name: 'schedule' })).toBe(true);
    expect(admitted({ name: 'pull_request', draft: false, dependabot: true })).toBe(false);
    expect(source).toContain("startsWith(github.head_ref, 'mergify/')");
    expect(source).toContain("github.event.pull_request.draft != true");
  });

  it('preserves the complete four-workspace matrix', () => {
    for (const name of ['root', 'worker', 'edge', 'embed']) {
      expect(source).toContain(`- { name: ${name},`);
    }
  });
});
