#!/usr/bin/env -S npx tsx
/**
 * Container-image CVE scan gate enforcement (TVM/IVS — CSA STAR CAIQ).
 *
 * The worker Docker image (`arkova-worker`) is built and deployed by
 * `.github/workflows/deploy-worker.yml`. Dependency CVEs are covered by
 * `sonatype-scan.yml` (npm graph, CVSS>=7 gate), but that scan does NOT see
 * OS-layer / base-image packages baked into the container. This guard makes
 * the container-image CVE scan a non-removable invariant of the deploy
 * pipeline so the base-image scanning control cannot silently regress.
 *
 * It asserts that the worker deploy workflow:
 *   1. Runs a container-image vulnerability scanner (Trivy `aquasecurity/
 *      trivy-action`, or Grype `anchore/scan-action`)…
 *   2. …pinned to a full 40-char commit SHA (repo supply-chain convention —
 *      see `.github/workflows/agents.md`), not a `@vN` / branch ref…
 *   3. …configured to FAIL the build on HIGH/CRITICAL findings…
 *   4. …on fixable CVEs only (`ignore-unfixed`), mirroring the CVSS>=7
 *      fixable-gate intent in `sonatype-scan.yml`…
 *   5. …positioned AFTER the image build and BEFORE the deploy step, so a
 *      vulnerable image is gated out before it can ship.
 *
 * Run standalone in CI: `npx tsx scripts/ci/check-image-scan-gate.ts`.
 * No override label — this is a security control, not a style rule. If the
 * scanner legitimately changes (e.g. Trivy → Grype), update both the workflow
 * and this guard's expectations in the same PR.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW_REL = '.github/workflows/deploy-worker.yml';
const DEPLOY_STEP_RE = /name:\s*Deploy canary/i;
const BUILD_STEP_RE = /docker build\b/;
/** 6-space step bullet (`      - `) — the step boundary in this workflow. */
const STEP_BULLET_RE = /^ {6}- /;
/** Supported container scanners, each → the `uses:` owner/repo to match. */
const SCANNERS: ReadonlyArray<{ name: string; action: string }> = [
  { name: 'Trivy', action: 'aquasecurity/trivy-action' },
  { name: 'Grype', action: 'anchore/scan-action' },
];

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** Collect the lines belonging to the step that starts at `bulletIdx`. */
function stepBlock(lines: string[], bulletIdx: number): string[] {
  const block: string[] = [lines[bulletIdx]];
  for (let i = bulletIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Next step bullet, or a dedent out of the steps list, ends the block.
    if (STEP_BULLET_RE.test(line)) break;
    if (/^ {0,4}\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/**
 * Audit the text of `deploy-worker.yml` for the container-image scan gate.
 * Pure (operates on the passed string) so it is unit-testable against
 * fixtures as well as the real workflow file.
 */
export function auditImageScanGate(workflowText: string): AuditResult {
  const errors: string[] = [];
  const lines = workflowText.split(/\r?\n/);

  // Locate the scanner step (the bullet line carries `- uses: <action>@<ref>`).
  let scanBulletIdx = -1;
  let matchedScanner: (typeof SCANNERS)[number] | undefined;
  let ref: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    for (const scanner of SCANNERS) {
      // `uses:` may sit on the step bullet (`- uses: …`) or on its own line
      // under a named step (`- name: …` then `  uses: …`). Match both.
      const m = new RegExp(
        String.raw`^\s*-?\s*uses:\s*${scanner.action}@(\S+)`,
      ).exec(lines[i]);
      if (m) {
        scanBulletIdx = i;
        matchedScanner = scanner;
        ref = m[1];
        break;
      }
    }
    if (scanBulletIdx !== -1) break;
  }

  if (scanBulletIdx === -1 || !matchedScanner || ref === null) {
    return {
      ok: false,
      errors: [
        `No container-image CVE scan step found in ${WORKFLOW_REL}. Add a `
        + `Trivy (\`aquasecurity/trivy-action\`) or Grype (\`anchore/scan-action\`) `
        + `step that scans the built worker image before deploy. See `
        + `docs/compliance/container-image-scanning.md.`,
      ],
    };
  }

  // (2) Pinned to a full 40-char commit SHA, not a tag/branch.
  const cleanRef = ref.replace(/#.*$/, '').trim();
  if (!/^[0-9a-f]{40}$/i.test(cleanRef)) {
    errors.push(
      `${matchedScanner.name} scan action must be pinned to a full 40-char `
      + `commit SHA (got \`@${cleanRef}\`). Tag/branch refs are mutable — `
      + `see .github/workflows/agents.md "pinned action SHAs".`,
    );
  }

  const block = stepBlock(lines, scanBulletIdx).join('\n');

  // (3) Fails the build on findings. Trivy: `exit-code: '1'`. Grype:
  // `fail-build: true`.
  const exitCode = /exit-code:\s*['"]?(\d+)['"]?/.exec(block);
  const grypeFail = /fail-build:\s*['"]?true['"]?/i.test(block);
  if (!grypeFail && (!exitCode || exitCode[1] !== '1')) {
    errors.push(
      `${matchedScanner.name} scan must fail the deploy on findings `
      + `(Trivy \`exit-code: '1'\` or Grype \`fail-build: true\`). A non-failing `
      + `scan is advisory only and does not gate the deploy.`,
    );
  }

  // (3b) HIGH and CRITICAL both gated. Trivy: `severity: HIGH,CRITICAL`.
  // Grype: `severity-cutoff: high`.
  const severity = /severity(?:-cutoff)?:\s*['"]?([^'"\n]+)['"]?/i.exec(block);
  const sevValue = (severity?.[1] ?? '').toUpperCase();
  const gatesHighCritical = matchedScanner.name === 'Grype'
    ? /\bHIGH\b/.test(sevValue) // cutoff=high implies critical too
    : sevValue.includes('HIGH') && sevValue.includes('CRITICAL');
  if (!gatesHighCritical) {
    errors.push(
      `${matchedScanner.name} scan must gate HIGH and CRITICAL severities `
      + `(Trivy \`severity: HIGH,CRITICAL\` or Grype \`severity-cutoff: high\`). `
      + `Got \`${severity?.[1]?.trim() ?? '<none>'}\`.`,
    );
  }

  // (4) Fixable-only, so unpatchable base-image CVEs don't wedge every deploy.
  const ignoresUnfixed = /ignore-unfixed:\s*['"]?true['"]?/i.test(block)
    || /only-fixed:\s*['"]?true['"]?/i.test(block);
  if (!ignoresUnfixed) {
    errors.push(
      `${matchedScanner.name} scan should gate on FIXABLE CVEs only `
      + `(Trivy \`ignore-unfixed: true\` / Grype \`only-fixed: true\`) so that `
      + `base-image CVEs with no upstream patch are tracked, not block every `
      + `deploy. Matches the fixable-gate intent in sonatype-scan.yml.`,
    );
  }

  // (5) Ordering: after `docker build`, before the deploy step.
  const buildIdx = lines.findIndex((l) => BUILD_STEP_RE.test(l));
  const deployIdx = lines.findIndex((l) => DEPLOY_STEP_RE.test(l));
  if (deployIdx === -1) {
    errors.push(
      `Could not locate the "Deploy canary" step in ${WORKFLOW_REL}; cannot `
      + `confirm the scan gates the deploy.`,
    );
  } else if (scanBulletIdx > deployIdx) {
    errors.push(
      `${matchedScanner.name} scan step runs AFTER the deploy step — it must `
      + `run before "Deploy canary" to gate the deploy.`,
    );
  }
  if (buildIdx !== -1 && scanBulletIdx < buildIdx) {
    errors.push(
      `${matchedScanner.name} scan step runs before the image is built — it `
      + `must scan the built image (after \`docker build\`).`,
    );
  }

  return { ok: errors.length === 0, errors };
}

function main(): void {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const workflowPath = resolve(repoRoot, WORKFLOW_REL);
  if (!existsSync(workflowPath)) {
    console.error(`::error::${WORKFLOW_REL} not found at ${workflowPath}.`);
    process.exit(1);
  }

  const result = auditImageScanGate(readFileSync(workflowPath, 'utf8'));
  if (result.ok) {
    console.log('✅ Container-image CVE scan gate present in deploy-worker.yml.');
    return;
  }
  for (const err of result.errors) console.error(`::error::${err}`);
  console.error('');
  console.error(
    'The worker container image must be CVE-scanned before deploy. See '
    + 'docs/compliance/container-image-scanning.md (CSA STAR CAIQ TVM/IVS).',
  );
  process.exit(1);
}

const isDirectInvocation = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
})();

if (isDirectInvocation) main();
