import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditImageScanGate } from './check-image-scan-gate.js';

const TRIVY_SHA = 'ed142fd0673e97e23eac54620cfb913e5ce36c25';

/** A minimal but structurally faithful deploy job: build → scan → push → deploy. */
function workflow(scanStep: string): string {
  return [
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Build image',
    '        run: |',
    '          docker build --tag "$IMAGE" services/worker',
    scanStep,
    '      - name: Push image',
    '        run: docker push "$IMAGE"',
    '      - name: Deploy canary (no traffic)',
    '        run: gcloud run deploy arkova-worker --no-traffic',
    '',
  ].join('\n');
}

// Mirrors the real deploy-worker.yml shape: a named step with `uses:` on its
// own line (not on the bullet) and the gate config under `with:`.
const VALID_TRIVY_STEP = [
  '      - name: Scan image for base-image CVEs (Trivy)',
  `        uses: aquasecurity/trivy-action@${TRIVY_SHA} # v0.36.0`,
  '        with:',
  '          image-ref: ${{ steps.build.outputs.image }}',
  '          format: table',
  "          exit-code: '1'",
  '          ignore-unfixed: true',
  '          vuln-type: os',
  '          severity: HIGH,CRITICAL',
].join('\n');

describe('check-image-scan-gate — auditImageScanGate', () => {
  it('passes a build → scan → push → deploy workflow with a pinned failing Trivy gate', () => {
    const result = auditImageScanGate(workflow(VALID_TRIVY_STEP));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('passes an equivalently-configured pinned Grype gate', () => {
    const grype = [
      `      - uses: anchore/scan-action@${TRIVY_SHA} # pinned`,
      '        with:',
      '          image: ${{ steps.build.outputs.image }}',
      '          fail-build: true',
      '          severity-cutoff: high',
      '          only-fixed: true',
    ].join('\n');
    const result = auditImageScanGate(workflow(grype));
    expect(result.ok).toBe(true);
  });

  it('fails when no container-image scan step is present', () => {
    const noScan = workflow('      - name: noop\n        run: "true"');
    const result = auditImageScanGate(noScan);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/No container-image CVE scan step/i);
  });

  it('fails when the scan action is pinned to a tag instead of a 40-char SHA', () => {
    const tagged = VALID_TRIVY_STEP.replace(`@${TRIVY_SHA}`, '@v0.36.0');
    const result = auditImageScanGate(workflow(tagged));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /40-char/.test(e))).toBe(true);
  });

  it('fails when the scan does not fail the build (no exit-code 1)', () => {
    const advisory = VALID_TRIVY_STEP.replace("exit-code: '1'", "exit-code: '0'");
    const result = auditImageScanGate(workflow(advisory));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /fail the deploy/.test(e))).toBe(true);
  });

  it('fails when severity does not gate both HIGH and CRITICAL', () => {
    const onlyCritical = VALID_TRIVY_STEP.replace('severity: HIGH,CRITICAL', 'severity: CRITICAL');
    const result = auditImageScanGate(workflow(onlyCritical));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /HIGH and CRITICAL/.test(e))).toBe(true);
  });

  it('fails when the scan is not limited to fixable CVEs', () => {
    const noIgnoreUnfixed = VALID_TRIVY_STEP.replace('          ignore-unfixed: true\n', '');
    const result = auditImageScanGate(workflow(noIgnoreUnfixed));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /FIXABLE CVEs only/.test(e))).toBe(true);
  });

  it('fails when the scan step runs AFTER the deploy step', () => {
    const scanAfterDeploy = [
      'jobs:',
      '  deploy:',
      '    steps:',
      '      - name: Build image',
      '        run: docker build --tag "$IMAGE" services/worker',
      '      - name: Deploy canary (no traffic)',
      '        run: gcloud run deploy arkova-worker --no-traffic',
      VALID_TRIVY_STEP,
      '',
    ].join('\n');
    const result = auditImageScanGate(scanAfterDeploy);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /AFTER the deploy/.test(e))).toBe(true);
  });

  it('enforces the gate on the real deploy-worker.yml workflow', () => {
    const real = readFileSync(
      resolve(import.meta.dirname, '..', '..', '.github/workflows/deploy-worker.yml'),
      'utf8',
    );
    const result = auditImageScanGate(real);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
