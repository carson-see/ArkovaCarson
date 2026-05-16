/**
 * Rule Templates API (SCRUM-1973 / SCRUM-1126)
 *
 * GET /api/v1/rules/templates — List available rule templates (public, no auth)
 * GET /api/v1/rules/templates/:id — Get a specific template by ID
 */

import { Router, Request, Response } from 'express';
import { getRuleTemplates, getRuleTemplateById } from '../rules/rule-templates.js';

export const rulesTemplatesRouter = Router();

rulesTemplatesRouter.get('/templates', (_req: Request, res: Response) => {
  const templates = getRuleTemplates();
  res.json({ templates });
});

rulesTemplatesRouter.get('/templates/:id', (req: Request<{ id: string }>, res: Response) => {
  const template = getRuleTemplateById(req.params.id);
  if (!template) {
    res.status(404).json({ error: 'not_found', message: 'Template not found.' });
    return;
  }
  res.json({ template });
});
