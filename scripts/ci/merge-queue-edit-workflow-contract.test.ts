import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A skipped job must NOT reuse the required gate's name: otherwise a status
// edit can replace a failed/pending source check with a skipped conclusion.
const STATUS_EDIT = "github.event.action == 'edited' && github.event.changes.body && github.event.changes.base == null && startsWith(github.head_ref, 'mergify/merge-queue/') && github.event.pull_request.user.login == 'mergify[bot]' && github.event.sender.login == 'mergify[bot]'";
const WORKFLOWS = [
  ['migration-drift.yml', 'Check supabase/migrations vs prod', 'Migration drift status edit'],
  ['staging-evidence.yml', 'Staging Soak Evidence Gate', 'Staging evidence status edit'],
] as const;

function assertContract(workflow: string, requiredName: string, editName: string): void {
  expect(workflow).toContain(`if: \${{ !(${STATUS_EDIT}) }}`);
  expect(workflow).toContain(`name: \${{ ${STATUS_EDIT} && '${editName}' || '${requiredName}' }}`);
  // The ignored edit must also have a separate cancellation group; a job
  // predicate alone is too late to protect an already-running workflow.
  expect(workflow).toMatch(new RegExp(`^  group: .*\\$\\{\\{ github\\.ref \\}\\}.*`, 'm'));
  expect(workflow).toContain(`\${{ ${STATUS_EDIT} && 'status-edit' || 'gate' }}`);
  expect(workflow).toContain('  cancel-in-progress: true');
  expect(workflow).toMatch(/types: \[[^\n]*opened[^\n]*edited[^\n]*\]|types: \[[^\n]*edited[^\n]*opened[^\n]*\]/);
  expect(workflow).toMatch(/types: \[[^\n]*synchronize[^\n]*\]/);
  expect(workflow).not.toContain('continue-on-error: true');
}

describe.each(WORKFLOWS)('%s Mergify status edits', (file, requiredName, editName) => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows', file), 'utf8');

  it('isolates metadata edits without replacing the required source check', () => {
    assertContract(workflow, requiredName, editName);
  });

  it.each([
    ['spoofable branch identity', " && github.event.pull_request.user.login == 'mergify[bot]' && github.event.sender.login == 'mergify[bot]'", ''],
    ['human or other-bot edit treated as status', " && github.event.sender.login == 'mergify[bot]'", ''],
    ['base change treated as status', ' && github.event.changes.base == null', ''],
    ['every edited event ignored', ' && github.event.changes.body', ''],
    ['source check cancelled by edits', "&& 'status-edit' || 'gate'", "&& 'gate' || 'gate'"],
    ['skipped edit replaces required check', `&& '${editName}'`, `&& '${requiredName}'`],
  ])('rejects %s', (_label, from, to) => {
    const mutated = workflow.replaceAll(from, to);
    expect(mutated).not.toBe(workflow);
    expect(() => assertContract(mutated, requiredName, editName)).toThrow();
  });
});
