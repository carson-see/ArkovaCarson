import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('.github/workflows/ci.yml', 'utf8');

function jobBlocks(): Record<string, string> {
  const jobsSource = source.slice(source.indexOf('\njobs:\n') + 7);
  const starts = [...jobsSource.matchAll(/^  ([a-zA-Z0-9_-]+):\n/gm)];
  return Object.fromEntries(starts.map((match, index) => [
    match[1],
    jobsSource.slice(match.index!, starts[index + 1]?.index ?? jobsSource.length),
  ]));
}

function needs(block: string): string[] {
  const raw = block.match(/^    needs: (.+)$/m)?.[1]?.trim();
  if (!raw) return [];
  return raw.startsWith('[')
    ? raw.slice(1, -1).split(',').map((value) => value.trim())
    : [raw];
}

const originalDependencies: Record<string, string[]> = {
  test: ['typecheck-lint', 'tdd-enforcement'],
  e2e: ['typecheck-lint', 'test'],
  lighthouse: ['typecheck-lint'],
};

function admitted(event: { name: string; draft?: boolean; head?: string }): boolean {
  return event.name !== 'pull_request' || event.head?.startsWith('mergify/') === true || event.draft !== true;
}

const focusedJob = 'protected-main-focused';

describe('CI draft admission', () => {
  it('subscribes to readiness transitions and manual verification', () => {
    expect(source).toContain('types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]');
    expect(source).toMatch(/^  workflow_dispatch:/m);
    expect(source).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main'");
  });

  it('admits protected/manual, ready PR, and Mergify speculative events only', () => {
    expect(admitted({ name: 'pull_request', draft: true, head: 'feature/x' })).toBe(false);
    expect(admitted({ name: 'pull_request', draft: false, head: 'feature/x' })).toBe(true);
    expect(admitted({ name: 'pull_request', draft: true, head: 'mergify/bp/queue' })).toBe(true);
    expect(admitted({ name: 'push' })).toBe(true);
    expect(admitted({ name: 'workflow_dispatch' })).toBe(true);
    expect(source).toContain("github.event_name != 'pull_request' || startsWith(github.head_ref, 'mergify/') || github.event.pull_request.draft != true");
  });

  it('gates every expensive job and retains the pre-admission DAG', () => {
    for (const [id, block] of Object.entries(jobBlocks())) {
      if (id === 'admission' || id === focusedJob) continue;
      const dependencies = needs(block);
      expect(dependencies, `${id} must depend on admission`).toContain('admission');
      expect(block, `${id} must consume admission`).toContain("needs.admission.outputs.run_full == 'true'");
      expect(dependencies.filter((need) => need !== 'admission').sort()).toEqual(
        (originalDependencies[id] ?? []).sort(),
      );
    }
    expect(jobBlocks()[focusedJob]).toContain("needs.admission.outputs.run_focused == 'true'");
    expect(jobBlocks()['secret-scan']).toContain(
      "needs.admission.outputs.run_full == 'true' || needs.admission.outputs.run_focused == 'true'",
    );
  });
});
