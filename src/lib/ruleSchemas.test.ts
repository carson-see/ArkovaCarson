/**
 * CIBA-HARDEN-04 — Frontend shadow schema tests.
 *
 * Pin the client-side validator used by RuleBuilderPage.tsx so regressions
 * in the shadow don't re-enable the old "POST and render 400" round-trip.
 */

import { describe, it, expect } from 'vitest';
import { validateWizardConfigs } from './ruleSchemas';

describe('validateWizardConfigs', () => {
  it('returns no issues for a valid ESIGN_COMPLETED + AUTO_ANCHOR pair', () => {
    expect(
      validateWizardConfigs({
        trigger_type: 'ESIGN_COMPLETED',
        trigger_config: { filename_contains: 'MSA' },
        action_type: 'AUTO_ANCHOR',
        action_config: {},
      }),
    ).toEqual([]);
  });

  it('returns no issues when trigger/action are unset (wizard still on step 1/3)', () => {
    expect(
      validateWizardConfigs({
        trigger_type: '',
        trigger_config: {},
        action_type: '',
        action_config: {},
      }),
    ).toEqual([]);
  });

  it('rejects SCHEDULED_CRON without cron or timezone', () => {
    const issues = validateWizardConfigs({
      trigger_type: 'SCHEDULED_CRON',
      trigger_config: {},
      action_type: 'AUTO_ANCHOR',
      action_config: {},
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.toLowerCase().includes('cron'))).toBe(true);
    expect(issues.some((i) => i.toLowerCase().includes('timezone'))).toBe(true);
  });

  it('rejects CONNECTOR_DOCUMENT_RECEIVED without connector_type', () => {
    const issues = validateWizardConfigs({
      trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
      trigger_config: {},
      action_type: 'AUTO_ANCHOR',
      action_config: {},
    });
    expect(issues.some((i) => i.toLowerCase().includes('connector_type'))).toBe(true);
  });

  it('rejects FORWARD_TO_URL without hmac_secret_handle (CIBA-HARDEN-04 guardrail)', () => {
    const issues = validateWizardConfigs({
      trigger_type: 'ESIGN_COMPLETED',
      trigger_config: {},
      action_type: 'FORWARD_TO_URL',
      action_config: { target_url: 'https://ops.example.com/hooks/arkova' },
    });
    expect(issues.some((i) => i.includes('hmac_secret_handle'))).toBe(true);
  });

  it('rejects FORWARD_TO_URL with a raw secret (not a sm: handle)', () => {
    const issues = validateWizardConfigs({
      trigger_type: 'ESIGN_COMPLETED',
      trigger_config: {},
      action_type: 'FORWARD_TO_URL',
      action_config: {
        target_url: 'https://ops.example.com/hooks/arkova',
        hmac_secret_handle: 'abcd1234-not-a-handle',
      },
    });
    expect(issues.some((i) => i.includes('hmac_secret_handle'))).toBe(true);
  });

  it('accepts FORWARD_TO_URL with valid target_url + sm: handle', () => {
    expect(
      validateWizardConfigs({
        trigger_type: 'ESIGN_COMPLETED',
        trigger_config: {},
        action_type: 'FORWARD_TO_URL',
        action_config: {
          target_url: 'https://ops.example.com/hooks/arkova',
          hmac_secret_handle: 'sm:acme_forward_secret',
        },
      }),
    ).toEqual([]);
  });

  it('rejects NOTIFY with zero channels', () => {
    const issues = validateWizardConfigs({
      trigger_type: 'ESIGN_COMPLETED',
      trigger_config: {},
      action_type: 'NOTIFY',
      action_config: { channels: [] },
    });
    expect(issues.some((i) => i.toLowerCase().includes('channels'))).toBe(true);
  });
});
