/**
 * Fine-Tune Exporter Tests (Phase 3 — Training Pipeline Scale-Up)
 *
 * TDD: Tests for stratified export, quality filtering, and format validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatTrainingExample, stratifyByType, exportFineTuneData } from './finetune-exporter.js';
import type { RawTrainingRecord, FineTuneExportConfig } from './finetune-exporter.js';
import { SERVER_MODEL, CLIENT_MODEL } from '../modelTargets.js';

// Mock fs and logger
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeRecord(overrides: Partial<RawTrainingRecord> = {}): RawTrainingRecord {
  return {
    id: 'rec-001',
    text: 'University of Michigan. Bachelor of Science in Computer Science. Conferred on May 3, 2025. Ann Arbor, Michigan.',
    credentialType: 'DEGREE',
    extractedFields: {
      credentialType: 'DEGREE',
      issuerName: 'University of Michigan',
      issuedDate: '2025-05-03',
      fieldOfStudy: 'Computer Science',
      confidence: 0.92,
      fraudSignals: [],
    },
    fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

describe('formatTrainingExample', () => {
  it('converts a record to conversation format', () => {
    const record = makeRecord();
    const result = formatTrainingExample(record);

    expect(result).toBeTruthy();
    expect(result!.messages).toHaveLength(3); // system + user + assistant
    expect(result!.messages[0].role).toBe('system');
    expect(result!.messages[1].role).toBe('user');
    expect(result!.messages[2].role).toBe('assistant');
  });

  it('includes credential type hint in user prompt', () => {
    const record = makeRecord({ credentialType: 'LICENSE' });
    const result = formatTrainingExample(record);

    expect(result!.messages[1].content).toContain('LICENSE');
  });

  it('assistant response is valid JSON', () => {
    const record = makeRecord();
    const result = formatTrainingExample(record);

    const parsed = JSON.parse(result!.messages[2].content);
    expect(parsed.credentialType).toBe('DEGREE');
    expect(parsed.issuerName).toBe('University of Michigan');
  });

  it('omits system prompt when includeSystemPrompt=false', () => {
    const record = makeRecord();
    const result = formatTrainingExample(record, false);

    expect(result!.messages).toHaveLength(2); // user + assistant only
    expect(result!.messages[0].role).toBe('user');
  });

  it('filters records with text too short', () => {
    const record = makeRecord({ text: 'Short' });
    const result = formatTrainingExample(record);
    expect(result).toBeNull();
  });

  it('filters records with text too long', () => {
    const record = makeRecord({ text: 'x'.repeat(25_000) });
    const result = formatTrainingExample(record);
    expect(result).toBeNull();
  });

  it('filters records with no extracted fields', () => {
    const record = makeRecord({ extractedFields: {} });
    const result = formatTrainingExample(record);
    expect(result).toBeNull();
  });

  it('filters records with empty credential type', () => {
    const record = makeRecord({ credentialType: '' });
    const result = formatTrainingExample(record);
    expect(result).toBeNull();
  });

  it('uses JSON.stringify for text injection prevention', () => {
    const record = makeRecord({
      text: 'Normal text with "quotes" and \\backslashes\\ and \nnewlines',
    });
    const result = formatTrainingExample(record);
    // JSON.stringify escapes the text so it can't break out of the prompt
    expect(result!.messages[1].content).toContain('Normal text with');
  });
});

describe('stratifyByType', () => {
  it('groups records by credential type', () => {
    const records = [
      makeRecord({ id: '1', credentialType: 'DEGREE' }),
      makeRecord({ id: '2', credentialType: 'DEGREE' }),
      makeRecord({ id: '3', credentialType: 'LICENSE' }),
    ];
    const { stats } = stratifyByType(records);

    expect(stats['DEGREE']).toBe(2);
    expect(stats['LICENSE']).toBe(1);
  });

  it('caps per-type when maxPerType is set', () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      makeRecord({ id: `rec-${i}`, credentialType: 'DEGREE' }),
    );
    const { stats, stratified } = stratifyByType(records, 20);

    expect(stats['DEGREE']).toBe(20);
    expect(stratified.length).toBe(20);
  });

  it('warns about empty credential types', () => {
    const records = [makeRecord({ credentialType: 'DEGREE' })];
    const { warnings } = stratifyByType(records);

    // Should warn about all types that have 0 records (15 types missing)
    const emptyWarnings = warnings.filter(w => w.includes('No records for type'));
    expect(emptyWarnings.length).toBeGreaterThan(10);
  });

  it('warns about underrepresented types', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ id: `rec-${i}`, credentialType: 'PATENT' }),
    );
    const { warnings } = stratifyByType(records);

    const patentWarning = warnings.find(w => w.includes('PATENT'));
    expect(patentWarning).toContain('5 records');
    expect(patentWarning).toContain('underrepresented');
  });

  it('includes all 16 standard types in stats', () => {
    const records = [makeRecord()];
    const { stats } = stratifyByType(records);

    const types = Object.keys(stats);
    expect(types).toContain('DEGREE');
    expect(types).toContain('SEC_FILING');
    expect(types).toContain('REGULATION');
    expect(types).toContain('PUBLICATION');
  });
});

describe('exportFineTuneData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const serverConfig: FineTuneExportConfig = {
    outputDir: '/tmp/test-training',
    target: SERVER_MODEL,
    includeSystemPrompt: true,
  };

  const clientConfig: FineTuneExportConfig = {
    outputDir: '/tmp/test-training',
    target: CLIENT_MODEL,
    includeSystemPrompt: false,
  };

  it('exports records and returns stats', () => {
    const records = [
      makeRecord({ id: '1', credentialType: 'DEGREE' }),
      makeRecord({ id: '2', credentialType: 'LICENSE' }),
    ];

    const stats = exportFineTuneData(records, serverConfig);

    expect(stats.totalExported).toBe(2);
    expect(stats.totalFiltered).toBe(0);
    expect(stats.outputPath).toContain('finetune-server-8b.jsonl');
  });

  it('filters low-quality records and tracks reasons', () => {
    const records = [
      makeRecord({ id: '1' }), // good
      makeRecord({ id: '2', text: 'short' }), // filtered: too short
      makeRecord({ id: '3', extractedFields: {} }), // filtered: no fields
    ];

    const stats = exportFineTuneData(records, serverConfig);

    expect(stats.totalExported).toBe(1);
    expect(stats.totalFiltered).toBe(2);
    expect(stats.filteredReasons['text_too_short']).toBe(1);
    expect(stats.filteredReasons['no_extracted_fields']).toBe(1);
  });

  it('generates correct output path for client model', () => {
    const records = [makeRecord()];
    const stats = exportFineTuneData(records, clientConfig);

    expect(stats.outputPath).toContain('finetune-client-3b.jsonl');
  });

  it('includes warnings about missing credential types', () => {
    const records = [makeRecord({ credentialType: 'DEGREE' })];
    const stats = exportFineTuneData(records, serverConfig);

    expect(stats.warnings.length).toBeGreaterThan(0);
    expect(stats.warnings.some(w => w.includes('No records'))).toBe(true);
  });

  it('handles empty record set', () => {
    const stats = exportFineTuneData([], serverConfig);

    expect(stats.totalExported).toBe(0);
    expect(stats.totalFiltered).toBe(0);
  });
});
