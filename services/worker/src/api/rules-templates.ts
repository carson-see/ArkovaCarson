/**
 * Rule Templates Discovery API (SCRUM-1126 — Smart Queue Rules)
 *
 * GET /api/v1/rules/templates         → list all available rule templates
 * GET /api/v1/rules/templates/:id     → get one template by ID
 *
 * Templates are static/in-memory (not DB-backed). They serve as starting
 * points that organization admins can apply to their org via the rules CRUD
 * endpoints. No auth required — this is a public discovery endpoint.
 */
import { Router } from 'express';

// =============================================================================
// Template type
// =============================================================================

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  trigger_type: string;
  default_trigger_config: Record<string, unknown>;
  action_type: string;
  default_action_config: Record<string, unknown>;
  category: 'integration' | 'vertical';
  icon: string;
}

// =============================================================================
// Static template definitions
// =============================================================================

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'google-drive-folder-watch',
    name: 'Google Drive Folder Watch',
    description:
      'Automatically queue documents for anchoring when new files appear in a watched Google Drive folder.',
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    default_trigger_config: {
      vendors: ['google_drive'],
    },
    action_type: 'QUEUE_FOR_REVIEW',
    default_action_config: {
      label: 'Drive upload',
      priority: 'medium',
    },
    category: 'integration',
    icon: 'hard-drive',
  },
  {
    id: 'docusign-completion',
    name: 'DocuSign Completion',
    description:
      'Secure documents immediately or queue them when a DocuSign envelope is fully executed.',
    trigger_type: 'ESIGN_COMPLETED',
    default_trigger_config: {
      vendors: ['docusign'],
    },
    action_type: 'AUTO_ANCHOR',
    default_action_config: {
      tag: 'docusign',
    },
    category: 'integration',
    icon: 'file-signature',
  },
  {
    id: 'microsoft-365-folder',
    name: 'Microsoft 365 Folder Watch',
    description:
      'Queue documents for anchoring when files are added or modified in a SharePoint or OneDrive folder.',
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    default_trigger_config: {
      vendors: ['sharepoint', 'onedrive'],
    },
    action_type: 'QUEUE_FOR_REVIEW',
    default_action_config: {
      label: 'Microsoft 365',
      priority: 'medium',
    },
    category: 'integration',
    icon: 'cloud',
  },
  {
    id: 'local-folder-watch',
    name: 'Local Folder Watch',
    description:
      'Queue documents when new files are detected in a locally-synced folder (via desktop agent).',
    trigger_type: 'WORKSPACE_FILE_MODIFIED',
    default_trigger_config: {
      folder_path_starts_with: '',
    },
    action_type: 'QUEUE_FOR_REVIEW',
    default_action_config: {
      label: 'Local folder',
      priority: 'medium',
    },
    category: 'integration',
    icon: 'folder-open',
  },
  {
    id: 'law-firm-contract',
    name: 'Law Firm — Executed Contract',
    description:
      'Instantly secure fully-signed contracts as soon as all parties complete e-signature.',
    trigger_type: 'ESIGN_COMPLETED',
    default_trigger_config: {
      vendors: ['docusign', 'adobe_sign'],
      semantic_match: {
        description: 'Fully executed contract or agreement with all signatures',
        threshold: 0.8,
      },
    },
    action_type: 'FAST_TRACK_ANCHOR',
    default_action_config: {
      tag: 'executed-contract',
      reason: 'All parties signed',
    },
    category: 'vertical',
    icon: 'scale',
  },
  {
    id: 'recruiting-onboarding',
    name: 'Recruiting — Onboarding Documents',
    description:
      'Queue completed onboarding documents (offer letters, NDAs) for anchoring after candidate signs.',
    trigger_type: 'ESIGN_COMPLETED',
    default_trigger_config: {
      vendors: ['docusign'],
      semantic_match: {
        description: 'Offer letter, NDA, or onboarding agreement',
        threshold: 0.75,
      },
    },
    action_type: 'QUEUE_FOR_REVIEW',
    default_action_config: {
      label: 'Onboarding',
      priority: 'high',
    },
    category: 'vertical',
    icon: 'user-plus',
  },
];

// Build a lookup map for O(1) access by ID
const TEMPLATES_BY_ID = new Map<string, RuleTemplate>(
  RULE_TEMPLATES.map((t) => [t.id, t]),
);

// =============================================================================
// Express Router
// =============================================================================

export const rulesTemplatesRouter = Router();

/** GET / — List all available rule templates */
rulesTemplatesRouter.get('/', (_req, res) => {
  res.json({
    items: RULE_TEMPLATES,
    count: RULE_TEMPLATES.length,
  });
});

/** GET /:templateId — Get a single template by ID */
rulesTemplatesRouter.get('/:templateId', (req, res) => {
  const template = TEMPLATES_BY_ID.get(req.params.templateId);
  if (!template) {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: `Template '${req.params.templateId}' not found`,
      },
    });
    return;
  }
  res.json({ item: template });
});
