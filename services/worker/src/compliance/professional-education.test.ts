import { describe, expect, it } from 'vitest';
import {
  CPE_DELIVERY_METHODS,
  NASBA_FIELDS_OF_STUDY,
  CLE_DELIVERY_FORMATS,
  CleMetadataSchema,
  CpeMetadataSchema,
  buildProfessionalEducationJobPayload,
  classifyProfessionalEducationAnchor,
  extractAndPersistProfessionalEducationMetadata,
  normalizeCleMetadata,
  normalizeCpeMetadata,
} from './professional-education.js';
import type { IAIProvider } from '../ai/types.js';
import type { ExtractedFields } from '../ai/types.js';

describe('professional education metadata schemas', () => {
  it('keeps the NASBA field and CPE delivery vocabularies complete', () => {
    expect(NASBA_FIELDS_OF_STUDY).toHaveLength(19);
    expect(NASBA_FIELDS_OF_STUDY).toContain('Regulatory Ethics');
    expect(CPE_DELIVERY_METHODS).toEqual([
      'Group Live',
      'Group Internet Based',
      'QAS Self-Study',
      'Nano Learning',
      'Blended Learning',
      'University/College',
      'Other',
    ]);
  });

  it('validates CPE metadata and forces manual review below confidence threshold', () => {
    const parsed = normalizeCpeMetadata({
      credit_hours: 8,
      field_of_study: 'Taxes',
      delivery_method: 'Group Live',
      sponsor_id: '112891',
      reporting_period_start: null,
      reporting_period_end: null,
      extraction_confidence: 0.84,
      extraction_source: 'ai',
      nasba_status: 'confirmed',
      nasba_lookup_date: '2026-05-20',
      requires_manual_review: false,
    });

    expect(parsed.requires_manual_review).toBe(true);
    expect(CpeMetadataSchema.safeParse(parsed).success).toBe(true);
  });

  it('rejects CPE metadata outside the approved taxonomy', () => {
    const result = CpeMetadataSchema.safeParse({
      credit_hours: 1,
      field_of_study: 'Made Up Field',
      delivery_method: 'Group Live',
      requires_manual_review: true,
    });

    expect(result.success).toBe(false);
  });

  it('keeps CLE ethics hours first-class and review-required when missing', () => {
    expect(CLE_DELIVERY_FORMATS).toEqual(['Live', 'On-Demand', 'In-Person', 'Blended', 'Other']);

    const parsed = normalizeCleMetadata({
      credit_hours: 3,
      ethics_hours: null,
      jurisdiction: 'NY',
      approved_provider_name: 'Practising Law Institute',
      provider_approval_status: 'approved',
      provider_lookup_date: '2026-05-20',
      delivery_format: 'On-Demand',
      course_title: 'Professional Responsibility Update',
      course_id: 'PLI-ETH-2026',
      reporting_period_start: null,
      reporting_period_end: null,
      extraction_confidence: 0.93,
      extraction_source: 'ai',
      requires_manual_review: false,
    });

    expect(parsed.requires_manual_review).toBe(true);
    expect(CleMetadataSchema.safeParse(parsed).success).toBe(true);
  });

  it('classifies CPE/CLE anchors from credential type and public evidence metadata', () => {
    expect(classifyProfessionalEducationAnchor({ credentialType: 'CPE' })).toBe('CPE');
    expect(classifyProfessionalEducationAnchor({ credentialType: 'CLE' })).toBe('CLE');
    expect(classifyProfessionalEducationAnchor({
      metadata: {
        credential_title: 'Advanced Tax Planning CPE',
        credential_issuer: 'Udemy',
      },
    })).toBe('CPE');
    expect(classifyProfessionalEducationAnchor({
      metadata: {
        credential_title: 'Ethics CLE Update',
        credential_issuer: 'Westlaw CLE',
      },
    })).toBe('CLE');
  });

  it('builds a post-anchor async extraction job payload only for professional education', () => {
    expect(buildProfessionalEducationJobPayload({
      id: '550e8400-e29b-41d4-a716-446655440000',
      public_id: 'ARK-2026-CPE1',
      credential_type: 'CPE',
      fingerprint: 'a'.repeat(64),
      org_id: 'org-1',
      user_id: 'user-1',
      metadata: { credential_title: 'Tax CPE' },
    })).toMatchObject({
      anchorId: '550e8400-e29b-41d4-a716-446655440000',
      educationKind: 'CPE',
    });

    expect(buildProfessionalEducationJobPayload({
      id: '550e8400-e29b-41d4-a716-446655440001',
      public_id: 'ARK-2026-DEG1',
      credential_type: 'DEGREE',
      fingerprint: 'b'.repeat(64),
      org_id: 'org-1',
      user_id: 'user-1',
      metadata: { credential_title: 'Bachelor of Science' },
    })).toBeNull();
  });

  it('persists CPE extraction metadata with provider registry enrichment and audit', async () => {
    const db = makeProfessionalEducationDb();
    const provider = makeProvider({
      credit_hours: 8,
      field_of_study: 'Taxes',
      delivery_method: 'QAS Self-Study',
      extraction_confidence: 0.92,
      requires_manual_review: false,
    });

    const result = await extractAndPersistProfessionalEducationMetadata({
      db,
      provider,
      anchor: makeAnchor('CPE', {
        source_url: 'https://udemy.com/certificate/UC-123',
        credential_title: 'Advanced Tax Planning',
        credential_issuer: 'Udemy',
      }),
      educationKind: 'CPE',
    });

    expect(result.metadata).toMatchObject({
      credit_hours: 8,
      field_of_study: 'Taxes',
      nasba_status: 'confirmed',
      nasba_lookup_date: '2026-05-14',
      requires_manual_review: false,
    });
    expect(db.anchorUpdates[0]).toHaveProperty('cpe_metadata');
    expect(db.auditEvents[0]).toMatchObject({
      event_type: 'cpe_metadata.extracted',
      event_category: 'AI',
      target_type: 'anchor',
    });
  });

  it('persists CLE extraction metadata with multi-state provider lookup', async () => {
    const db = makeProfessionalEducationDb();
    const provider = makeProvider({
      credit_hours: 3,
      ethics_hours: 1,
      jurisdiction: 'NY',
      providerName: 'Westlaw CLE',
      delivery_format: 'On-Demand',
      course_title: 'Professional Responsibility Update',
      course_id: 'WL-CLE-2026-ETH',
      extraction_confidence: 0.91,
      requires_manual_review: false,
    });

    const result = await extractAndPersistProfessionalEducationMetadata({
      db,
      provider,
      anchor: makeAnchor('CLE', {
        source_url: 'https://legal.thomsonreuters.com/cle/course/WL-CLE-2026-ETH',
        credential_title: 'Professional Responsibility Update',
        credential_issuer: 'Westlaw CLE',
      }),
      educationKind: 'CLE',
    });

    expect(result.metadata).toMatchObject({
      credit_hours: 3,
      ethics_hours: 1,
      jurisdiction: 'NY',
      approved_provider_name: 'Westlaw CLE',
      provider_approval_status: 'approved',
      course_id: 'WL-CLE-2026-ETH',
      requires_manual_review: false,
    });
    expect(db.anchorUpdates[0]).toHaveProperty('cle_metadata');
    expect(db.auditEvents[0]).toMatchObject({ event_type: 'cle_metadata.extracted' });
  });

  it('marks parse/provider failures for manual review and still audits', async () => {
    const db = makeProfessionalEducationDb();
    const provider = makeProvider({}, new Error('malformed model output'));

    const result = await extractAndPersistProfessionalEducationMetadata({
      db,
      provider,
      anchor: makeAnchor('CPE', { credential_title: 'Unknown CPE' }),
      educationKind: 'CPE',
    });

    expect(result.requiresManualReview).toBe(true);
    expect(result.parseError).toContain('malformed model output');
    expect(db.anchorUpdates[0]).toMatchObject({
      cpe_metadata: expect.objectContaining({
        requires_manual_review: true,
        nasba_status: 'unknown',
      }),
    });
    expect(String(db.auditEvents[0]?.details)).not.toContain('Jamie Demo');
  });
});

function makeAnchor(credentialType: 'CPE' | 'CLE', metadata: Record<string, unknown>) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    public_id: 'ARK-2026-PROFED',
    credential_type: credentialType,
    fingerprint: 'a'.repeat(64),
    org_id: '550e8400-e29b-41d4-a716-446655440010',
    user_id: '550e8400-e29b-41d4-a716-446655440011',
    metadata,
  };
}

function makeProvider(fields: Record<string, unknown>, error?: Error): Pick<IAIProvider, 'extractMetadata' | 'name'> {
  return {
    name: 'test-provider',
    extractMetadata: async () => {
      if (error) throw error;
      return {
        fields: fields as ExtractedFields,
        confidence: Number(fields.extraction_confidence ?? 0.9),
        provider: 'test-provider',
        modelVersion: 'test-v1',
      };
    },
  };
}

function makeProfessionalEducationDb() {
  const anchorUpdates: Record<string, unknown>[] = [];
  const auditEvents: Record<string, unknown>[] = [];
  const providers = {
    cpe_provider_registry: [
      {
        provider_domain: 'udemy.com',
        provider_name: 'Udemy',
        nasba_sponsor_id: null,
        nasba_status: 'confirmed',
        last_verified_date: '2026-05-14',
      },
    ],
    cle_provider_registry: [
      {
        provider_domain: 'legal.thomsonreuters.com',
        provider_name: 'Westlaw CLE',
        approval_status: 'approved',
        approved_jurisdictions: ['MULTI_STATE'],
        last_verified_date: '2026-05-15',
      },
    ],
  } as const;

  return {
    anchorUpdates,
    auditEvents,
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            eq(column: string, value: unknown) {
              return {
                async maybeSingle() {
                  const rows = table === 'cpe_provider_registry'
                    ? providers.cpe_provider_registry
                    : providers.cle_provider_registry;
                  return {
                    data: rows.find((row) => (row as Record<string, unknown>)[column] === value) ?? null,
                    error: null,
                  };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          return {
            async eq() {
              anchorUpdates.push(payload);
              return { data: null, error: null };
            },
          };
        },
        async insert(payload: Record<string, unknown>) {
          auditEvents.push(payload);
          return { data: null, error: null };
        },
      };
    },
  };
}
