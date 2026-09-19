import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/recover-ptau-mirror.yml', 'utf8');
const PIN = '489be9e5ac65d524f7b1685baac8a183c6e77924fdb73d2b8105e335f277895d';

describe('trusted ptau mirror recovery workflow', () => {
  it('is manual, main-only, and uses the protected production environment', () => {
    expect(workflow).toMatch(/on:\n\s+workflow_dispatch:/u);
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('environment: production');
  });

  it('restores only the established trusted cache prefix and cannot accept an exact attacker key', () => {
    expect(workflow).toContain('key: ptau-recovery-never-exact-${{ github.run_id }}');
    expect(workflow).toContain('zk-artifacts-Linux-circom2.1.9-');
    expect(workflow).toContain('fail-on-cache-miss: true');
    expect(workflow).toContain('CACHE_HIT: ${{ steps.zk-cache.outputs.cache-hit }}');
    expect(workflow).toContain('CACHE_MATCHED_KEY: ${{ steps.zk-cache.outputs.cache-matched-key }}');
    expect(workflow).toContain('test "$CACHE_HIT" != \'true\'');
    expect(workflow).not.toMatch(/run:[\s\S]*\$\{\{ steps\.zk-cache\.outputs\./u);
  });

  it('checks the repository pin before upload and after a fresh download', () => {
    expect(workflow.match(new RegExp(PIN, 'gu'))).toHaveLength(1);
    expect(workflow.match(/sha256sum -c -/gu)).toHaveLength(2);
    expect(workflow).toContain('test "$(stat -c %s "$ptau")" -gt 10000000');
    expect(workflow).toContain('test "$(stat -c %s "$fresh")" -gt 10000000');
  });

  it('uses WIF and an immutable create-only Cloud Storage write', () => {
    expect(workflow).toContain('google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093');
    expect(workflow).toContain('workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}');
    expect(workflow).toContain('service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}');
    expect(workflow).toContain('gcloud storage cp --if-generation-match=0 "$source" "$target"');
  });

  it('treats a hostile cache-matched-key as inert data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptau-cache-key-'));
    const marker = join(dir, 'executed');
    const hostile = `wrong-prefix'; touch '${marker}'; #`;
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      'case "$CACHE_MATCHED_KEY" in',
      '  "${CACHE_PREFIX}"*) ;;',
      '  *) exit 23 ;;',
      'esac',
    ].join('\n')], {
      env: { ...process.env, CACHE_MATCHED_KEY: hostile, CACHE_PREFIX: 'zk-artifacts-Linux-circom2.1.9-' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(23);
    expect(() => readFileSync(marker)).toThrow();
  });
});
