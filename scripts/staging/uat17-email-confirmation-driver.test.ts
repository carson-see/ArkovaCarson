import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('SCRUM-5145 hosted email confirmation driver', () => {
  it('passes its target, config, mailbox-selection, link-binding, and redaction tests', () => {
    expect(() => execFileSync('python3', [
      'scripts/staging/uat17_email_confirmation_driver_test.py',
    ], { encoding: 'utf8' })).not.toThrow();
  });
});
