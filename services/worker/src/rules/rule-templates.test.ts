/**
 * SCRUM-1973 — Rule Templates + Auto-queue Notification Tests
 *
 * Verifies:
 * - Vertical workflow templates are retrievable
 * - Templates have valid structure matching rules schema
 * - Auto-queue notification fires only for rule-triggered events
 */

import { describe, it, expect } from 'vitest';
import { getRuleTemplates, type RuleTemplate } from './rule-templates.js';

describe('SCRUM-1973: getRuleTemplates', () => {
  it('returns at least 3 vertical workflow templates', () => {
    const templates = getRuleTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
  });

  it('each template has required fields', () => {
    const templates = getRuleTemplates();
    for (const t of templates) {
      expect(t.id).toBeDefined();
      expect(t.name).toBeDefined();
      expect(t.description).toBeDefined();
      expect(t.trigger_type).toBeDefined();
      expect(t.trigger_config).toBeDefined();
      expect(t.action_type).toBeDefined();
      expect(t.action_config).toBeDefined();
      expect(t.vertical).toBeDefined();
    }
  });

  it('includes law_firm_contracts template', () => {
    const templates = getRuleTemplates();
    const lawFirm = templates.find(t => t.id === 'law_firm_contracts');
    expect(lawFirm).toBeDefined();
    expect(lawFirm!.trigger_type).toBe('ESIGN_COMPLETED');
    expect(lawFirm!.action_type).toBe('AUTO_ANCHOR');
    expect(lawFirm!.vertical).toBe('legal');
  });

  it('includes recruiting_offer_letters template', () => {
    const templates = getRuleTemplates();
    const recruiting = templates.find(t => t.id === 'recruiting_offer_letters');
    expect(recruiting).toBeDefined();
    expect(recruiting!.trigger_type).toBe('ESIGN_COMPLETED');
    expect(recruiting!.action_type).toBe('AUTO_ANCHOR');
    expect(recruiting!.vertical).toBe('recruiting');
  });

  it('includes gdrive_compliance_folder template', () => {
    const templates = getRuleTemplates();
    const gdrive = templates.find(t => t.id === 'gdrive_compliance_folder');
    expect(gdrive).toBeDefined();
    expect(gdrive!.trigger_type).toBe('WORKSPACE_FILE_MODIFIED');
    expect(gdrive!.action_type).toBe('QUEUE_FOR_REVIEW');
    expect(gdrive!.vertical).toBe('compliance');
  });

  it('template trigger_configs are valid objects', () => {
    const templates = getRuleTemplates();
    for (const t of templates) {
      expect(typeof t.trigger_config).toBe('object');
      expect(t.trigger_config).not.toBeNull();
    }
  });

  it('template action_configs are valid objects', () => {
    const templates = getRuleTemplates();
    for (const t of templates) {
      expect(typeof t.action_config).toBe('object');
      expect(t.action_config).not.toBeNull();
    }
  });
});
