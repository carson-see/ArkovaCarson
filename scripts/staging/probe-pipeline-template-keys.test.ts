/**
 * Unit tests for scripts/staging/probe-pipeline-template-keys.ts's pure
 * assertion logic (SCRUM-5106). No network — `evaluateProbeRow` takes an
 * in-memory row and returns a verdict; `main()` (the actual Supabase query)
 * is exercised only via the `--help` smoke check, which must not connect.
 */
import { describe, it, expect } from 'vitest';
import { evaluateProbeRow, PIPELINE_TEMPLATE_SOURCES } from './probe-pipeline-template-keys.js';

describe('evaluateProbeRow', () => {
  it('fails when no row is found', () => {
    const result = evaluateProbeRow(null);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no anchor row/);
  });

  it('fails when metadata has no pipeline_source', () => {
    const result = evaluateProbeRow({ id: 'a1', created_at: '2026-09-13T00:00:00Z', metadata: {} });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no string pipeline_source/);
  });

  it('passes (with a note) for a pipeline_source not in PIPELINE_TEMPLATE_SOURCES', () => {
    const result = evaluateProbeRow({
      id: 'a2',
      created_at: '2026-09-13T00:00:00Z',
      metadata: { pipeline_source: 'fcc' },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/no SOURCE_FIELD_TABLE entry/);
  });

  it('fails when a covered source has none of issuerName/licenseNumber/authors', () => {
    const result = evaluateProbeRow({
      id: 'a3',
      created_at: '2026-09-13T00:00:00Z',
      metadata: { pipeline_source: 'openalex', source_id: 'W1', source_url: null, record_type: 'article' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/none of issuerName\/licenseNumber\/authors/);
  });

  it('passes when issuerName is present', () => {
    const result = evaluateProbeRow({
      id: 'a4',
      created_at: '2026-09-13T00:00:00Z',
      metadata: { pipeline_source: 'openalex', issuerName: 'Journal of Testing' },
    });
    expect(result.ok).toBe(true);
  });

  it('passes when licenseNumber is present', () => {
    const result = evaluateProbeRow({
      id: 'a5',
      created_at: '2026-09-13T00:00:00Z',
      metadata: { pipeline_source: 'edgar', licenseNumber: '0000320193-26-000012' },
    });
    expect(result.ok).toBe(true);
  });

  it('passes when authors is a non-empty array, fails when it is empty', () => {
    const withAuthors = evaluateProbeRow({
      id: 'a6',
      created_at: '2026-09-13T00:00:00Z',
      metadata: { pipeline_source: 'openalex', authors: [{ name: 'Ada Lovelace' }] },
    });
    expect(withAuthors.ok).toBe(true);

    const emptyAuthors = evaluateProbeRow({
      id: 'a7',
      created_at: '2026-09-13T00:00:00Z',
      metadata: { pipeline_source: 'openalex', authors: [] },
    });
    expect(emptyAuthors.ok).toBe(false);
  });

  it('reports every key found on the row for both pass and fail cases', () => {
    const result = evaluateProbeRow({
      id: 'a8',
      created_at: '2026-09-13T00:00:00Z',
      metadata: { pipeline_source: 'calbar', licenseNumber: '345678', jurisdiction: 'US-CA' },
    });
    expect(result.keysFound.sort()).toEqual(['jurisdiction', 'licenseNumber', 'pipeline_source'].sort());
  });

  it('PIPELINE_TEMPLATE_SOURCES covers every source SOURCE_FIELD_TABLE declares (kept in sync manually — see file header)', () => {
    // Mirrors publicRecordTemplate.ts's SOURCE_FIELD_TABLE keys as of 2026-09-13.
    const expected = [
      'openalex', 'edgar', 'edgar_form_adv', 'sec_iapd', 'federal_register',
      'openstates', 'courtlistener', 'uspto', 'npi', 'finra', 'calbar',
      'dapip', 'acnc', 'acra_sg', 'cnpj_br', 'moh_sg', 'australia_law',
      'kenya_law', 'australia_caselaw', 'kenya_caselaw',
    ];
    expect(Array.from(PIPELINE_TEMPLATE_SOURCES).sort()).toEqual(expected.sort());
  });
});
