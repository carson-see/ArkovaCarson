import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('SCRUM-5145 hosted email confirmation soak supervisor', () => {
  it('passes duration, cadence, credential-refresh, and evidence-redaction tests', () => {
    expect(() => execFileSync('python3', [
      'scripts/staging/uat17_email_soak_supervisor_test.py',
    ], { encoding: 'utf8' })).not.toThrow();
  });
});
