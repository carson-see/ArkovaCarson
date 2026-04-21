/**
 * Tests for the pure ARK-106 rule evaluator.
 */
import { describe, it, expect } from 'vitest';
import { evaluateRule, evaluateRules, type RuleRow, type TriggerEvent } from './evaluator.js';

function rule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'r-1',
    org_id: 'org-1',
    name: 'test',
    enabled: true,
    trigger_type: 'ESIGN_COMPLETED',
    trigger_config: {},
    action_type: 'AUTO_ANCHOR',
    action_config: {},
    ...overrides,
  };
}

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return { trigger_type: 'ESIGN_COMPLETED', org_id: 'org-1', ...overrides };
}

describe('evaluateRule — guards', () => {
  it('skips disabled rules', () => {
    const r = evaluateRule(rule({ enabled: false }), event());
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('rule_disabled');
  });

  it('skips when org does not match', () => {
    const r = evaluateRule(rule({ org_id: 'org-A' }), event({ org_id: 'org-B' }));
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('org_mismatch');
  });

  it('skips when trigger_type differs', () => {
    const r = evaluateRule(
      rule({ trigger_type: 'ESIGN_COMPLETED' }),
      event({ trigger_type: 'MANUAL_UPLOAD' }),
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('trigger_type_mismatch');
  });
});

describe('evaluateRule — ESIGN_COMPLETED', () => {
  it('matches plain when config is empty', () => {
    const r = evaluateRule(rule(), event({ vendor: 'docusign', filename: 'contract.pdf' }));
    expect(r.matched).toBe(true);
  });

  it('filters by vendor allowlist', () => {
    const r1 = evaluateRule(
      rule({ trigger_config: { vendors: ['docusign'] } }),
      event({ vendor: 'adobe_sign' }),
    );
    expect(r1.matched).toBe(false);

    const r2 = evaluateRule(
      rule({ trigger_config: { vendors: ['docusign', 'adobe_sign'] } }),
      event({ vendor: 'docusign' }),
    );
    expect(r2.matched).toBe(true);
  });

  it('filters filename_contains case-insensitively', () => {
    const r = evaluateRule(
      rule({ trigger_config: { filename_contains: 'MSA' } }),
      event({ filename: 'acme-msa-v3.pdf' }),
    );
    expect(r.matched).toBe(true);
  });

  it('filters sender_email_equals case-insensitively', () => {
    const r = evaluateRule(
      rule({ trigger_config: { sender_email_equals: 'hr@acme.com' } }),
      event({ sender_email: 'HR@acme.com' }),
    );
    expect(r.matched).toBe(true);
  });

  it('rejects on sender mismatch', () => {
    const r = evaluateRule(
      rule({ trigger_config: { sender_email_equals: 'hr@acme.com' } }),
      event({ sender_email: 'other@acme.com' }),
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('sender_email_filter_rejected');
  });

  it('surfaces semantic_match config when present', () => {
    const r = evaluateRule(
      rule({
        trigger_config: { semantic_match: { description: 'MSA', threshold: 0.8 } },
      }),
      event(),
    );
    expect(r.matched).toBe(true);
    expect(r.needs_semantic_match).toBe(true);
    expect(r.semantic_match).toEqual({ description: 'MSA', threshold: 0.8 });
  });

  it('defaults threshold to 0.75 if out of range', () => {
    const r = evaluateRule(
      rule({
        trigger_config: { semantic_match: { description: 'MSA', threshold: 0.1 } },
      }),
      event(),
    );
    expect(r.semantic_match?.threshold).toBe(0.75);
  });
});

describe('evaluateRule — WORKSPACE_FILE_MODIFIED', () => {
  it('filters folder_path_starts_with case-insensitively', () => {
    const r = evaluateRule(
      rule({
        trigger_type: 'WORKSPACE_FILE_MODIFIED',
        trigger_config: { folder_path_starts_with: '/HR/' },
      }),
      event({ trigger_type: 'WORKSPACE_FILE_MODIFIED', folder_path: '/hr/contracts/2026' }),
    );
    expect(r.matched).toBe(true);
  });

  it('rejects vendor outside allowlist', () => {
    const r = evaluateRule(
      rule({
        trigger_type: 'WORKSPACE_FILE_MODIFIED',
        trigger_config: { vendors: ['google_drive'] },
      }),
      event({ trigger_type: 'WORKSPACE_FILE_MODIFIED', vendor: 'onedrive' }),
    );
    expect(r.matched).toBe(false);
  });
});

describe('evaluateRule — CONNECTOR_DOCUMENT_RECEIVED', () => {
  it('matches when connector_type matches vendor', () => {
    const r = evaluateRule(
      rule({
        trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
        trigger_config: { connector_type: 'veremark' },
      }),
      event({ trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED', vendor: 'veremark' }),
    );
    expect(r.matched).toBe(true);
  });

  it('rejects on connector_type mismatch', () => {
    const r = evaluateRule(
      rule({
        trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
        trigger_config: { connector_type: 'veremark' },
      }),
      event({ trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED', vendor: 'checkr' }),
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toBe('connector_type_mismatch');
  });
});

describe('evaluateRule — EMAIL_INTAKE', () => {
  it('filters subject_contains case-insensitively', () => {
    const r = evaluateRule(
      rule({
        trigger_type: 'EMAIL_INTAKE',
        trigger_config: { subject_contains: 'invoice' },
      }),
      event({ trigger_type: 'EMAIL_INTAKE', subject: 'Your INVOICE #12345' }),
    );
    expect(r.matched).toBe(true);
  });
});

describe('evaluateRule — cron-driven triggers pass through', () => {
  it.each(['SCHEDULED_CRON', 'QUEUE_DIGEST', 'MANUAL_UPLOAD'] as const)(
    '%s matches unconditionally (caller gates timing)',
    (t) => {
      const r = evaluateRule(
        rule({ trigger_type: t }),
        event({ trigger_type: t }),
      );
      expect(r.matched).toBe(true);
    },
  );
});

describe('evaluateRules (bulk)', () => {
  it('returns only matched rules', () => {
    const rules: RuleRow[] = [
      rule({ id: 'r1', enabled: true }),
      rule({ id: 'r2', enabled: false }),
      rule({ id: 'r3', trigger_config: { vendors: ['adobe_sign'] } }),
    ];
    const matched = evaluateRules(rules, event({ vendor: 'docusign' }));
    expect(matched).toHaveLength(1);
    expect(matched[0].rule.id).toBe('r1');
  });
});
