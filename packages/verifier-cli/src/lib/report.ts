/**
 * Render a VerifyReport as plain text for a non-engineer auditor.
 *
 * Terminology ban (CLAUDE.md §1.3) applies to all user-facing strings:
 * use Fingerprint / Network Receipt / Network Observed Time — never
 * Hash / Transaction / Block / Broadcast.
 */

import type { VerifyReport, StepStatus } from '../verify.js';

const MARK: Record<StepStatus, string> = {
  pass: '[PASS]',
  fail: '[FAIL]',
  skipped: '[ —- ]',
};

function shortHex(hex: string): string {
  return hex.length > 20 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex;
}

/** Render the human-readable report. */
export function renderReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push('Arkova reference verifier — independent verification result');
  lines.push('(zero Arkova network calls; the on-chain fact is confirmed against an independent node)');
  lines.push('');
  lines.push(report.ok ? 'VERDICT: VERIFIED' : 'VERDICT: NOT VERIFIED');
  lines.push('');
  lines.push(`  Secured fingerprint:    ${report.fingerprint}`);
  lines.push(`  Published root:         ${shortHex(report.merkleRoot)}`);
  lines.push(`  Network receipt:        ${report.receiptId ?? '(none — not yet anchored)'}`);
  if (report.blockHeight != null) {
    lines.push(`  Recorded at block:      #${report.blockHeight}`);
  }
  // §1.5: the Network Observed Time we report is MEASURED from the independent
  // network header — never the record's self-claim. Keep the two clearly distinct.
  if (report.networkObservedTime) {
    lines.push(`  Network observed time:  ${report.networkObservedTime}  (measured from the independent network header)`);
    if (report.packetClaimedTime && report.observedTimeAgrees === false) {
      lines.push(`  Time claimed in record: ${report.packetClaimedTime}  (DISAGREES with the measured time above — claim NOT corroborated)`);
    } else if (report.packetClaimedTime && report.observedTimeAgrees === true) {
      lines.push('  Time claimed in record: matches the measured network time above.');
    }
  } else if (report.packetClaimedTime) {
    // No independent measurement ran — surface the claim, but NEVER as "observed".
    lines.push(`  Time claimed in record: ${report.packetClaimedTime}  (record's own claim; NOT independently measured)`);
  }
  if (report.independentNode) {
    lines.push(`  Independent node:       ${report.independentNode}`);
  }
  lines.push('');
  lines.push('  Checks:');
  for (const step of report.steps) {
    lines.push(`    ${MARK[step.status]} ${step.label}`);
    lines.push(`           ${step.detail}`);
  }
  lines.push('');

  // Signature line — explicitly separated so it never reads as the verdict.
  if (report.signature.status === 'verified') {
    lines.push(`  Issuer signature:       VERIFIED (key ${report.signature.signingKeyId ?? 'unknown'})`);
    lines.push('           Confirms Arkova issued this proof package. This does NOT replace the');
    lines.push('           independent on-chain checks above — those alone establish the record.');
  } else if (report.signature.status === 'failed') {
    lines.push(`  Issuer signature:       FAILED (${report.signature.reason ?? 'unknown'})`);
  } else {
    lines.push('  Issuer signature:       not checked (no signed package / published key supplied)');
  }

  // Surface the server's own claim for comparison — never used for the verdict.
  if (report.serverClaimedVerified != null) {
    const agree = report.serverClaimedVerified === report.ok;
    lines.push('');
    lines.push(
      `  Note: the proof package claimed verified=${report.serverClaimedVerified}; ` +
        `this independent check ${agree ? 'agrees' : 'DISAGREES'}. ` +
        'This verifier trusts only its own recomputation, never the package claim.',
    );
  }

  lines.push('');
  lines.push(
    'What this proves: the fingerprint above is committed in a root recorded on the public ' +
      'network at the stated time. It asserts nothing about the document contents, the ' +
      "holder's identity, or any registry listing.",
  );
  return lines.join('\n');
}
