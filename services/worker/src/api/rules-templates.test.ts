/**
 * SCRUM-1126 — Rule Templates Discovery API tests.
 *
 * GET /api/v1/rules/templates       → list all available templates
 * GET /api/v1/rules/templates/:id   → get a single template by ID
 *
 * Templates are static/in-memory — no DB mocking needed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { rulesTemplatesRouter, RULE_TEMPLATES } from './rules-templates.js';

// ─── Zod schema for response validation ───
const RuleTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  trigger_type: z.string().min(1),
  default_trigger_config: z.record(z.string(), z.unknown()),
  action_type: z.string().min(1),
  default_action_config: z.record(z.string(), z.unknown()),
  category: z.enum(['integration', 'vertical']),
  icon: z.string().min(1),
});

const ListResponseSchema = z.object({
  items: z.array(RuleTemplateSchema),
  count: z.number().int().min(1),
});

const DetailResponseSchema = z.object({
  item: RuleTemplateSchema,
});

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

// ─── Test app setup ───
let app: express.Express;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/v1/rules/templates', rulesTemplatesRouter);
});

describe('GET /api/v1/rules/templates', () => {
  it('returns all templates with correct shape', async () => {
    const res = await request(app).get('/api/v1/rules/templates');

    expect(res.status).toBe(200);
    const parsed = ListResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.count).toBe(RULE_TEMPLATES.length);
  });

  it('includes the expected template IDs', async () => {
    const res = await request(app).get('/api/v1/rules/templates');

    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain('google-drive-folder-watch');
    expect(ids).toContain('docusign-completion');
    expect(ids).toContain('microsoft-365-folder');
    expect(ids).toContain('local-folder-watch');
    expect(ids).toContain('law-firm-contract');
    expect(ids).toContain('recruiting-onboarding');
  });

  it('every template passes Zod validation individually', async () => {
    const res = await request(app).get('/api/v1/rules/templates');

    for (const item of res.body.items as unknown[]) {
      const parsed = RuleTemplateSchema.safeParse(item);
      expect(parsed.success).toBe(true);
    }
  });
});

describe('GET /api/v1/rules/templates/:templateId', () => {
  it('returns a specific template by ID', async () => {
    const res = await request(app).get('/api/v1/rules/templates/google-drive-folder-watch');

    expect(res.status).toBe(200);
    const parsed = DetailResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.item.id).toBe('google-drive-folder-watch');
  });

  it('returns 404 for unknown template ID', async () => {
    const res = await request(app).get('/api/v1/rules/templates/nonexistent-template');

    expect(res.status).toBe(404);
    const parsed = ErrorResponseSchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 404 for empty template ID path segment', async () => {
    // Express will route /api/v1/rules/templates/ to the list handler, so
    // this test validates that a non-matching slug returns 404.
    const res = await request(app).get('/api/v1/rules/templates/---');

    expect(res.status).toBe(404);
  });
});

describe('RULE_TEMPLATES static data integrity', () => {
  it('has at least 6 templates', () => {
    expect(RULE_TEMPLATES.length).toBeGreaterThanOrEqual(6);
  });

  it('all IDs are unique', () => {
    const ids = RULE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('trigger_type values use known enum values', () => {
    const knownTriggers = [
      'ESIGN_COMPLETED',
      'WORKSPACE_FILE_MODIFIED',
      'CONNECTOR_DOCUMENT_RECEIVED',
      'MANUAL_UPLOAD',
      'SCHEDULED_CRON',
      'QUEUE_DIGEST',
      'EMAIL_INTAKE',
    ];
    for (const t of RULE_TEMPLATES) {
      expect(knownTriggers).toContain(t.trigger_type);
    }
  });

  it('action_type values use known enum values', () => {
    const knownActions = [
      'AUTO_ANCHOR',
      'FAST_TRACK_ANCHOR',
      'QUEUE_FOR_REVIEW',
      'FLAG_COLLISION',
      'NOTIFY',
      'FORWARD_TO_URL',
    ];
    for (const t of RULE_TEMPLATES) {
      expect(knownActions).toContain(t.action_type);
    }
  });
});
