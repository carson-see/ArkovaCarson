import { readFileSync } from 'node:fs';
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
    expect(workflow).toContain("test \"${{ steps.zk-cache.outputs.cache-hit }}\" != 'true'");
    expect(workflow).toContain('cache-matched-key');
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
});
