/**
 * Rule Templates (SCRUM-1973 / SCRUM-1126)
 *
 * Pre-built rule configurations for vertical workflows.
 * Exposed via GET /api/v1/rules/templates (public, no auth needed for discovery).
 * Applied via existing rule create endpoint with template_id reference.
 */

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  vertical: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  action_type: string;
  action_config: Record<string, unknown>;
}

const TEMPLATES: readonly RuleTemplate[] = Object.freeze([
  {
    id: 'law_firm_contracts',
    name: 'Law Firm — Signed Contracts',
    description: 'Automatically anchor contracts after all parties have signed via DocuSign.',
    vertical: 'legal',
    trigger_type: 'ESIGN_COMPLETED',
    trigger_config: {
      vendors: ['docusign'],
      filename_contains: 'contract',
    },
    action_type: 'AUTO_ANCHOR',
    action_config: {
      tag: 'signed-contract',
    },
  },
  {
    id: 'recruiting_offer_letters',
    name: 'Recruiting — Signed Offer Letters',
    description: 'Anchor signed offer letters as soon as the candidate countersigns.',
    vertical: 'recruiting',
    trigger_type: 'ESIGN_COMPLETED',
    trigger_config: {
      vendors: ['docusign'],
      filename_contains: 'offer',
    },
    action_type: 'AUTO_ANCHOR',
    action_config: {
      tag: 'signed-offer',
    },
  },
  {
    id: 'gdrive_compliance_folder',
    name: 'Compliance — Google Drive Folder Watch',
    description: 'Route new or modified documents in a watched compliance folder to admin review.',
    vertical: 'compliance',
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    trigger_config: {
      vendors: ['google_drive'],
      folder_path_starts_with: '/Compliance',
    },
    action_type: 'QUEUE_FOR_REVIEW',
    action_config: {
      label: 'compliance-folder',
      priority: 'high',
    },
  },
  {
    id: 'background_check_results',
    name: 'HR — Background Check Results',
    description: 'Anchor background check results when received from verification providers.',
    vertical: 'hr',
    trigger_type: 'CONNECTOR_DOCUMENT_RECEIVED',
    trigger_config: {
      connector_type: 'checkr',
    },
    action_type: 'AUTO_ANCHOR',
    action_config: {
      tag: 'background-check',
    },
  },
  {
    id: 'nda_fast_track',
    name: 'Legal — Fast-Track NDA Anchoring',
    description: 'Immediately anchor signed NDAs using fast-track (consumes 1 credit).',
    vertical: 'legal',
    trigger_type: 'ESIGN_COMPLETED',
    trigger_config: {
      vendors: ['docusign', 'adobe_sign'],
      filename_contains: 'NDA',
    },
    action_type: 'FAST_TRACK_ANCHOR',
    action_config: {
      tag: 'nda-signed',
      reason: 'NDA requires immediate timestamping for enforceability.',
    },
  },
]);

export function getRuleTemplates(): readonly RuleTemplate[] {
  return TEMPLATES;
}

export function getRuleTemplateById(id: string): RuleTemplate | undefined {
  return TEMPLATES.find(t => t.id === id);
}
