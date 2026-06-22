import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditImageScanGate } from './check-image-scan-gate.js';

const TRIVY_SHA = 'ed142fd0673e97e23eac54620cfb913e5ce36c25';

/**
 * The operator break-glass plumbing the gate now requires: a boolean
 * `workflow_dispatch` input + a guarded skip + an audit-log step. Kept in one
 * place so the happy-path fixtures stay in build → scan → push → deploy shape.
 */
const BYPASS_INPUT = [
  'on:',
  '  push:',
  '    branches: [main]',
  '  workflow_dispatch:',
  '    inputs:',
  '      bypass_image_scan:',
  "        description: 'BREAK-GLASS: skip the Trivy image scan (scanner-infra outage only)'",
  '        type: boolean',
  '        default: false',
].join('\n');

const BYPASS_AUDIT_STEP = [
  '      - name: Audit image-scan bypass (break-glass)',
  "        if: github.event.inputs.bypass_image_scan == 'true'",
  '        run: |',
  '          echo "⚠️ image scan bypassed by ${{ github.actor }}"',
].join('\n');

/** A minimal but structurally faithful deploy job: build → scan → push → deploy. */
function workflow(scanStep: string, opts: { bypass?: boolean } = {}): string {
  const { bypass = true } = opts;
  return [
    bypass ? BYPASS_INPUT : 'on:\n  push:\n    branches: [main]',
    'jobs:',
    '  deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Build image',
    '        run: |',
    '          docker build --tag "$IMAGE" services/worker',
    ...(bypass ? [BYPASS_AUDIT_STEP] : []),
    scanStep,
    '      - name: Push image',
    '        run: docker push "$IMAGE"',
    '      - name: Deploy canary (no traffic)',
    '        run: gcloud run deploy arkova-worker --no-traffic',
    '',
  ].join('\n');
}

// Mirrors the real deploy-worker.yml shape: a named step with `uses:` on its
// own line (not on the bullet) and the gate config under `with:`. Includes the
// break-glass `if:` guard so a manual dispatch can skip ONLY the scan step.
const VALID_TRIVY_STEP = [
  '      - name: Scan image for base-image CVEs (Trivy)',
  "        if: github.event.inputs.bypass_image_scan != 'true'",
  `        uses: aquasecurity/trivy-action@${TRIVY_SHA} # v0.36.0`,
  '        timeout-minutes: 10',
  '        env:',
  '          TRIVY_DB_REPOSITORY: public.ecr.aws/aquasecurity/trivy-db',
  '          TRIVY_JAVA_DB_REPOSITORY: public.ecr.aws/aquasecurity/trivy-java-db',
  '        with:',
  '          image-ref: ${{ steps.build.outputs.image }}',
  '          format: table',
  '          cache: true',
  '          github-token: ${{ secrets.GITHUB_TOKEN }}',
  "          exit-code: '1'",
  '          ignore-unfixed: true',
  '          pkg-types: os',
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
      '      - uses: anchore/scan-action@' + TRIVY_SHA + ' # pinned',
      "        if: github.event.inputs.bypass_image_scan != 'true'",
      '        with:',
      '          image: ${{ steps.build.outputs.image }}',
      '          fail-build: true',
      '          severity-cutoff: high',
      '          only-fixed: true',
      // Grype scopes OS packages via `only-package-types` (its pkg-type knob).
      '          only-package-types: os',
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

  // --- NEW: package-type scope is present and correct (LOW finding #3) ---

  it('passes when the OS package-type scope uses the current `pkg-types` key', () => {
    // VALID_TRIVY_STEP already uses `pkg-types: os`.
    const result = auditImageScanGate(workflow(VALID_TRIVY_STEP));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('still accepts the deprecated `vuln-type: os` key for back-compat', () => {
    const deprecated = VALID_TRIVY_STEP.replace('pkg-types: os', 'vuln-type: os');
    const result = auditImageScanGate(workflow(deprecated));
    expect(result.ok).toBe(true);
  });

  it('fails when the OS package-type scope key is missing entirely', () => {
    // A future action-version rename that drops the key must not silently
    // disable OS scanning — the gate must catch the absence.
    const noPkgTypes = VALID_TRIVY_STEP.replace('          pkg-types: os\n', '');
    const result = auditImageScanGate(workflow(noPkgTypes));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /package-type/i.test(e))).toBe(true);
  });

  it('fails when the package-type scope is set to something other than os', () => {
    const wrongScope = VALID_TRIVY_STEP.replace('pkg-types: os', 'pkg-types: library');
    const result = auditImageScanGate(workflow(wrongScope));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /package-type/i.test(e))).toBe(true);
  });

  // --- NEW: operator break-glass is wired and auditable (HIGH finding #1) ---

  it('fails when no operator break-glass (workflow_dispatch boolean) is wired', () => {
    // No bypass input/guard/audit step at all → a Trivy-infra outage would
    // block every deploy with no escape.
    const noBypass = workflow(
      VALID_TRIVY_STEP.replace(
        "        if: github.event.inputs.bypass_image_scan != 'true'\n",
        '',
      ),
      { bypass: false },
    );
    const result = auditImageScanGate(noBypass);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /break-glass/i.test(e))).toBe(true);
  });

  it('fails when the break-glass is declared but never audited (no log line)', () => {
    // Input + guard present, but the bypass is silent (no audit echo) → it
    // must be explicit and logged.
    const silentBypass = [
      BYPASS_INPUT,
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Build image',
      '        run: docker build --tag "$IMAGE" services/worker',
      VALID_TRIVY_STEP,
      '      - name: Push image',
      '        run: docker push "$IMAGE"',
      '      - name: Deploy canary (no traffic)',
      '        run: gcloud run deploy arkova-worker --no-traffic',
      '',
    ].join('\n');
    const result = auditImageScanGate(silentBypass);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /audit|logged/i.test(e))).toBe(true);
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
