/**
 * AI-03 lock-ins (SCRUM-2383) — /api/v1/ai/template privacy contract.
 *
 * (a) Schema-lint: the request Zod schema accepts ONLY already-extracted,
 *     PII-stripped fields + confidence — no bytes / base64 / raw-document
 *     shaped payloads, structurally or smuggled inside `fields`.
 * (b) Telemetry value-omission: a known-PII field value fed through the route
 *     never appears in ANY logging/telemetry payload emitted on this path —
 *     field names/counts/confidence only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ── Mocks (must be declared before importing the router) ──

const loggedPayloads: unknown[][] = [];
vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn((...args: unknown[]) => loggedPayloads.push(args)),
    warn: vi.fn((...args: unknown[]) => loggedPayloads.push(args)),
    error: vi.fn((...args: unknown[]) => loggedPayloads.push(args)),
    debug: vi.fn((...args: unknown[]) => loggedPayloads.push(args)),
  },
}));

const reconstructTemplate = vi.fn();
const generateTags = vi.fn();
vi.mock('../../../ai/gemini.js', () => ({
  GeminiProvider: class {
    reconstructTemplate = reconstructTemplate;
    generateTags = generateTags;
  },
}));

import { aiTemplateRouter, TemplateRequestSchema, TagsRequestSchema } from '../ai-template.js';

const PII_VALUE = 'Bartholomew Quincy Fictitious III';
const PII_LICENSE = 'XX-PII-998877-SENTINEL';

function buildApp(userId: string | undefined = 'user-test-1') {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/ai', aiTemplateRouter);
  return app;
}

beforeEach(() => {
  loggedPayloads.length = 0;
  reconstructTemplate.mockReset();
  generateTags.mockReset();
});

// ── (a) Schema lint ──

describe('AI-03 lock-in (a): /ai/template request schema carries no document payloads', () => {
  it('top-level shape is exactly { fields, confidence } — no bytes/base64/document keys', () => {
    const keys = Object.keys(TemplateRequestSchema.shape).sort();
    expect(keys).toEqual(['confidence', 'fields']);
    const banned = /bytes|base64|blob|document|file|raw|content|payload|data/i;
    for (const key of keys) {
      expect(key).not.toMatch(banned);
    }
    expect(Object.keys(TagsRequestSchema.shape)).toEqual(['fields']);
  });

  it('accepts a normal extracted-metadata payload', () => {
    const parsed = TemplateRequestSchema.safeParse({
      fields: { credentialType: 'CPE', issuerName: 'Example Institute', creditHours: 4 },
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
  });

  it('REJECTS document-byte-shaped keys smuggled inside fields', () => {
    for (const key of ['documentBytes', 'base64', 'rawDocument', 'fileData', 'blob', 'dataUrl']) {
      const parsed = TemplateRequestSchema.safeParse({
        fields: { [key]: 'AAAA' },
        confidence: 0.5,
      });
      expect(parsed.success, `key "${key}" must be rejected`).toBe(false);
    }
  });

  it('REJECTS data: URIs and oversized string values (byte smuggling)', () => {
    const dataUri = TemplateRequestSchema.safeParse({
      fields: { issuerName: 'data:application/pdf;base64,JVBERi0xLjQ=' },
      confidence: 0.5,
    });
    expect(dataUri.success).toBe(false);

    const oversized = TemplateRequestSchema.safeParse({
      fields: { issuerName: 'A'.repeat(25_000) },
      confidence: 0.5,
    });
    expect(oversized.success).toBe(false);
  });

  it('the same guard protects /ai/tags', () => {
    expect(TagsRequestSchema.safeParse({ fields: { documentBytes: 'AAAA' } }).success).toBe(false);
  });

  // ── Recursive guard (Carson P1, round-1 review): fields values are
  //    z.unknown(), so smuggling one level down must also be rejected. ──

  it('REJECTS banned keys nested inside objects at any depth', () => {
    const oneLevel = TemplateRequestSchema.safeParse({
      fields: { metadata: { rawDocument: 'JVBERi0xLjQ=' } },
      confidence: 0.9,
    });
    expect(oneLevel.success).toBe(false);

    const deep = TemplateRequestSchema.safeParse({
      fields: { a: { b: { c: { dataUrl: 'ZG9jdW1lbnQ=' } } } },
      confidence: 0.9,
    });
    expect(deep.success).toBe(false);

    const inArray = TemplateRequestSchema.safeParse({
      fields: { attachments: [{ fileData: 'AAAA' }] },
      confidence: 0.9,
    });
    expect(inArray.success).toBe(false);
  });

  it('REJECTS data: URIs and oversized strings nested inside objects/arrays', () => {
    const nestedDataUri = TemplateRequestSchema.safeParse({
      fields: { meta: { preview: 'data:application/pdf;base64,JVBERi0xLjQ=' } },
      confidence: 0.5,
    });
    expect(nestedDataUri.success).toBe(false);

    const nestedOversized = TemplateRequestSchema.safeParse({
      fields: { notes: [{ body: 'A B '.repeat(7_000) }] },
      confidence: 0.5,
    });
    expect(nestedOversized.success).toBe(false);
  });

  it('REJECTS base64-shaped long strings at any depth (no data: prefix needed)', () => {
    // 800 chars of pure base64 alphabet — a document chunk without the data: marker.
    const base64Chunk = 'QUJDRGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo0MzIx'.repeat(20);
    const parsed = TemplateRequestSchema.safeParse({
      fields: { extra: { note: base64Chunk } },
      confidence: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS payloads chunked across many keys (cumulative string budget)', () => {
    // Each chunk is individually under the per-value cap and NOT base64-shaped
    // (contains spaces), but together they smuggle a document.
    const fields: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      fields[`part${i}`] = `chunk ${i} `.repeat(250); // ~2,250 chars each
    }
    const parsed = TemplateRequestSchema.safeParse({ fields, confidence: 0.5 });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS payloads chunked into the KEY NAMES themselves', () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < 3; i++) {
      // ~500-char keys — content smuggled as key names, values benign.
      fields[`k${i}-${'docchunk'.repeat(64)}`] = 'x';
    }
    const parsed = TemplateRequestSchema.safeParse({ fields, confidence: 0.5 });
    expect(parsed.success).toBe(false);
  });

  it('REJECTS absurdly deep nesting (fail-closed instead of walking forever)', () => {
    let nested: unknown = 'value';
    for (let i = 0; i < 40; i++) nested = { level: nested };
    const parsed = TemplateRequestSchema.safeParse({
      fields: { root: nested },
      confidence: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('still ACCEPTS nested benign metadata (objects/arrays of short strings)', () => {
    const parsed = TemplateRequestSchema.safeParse({
      fields: {
        credentialType: 'CPE',
        issuerName: 'Example Institute',
        creditBreakdown: { general: 6, ethics: 2 },
        tags: ['education', 'accounting'],
      },
      confidence: 0.9,
    });
    expect(parsed.success).toBe(true);
  });

  it('never echoes smuggled VALUES in validation issues (key paths only)', () => {
    const smuggled = 'SMUGGLED-DOC-BYTES-SENTINEL-' + 'x'.repeat(600);
    const parsed = TemplateRequestSchema.safeParse({
      fields: { metadata: { rawDocument: smuggled } },
      confidence: 0.9,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).not.toContain('SMUGGLED-DOC-BYTES-SENTINEL');
    }
  });
});

// ── (b) Telemetry value-omission ──

describe('AI-03 lock-in (b): telemetry on the template path never carries field values', () => {
  it('success path logs names/counts/confidence only — the PII value never appears', async () => {
    reconstructTemplate.mockResolvedValue({
      templateType: 'formal',
      documentTitle: 'Credential',
      sections: [],
      tags: ['education'],
      documentType: 'CPE Certificate',
      summary: 'A credential summary',
      verificationNotes: null,
      tokensUsed: 10,
    });

    const res = await request(buildApp())
      .post('/api/v1/ai/template')
      .send({
        fields: { issuerName: PII_VALUE, licenseNumber: PII_LICENSE },
        confidence: 0.9,
      });

    expect(res.status).toBe(200);
    expect(loggedPayloads.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(loggedPayloads);
    expect(serialized).not.toContain(PII_VALUE);
    expect(serialized).not.toContain(PII_LICENSE);
  });

  it('error path logs a bounded error name — never the field values (even if the provider echoes them)', async () => {
    // Worst case: a provider error that EMBEDS a request field value in its
    // message. The route must not pass that message (or the error object) to
    // the logger.
    reconstructTemplate.mockRejectedValue(
      new Error(`model rejected input containing ${PII_VALUE}`),
    );

    const res = await request(buildApp())
      .post('/api/v1/ai/template')
      .send({ fields: { issuerName: PII_VALUE }, confidence: 0.9 });

    expect(res.status).toBe(500);
    const serialized = JSON.stringify(loggedPayloads);
    expect(serialized).not.toContain(PII_VALUE);
    // Response body must not echo values either.
    expect(JSON.stringify(res.body)).not.toContain(PII_VALUE);
  });

  it('validation-error path does not echo submitted values', async () => {
    const res = await request(buildApp())
      .post('/api/v1/ai/template')
      .send({ fields: { issuerName: PII_VALUE }, confidence: 'very-high' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(PII_VALUE);
    expect(JSON.stringify(loggedPayloads)).not.toContain(PII_VALUE);
  });

  it('tags path is covered by the same value-omission contract', async () => {
    generateTags.mockResolvedValue({ tags: ['education'], documentType: 'CPE', category: 'credential', subcategory: null });

    const res = await request(buildApp())
      .post('/api/v1/ai/tags')
      .send({ fields: { issuerName: PII_VALUE } });

    expect(res.status).toBe(200);
    expect(JSON.stringify(loggedPayloads)).not.toContain(PII_VALUE);
  });
});
