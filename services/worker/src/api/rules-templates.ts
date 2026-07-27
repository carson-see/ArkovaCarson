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
import { RULE_TEMPLATES, type RuleTemplate } from './rule-templates-data.js';

// Template data + type live in `rule-templates-data.ts` (dependency-free) so
// non-HTTP consumers can share them without importing express. Re-exported here
// to preserve the historical `from './rules-templates.js'` import surface.
export { RULE_TEMPLATES, type RuleTemplate };

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
  const templateId = req.params.templateId;

  // Validate templateId format — alphanumeric + hyphens only, max 100 chars.
  // Prevents reflected XSS (SonarCloud S5131) and log injection.
  if (!templateId || !/^[a-z0-9-]{1,100}$/.test(templateId)) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Invalid template ID format',
      },
    });
    return;
  }

  const template = TEMPLATES_BY_ID.get(templateId);
  if (!template) {
    res.status(404).json({
      error: {
        code: 'not_found',
        message: 'Template not found',
      },
    });
    return;
  }
  res.json({ item: template });
});
