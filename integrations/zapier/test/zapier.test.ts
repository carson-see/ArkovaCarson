/**
 * Zapier Integration Tests (INT-05)
 *
 * Tests Zapier app structure, trigger payloads, and action logic.
 * No real API calls — tests validate the Zapier app definition shape.
 */

import { describe, it, expect } from 'vitest';
import App from '../src/index';
import { BATCH_SYNC_LIMIT, VALID_EVENTS } from '../src/constants';

describe('Zapier App Structure', () => {
  it('exports a valid Zapier app definition', () => {
    expect(App.version).toBe('1.0.0');
    expect(App.platformVersion).toBe('15.0.0');
    expect(App.authentication).toBeDefined();
    expect(App.authentication.type).toBe('custom');
  });

  it('has required triggers', () => {
    expect(App.triggers.anchor_secured).toBeDefined();
    expect(App.triggers.anchor_revoked).toBeDefined();
  });

  it('has required actions', () => {
    expect(App.actions.anchor_document).toBeDefined();
    expect(App.actions.verify_credential).toBeDefined();
    expect(App.actions.batch_verify).toBeDefined();
  });

  it('triggers use hook type (REST hooks)', () => {
    expect(App.triggers.anchor_secured.operation.type).toBe('hook');
    expect(App.triggers.anchor_revoked.operation.type).toBe('hook');
  });
});

describe('Authentication', () => {
  it('requires apiKey field', () => {
    const fields = App.authentication.fields;
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe('apiKey');
    expect(fields[0].required).toBe(true);
  });

  it('has a connection label', () => {
    expect(App.authentication.connectionLabel).toContain('Arkova');
  });
});

describe('Anchor Secured Trigger', () => {
  const trigger = App.triggers.anchor_secured;

  it('has correct display metadata', () => {
    expect(trigger.display.label).toBe('New Anchor Secured');
    expect(trigger.display.important).toBe(true);
  });

  it('provides output fields', () => {
    const fields = trigger.operation.outputFields;
    const keys = fields.map((f: any) => f.key);
    expect(keys).toContain('public_id');
    expect(keys).toContain('fingerprint');
    expect(keys).toContain('status');
    expect(keys).toContain('credential_type');
    expect(keys).toContain('network_receipt_id');
  });

  it('provides a sample', () => {
    const sample = trigger.operation.sample;
    expect(sample.public_id).toMatch(/^ARK-/);
    expect(sample.status).toBe('SECURED');
    expect(sample.event_type).toBe('anchor.secured');
  });

  it('has subscribe and unsubscribe hooks', () => {
    expect(typeof trigger.operation.performSubscribe).toBe('function');
    expect(typeof trigger.operation.performUnsubscribe).toBe('function');
    expect(typeof trigger.operation.perform).toBe('function');
    expect(typeof trigger.operation.performList).toBe('function');
  });
});

describe('Anchor Revoked Trigger', () => {
  const trigger = App.triggers.anchor_revoked;

  it('has correct display metadata', () => {
    expect(trigger.display.label).toBe('Anchor Revoked');
  });

  it('provides revocation-specific fields', () => {
    const keys = trigger.operation.outputFields.map((f: any) => f.key);
    expect(keys).toContain('revoked_at');
    expect(keys).toContain('reason');
  });

  it('sample shows REVOKED status', () => {
    expect(trigger.operation.sample.status).toBe('REVOKED');
    expect(trigger.operation.sample.event_type).toBe('anchor.revoked');
  });
});

describe('Anchor Document Action', () => {
  const action = App.actions.anchor_document;

  it('requires fingerprint input', () => {
    const fields = action.operation.inputFields;
    const fp = fields.find((f: any) => f.key === 'fingerprint');
    expect(fp).toBeDefined();
    expect(fp.required).toBe(true);
  });

  it('offers credential type choices', () => {
    const fields = action.operation.inputFields;
    const ct = fields.find((f: any) => f.key === 'credential_type');
    expect(ct).toBeDefined();
    expect(ct.choices).toContain('DEGREE');
    expect(ct.choices).toContain('LICENSE');
    expect(ct.required).toBe(false);
  });

  it('has sample output with public_id', () => {
    expect(action.operation.sample.public_id).toMatch(/^ARK-/);
    expect(action.operation.sample.status).toBe('PENDING');
  });
});

describe('Verify Credential Action', () => {
  const action = App.actions.verify_credential;

  it('requires public_id input', () => {
    const fields = action.operation.inputFields;
    const pid = fields.find((f: any) => f.key === 'public_id');
    expect(pid).toBeDefined();
    expect(pid.required).toBe(true);
  });

  it('sample shows verified result', () => {
    expect(action.operation.sample.verified).toBe(true);
    expect(action.operation.sample.status).toBe('ACTIVE');
  });
});

describe('Batch Verify Action', () => {
  const action = App.actions.batch_verify;

  it('requires public_ids input', () => {
    const fields = action.operation.inputFields;
    const ids = fields.find((f: any) => f.key === 'public_ids');
    expect(ids).toBeDefined();
    expect(ids.required).toBe(true);
  });

  it('sample returns array of results', () => {
    expect(action.operation.sample.results).toHaveLength(2);
    expect(action.operation.sample.count).toBe(2);
  });
});

describe('Constants', () => {
  it('batch sync limit is 20', () => {
    expect(BATCH_SYNC_LIMIT).toBe(20);
  });

  it('valid events are defined', () => {
    expect(VALID_EVENTS).toContain('anchor.secured');
    expect(VALID_EVENTS).toContain('anchor.revoked');
    expect(VALID_EVENTS).toContain('anchor.expired');
  });
});
