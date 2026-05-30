import { describe, expect, it, vi } from 'vitest';
import {
  PE_EVAL_SYSTEM_PROMPT,
  buildPeUserPrompt,
  parsePeExtraction,
  createPeEntryExtractor,
  supportsPeRawModel,
  type PeRawModel,
} from './pe-eval-extraction.js';
import { GOLDEN_DATASET_PROFESSIONAL_EDUCATION } from './golden-dataset-professional-education.js';
import type { GoldenDatasetEntry } from './types.js';

const cpeEntry = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.find((e) => e.id === 'GD-PE-001')!;
const cleEntry = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.find(
  (e) => e.tags.includes('cle') && !e.tags.includes('cpe'),
)!;
const courseOnlyEntry = GOLDEN_DATASET_PROFESSIONAL_EDUCATION.find(
  (e) => e.tags.includes('course-id') && !e.tags.includes('cpe') && !e.tags.includes('cle'),
)!;

describe('pe-eval-extraction', () => {
  it('routes the CPE prompt to the gated CPE fields', () => {
    const prompt = buildPeUserPrompt(cpeEntry);
    expect(prompt).toMatch(/creditHours/);
    expect(prompt).toMatch(/deliveryMethod/);
    expect(prompt).toMatch(/nasbaStatus/);
    expect(prompt).toContain(cpeEntry.strippedText);
  });

  it('routes the CLE prompt to ethicsHours as a first-class field', () => {
    const prompt = buildPeUserPrompt(cleEntry);
    expect(prompt).toMatch(/ethicsHours/);
    expect(prompt).toMatch(/never infer ethicsHours/i);
    expect(prompt).toContain(cleEntry.strippedText);
  });

  it('routes course-id-only entries through the dedicated course-id prompt', () => {
    const prompt = buildPeUserPrompt(courseOnlyEntry);
    expect(prompt).toMatch(/course or activity identifier/i);
    expect(prompt).toMatch(/courseId/);
    expect(prompt).toContain(courseOnlyEntry.strippedText);
  });

  it('parses JSON, strips comments, and coerces numeric fields', () => {
    const parsed = parsePeExtraction(
      '{\n  // model chatter\n  "creditHours": "8.0",\n  "ethicsHours": "1",\n  "courseId": "AICPA-TAX-2026-118",\n  "confidence": 0.92\n}',
    );
    expect(parsed.fields.creditHours).toBe(8);
    expect(parsed.fields.ethicsHours).toBe(1);
    expect(parsed.fields.courseId).toBe('AICPA-TAX-2026-118');
    expect(parsed.confidence).toBeCloseTo(0.92);
  });

  it('detects providers that expose the raw-generate capability', () => {
    const withCap: PeRawModel = { generateExtractionJson: vi.fn() };
    expect(supportsPeRawModel(withCap)).toBe(true);
    expect(supportsPeRawModel({})).toBe(false);
  });

  it('extractor calls the raw model with the PE system prompt and returns parsed fields', async () => {
    const generateExtractionJson = vi.fn().mockResolvedValue({
      text: JSON.stringify({ ...cpeEntry.groundTruth, confidence: 0.95 }),
      tokensUsed: 42,
    });
    const provider = { name: 'fake', generateExtractionJson } as unknown as Parameters<
      ReturnType<typeof createPeEntryExtractor>
    >[0];

    const extractor = createPeEntryExtractor();
    const result = await extractor(provider, cpeEntry as GoldenDatasetEntry);

    expect(generateExtractionJson).toHaveBeenCalledTimes(1);
    const callArg = generateExtractionJson.mock.calls[0][0];
    expect(callArg.systemPrompt).toBe(PE_EVAL_SYSTEM_PROMPT);
    expect(callArg.userPrompt).toContain(cpeEntry.strippedText);
    expect(result.fields.deliveryMethod).toBe('Group Internet Based');
    expect(result.fields.creditHours).toBe(8);
    expect(result.tokensUsed).toBe(42);
  });

  it('fails loudly when the provider lacks the raw-generate capability', async () => {
    const extractor = createPeEntryExtractor();
    await expect(
      extractor({ name: 'no-cap' } as never, cpeEntry as GoldenDatasetEntry),
    ).rejects.toThrow(/generateExtractionJson/);
  });
});
