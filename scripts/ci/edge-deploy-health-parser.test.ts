import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(resolve(root, '.github/workflows/edge-deploy.yml'), 'utf8');

describe.each(['PRE_SHA', 'LIVE_SHA'])('edge deployment %s health parser', (variable) => {
  function parse(body: string): string {
    const assignment = workflow.split('\n').find((line) => line.trim().startsWith(`${variable}="$(`));
    if (!assignment) throw new Error(`Missing ${variable} workflow assignment`);
    // Execute the actual workflow shell expression. A source-text assertion
    // cannot prove Bash passed the same JSON bytes to Node.
    return execFileSync('bash', ['-eu', '-c', `${assignment}\nprintf '%s' "$${variable}"`], {
      cwd: root,
      env: { ...process.env, BODY: body },
      encoding: 'utf8',
      timeout: 5_000,
    });
  }

  it('preserves a valid deployed commit identifier', () => {
    const sha = '663254b9f6e7c3143603ed3295d0a08fbb993aec';
    expect(parse(JSON.stringify({ status: 'ok', git_sha: sha }))).toBe(sha);
  });

  it.each(['', '<html>upstream unavailable</html>', 'null', '{}'])(
    'returns no identity for unavailable or malformed health body %j', (body) => {
      expect(parse(body)).toBe('');
    },
  );
});
