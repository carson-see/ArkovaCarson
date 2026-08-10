import { describe, expect, it, vi } from 'vitest';
// Force the professional-education schema gate to report the pipeline LIVE, without
// transitively loading config.ts (which needs runtime env). This lets the LEGAL-exclusion
// suite prove the guard holds even when ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY is on.
vi.mock('../utils/professionalEducationSchemaGate.js', () => ({
  isProfessionalEducationSchemaReady: () => true,
  PROFESSIONAL_EDUCATION_SCHEMA_UNAVAILABLE_ERROR: 'professional_education_schema_unavailable',
}));
import * as schemaGate from '../utils/professionalEducationSchemaGate.js';
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
  resolveCpeNasbaStatus,
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

describe('LEGAL credential type is never routed to AI extraction (DPA clause 4.7(b))', () => {
  // Schedule 1 credential type LEGAL is warranted to never reach an AI provider.
  // The one automatic anchor -> AI route is this classifier; excluding LEGAL here
  // makes the guarantee architectural (flag-independent, metadata-independent)
  // rather than resting on ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY being off.
  const barShapedMetadata = {
    credential_title: 'Continuing Legal Education Seminar',
    credential_issuer: 'California State Bar Association',
    source_provider: 'State Bar of California',
    source_url: 'https://calbar.example.org/cle/seminar',
  };

  it('classifies a LEGAL anchor with bar-association-shaped metadata as NOT professional education', () => {
    // Without the guard, this metadata matches CLE_SIGNAL_PATTERN ("bar association",
    // "state bar", "continuing legal education") and returns 'CLE' — routable to Gemini.
    expect(
      classifyProfessionalEducationAnchor({
        credentialType: 'LEGAL',
        metadata: barShapedMetadata,
      }),
    ).toBeNull();
  });

  it('excludes LEGAL defensively — case-insensitively and tolerant of surrounding whitespace', () => {
    expect(classifyProfessionalEducationAnchor({ credentialType: 'legal', metadata: barShapedMetadata })).toBeNull();
    expect(classifyProfessionalEducationAnchor({ credentialType: 'Legal', metadata: barShapedMetadata })).toBeNull();
    expect(classifyProfessionalEducationAnchor({ credentialType: '  LEGAL  ', metadata: barShapedMetadata })).toBeNull();
  });

  it('excludes LEGAL even when caller-supplied metadata.credential_type claims CLE', () => {
    expect(
      classifyProfessionalEducationAnchor({
        credentialType: 'LEGAL',
        metadata: { ...barShapedMetadata, credential_type: 'CLE' },
      }),
    ).toBeNull();
  });

  it('builds no extraction job payload (no AI route) for a LEGAL anchor with bar-association metadata', () => {
    expect(
      buildProfessionalEducationJobPayload({
        id: '550e8400-e29b-41d4-a716-446655440099',
        public_id: 'ARK-2026-LEGAL1',
        credential_type: 'LEGAL',
        fingerprint: 'c'.repeat(64),
        org_id: 'org-1',
        user_id: 'user-1',
        metadata: barShapedMetadata,
      }),
    ).toBeNull();
  });

  it('holds even if the professional-education schema flag were hypothetically enabled', () => {
    // The gate is mocked (top of file) to report the pipeline LIVE. The classifier and
    // payload builder take NO feature flag as input, so their output cannot change when
    // ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY flips on — the exclusion is architectural,
    // not merely a side effect of the flag being off in prod today.
    expect(schemaGate.isProfessionalEducationSchemaReady()).toBe(true);
    expect(
      classifyProfessionalEducationAnchor({ credentialType: 'LEGAL', metadata: barShapedMetadata }),
    ).toBeNull();
    expect(
      buildProfessionalEducationJobPayload({
        id: '550e8400-e29b-41d4-a716-446655440100',
        public_id: 'ARK-2026-LEGAL2',
        credential_type: 'LEGAL',
        fingerprint: 'd'.repeat(64),
        org_id: 'org-1',
        user_id: 'user-1',
        metadata: barShapedMetadata,
      }),
    ).toBeNull();
  });

  it('keeps genuine CLE anchors routable — the guard is scoped to type LEGAL, not CLE', () => {
    // CLE (continuing legal education) is the intended professional-education path and is
    // a distinct credential_type from LEGAL. The DPA warrants LEGAL specifically; excluding
    // CLE would defeat the feature and is not required.
    expect(classifyProfessionalEducationAnchor({ credentialType: 'CLE', metadata: barShapedMetadata })).toBe('CLE');
  });
});

describe('CPE NASBA status is registry-authoritative (fail-closed)', () => {
  describe('resolveCpeNasbaStatus()', () => {
    it('passes when the registry confirms the provider — even if the model said nothing', () => {
      const resolved = resolveCpeNasbaStatus({
        modelAsserted: null,
        registry: { outcome: 'found', nasbaStatus: 'confirmed' },
      });
      expect(resolved.nasba_status).toBe('confirmed');
      expect(resolved.forced_review).toBe(false);
    });

    it('NEVER trusts a model self-assertion of "confirmed" when the registry is absent / says no', () => {
      // The model hallucinated "NASBA confirmed" but the registry has no such
      // provider. The authoritative answer is the registry's, and this must be
      // flagged for review — a self-assertion alone cannot satisfy the allowlist.
      const resolved = resolveCpeNasbaStatus({
        modelAsserted: 'confirmed',
        registry: { outcome: 'not_found' },
      });
      expect(resolved.nasba_status).not.toBe('confirmed');
      expect(resolved.nasba_status).toBe('not_found');
      expect(resolved.forced_review).toBe(true);
    });

    it('flags model-only assertion when there is no registry hit (registry is silent)', () => {
      const resolved = resolveCpeNasbaStatus({
        modelAsserted: 'confirmed',
        registry: { outcome: 'not_found' },
      });
      expect(resolved.nasba_status).not.toBe('confirmed');
      expect(resolved.forced_review).toBe(true);
    });

    it('degrades to needs-review (NOT auto-pass, NOT hard-reject) when the registry is unreachable', () => {
      const resolved = resolveCpeNasbaStatus({
        modelAsserted: 'confirmed',
        registry: { outcome: 'unreachable' },
      });
      // Not auto-passed: a flaky registry must never yield "confirmed".
      expect(resolved.nasba_status).not.toBe('confirmed');
      // Not hard-rejected: an honest "not_found" verdict would wrongly punish a
      // legitimate credential for a transient registry outage. Degraded instead.
      expect(resolved.nasba_status).not.toBe('not_found');
      expect(resolved.nasba_status).toBe('unknown');
      // But it IS forced into manual review so a human resolves it.
      expect(resolved.forced_review).toBe(true);
    });

    it('does not invent "confirmed" out of an unknown registry verdict', () => {
      const resolved = resolveCpeNasbaStatus({
        modelAsserted: 'confirmed',
        registry: { outcome: 'found', nasbaStatus: 'unknown' },
      });
      expect(resolved.nasba_status).toBe('unknown');
      expect(resolved.forced_review).toBe(true);
    });
  });

  describe('end-to-end through extractAndPersistProfessionalEducationMetadata', () => {
    it('AC1: registry-confirmed credential passes', async () => {
      const db = makeProfessionalEducationDb({ cpeRegistry: 'confirmed' });
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

      expect(result.metadata).toMatchObject({ nasba_status: 'confirmed' });
      expect(result.requiresManualReview).toBe(false);
    });

    it('AC2: a model-only "confirmed" with no registry match is flagged, not passed', async () => {
      const db = makeProfessionalEducationDb({ cpeRegistry: 'not_found' });
      // Model hallucinates a NASBA confirmation the registry does not back.
      const provider = makeProvider({
        credit_hours: 8,
        field_of_study: 'Taxes',
        delivery_method: 'QAS Self-Study',
        nasba_status: 'confirmed',
        extraction_confidence: 0.99,
        requires_manual_review: false,
      });

      const result = await extractAndPersistProfessionalEducationMetadata({
        db,
        provider,
        anchor: makeAnchor('CPE', {
          source_url: 'https://totally-fake-cpe.example/cert/1',
          credential_title: 'Bogus Tax CPE',
          credential_issuer: 'Definitely Not Registered LLC',
        }),
        educationKind: 'CPE',
      });

      expect((result.metadata as { nasba_status?: string }).nasba_status).not.toBe('confirmed');
      expect(result.requiresManualReview).toBe(true);
      expect(db.anchorUpdates[0]).toMatchObject({
        cpe_metadata: expect.objectContaining({ requires_manual_review: true }),
      });
      expect((db.anchorUpdates[0] as { cpe_metadata: { nasba_status?: string } }).cpe_metadata.nasba_status)
        .not.toBe('confirmed');
    });

    it('AC3: an unreachable registry degrades to needs-review (neither auto-pass nor hard-fail)', async () => {
      const db = makeProfessionalEducationDb({ cpeRegistry: 'unreachable' });
      const provider = makeProvider({
        credit_hours: 8,
        field_of_study: 'Taxes',
        delivery_method: 'QAS Self-Study',
        nasba_status: 'confirmed',
        extraction_confidence: 0.95,
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

      const status = (result.metadata as { nasba_status?: string }).nasba_status;
      // Not auto-passed.
      expect(status).not.toBe('confirmed');
      // Not hard-rejected as a definitive "not_found".
      expect(status).not.toBe('not_found');
      expect(status).toBe('unknown');
      // Forced into manual review so a human resolves it.
      expect(result.requiresManualReview).toBe(true);
    });
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

/**
 * Registry behavior knob for the CPE provider lookup, so tests can drive the
 * three distinct outcomes the resolver must separate:
 *   - 'confirmed' : registry has the provider with nasba_status='confirmed'
 *   - 'not_found' : registry has no matching row (provider genuinely absent)
 *   - 'unreachable': the registry query errors / throws (flaky DB, not a verdict)
 */
type CpeRegistryBehavior = 'confirmed' | 'not_found' | 'unreachable';

function makeProfessionalEducationDb(options?: { cpeRegistry?: CpeRegistryBehavior }) {
  const cpeRegistry = options?.cpeRegistry ?? 'confirmed';
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
                  if (table === 'cpe_provider_registry') {
                    // Simulate a flaky/unreachable registry: the query rejects.
                    // This must NOT be read as "provider not found".
                    if (cpeRegistry === 'unreachable') {
                      throw new Error('registry connection reset');
                    }
                    // Simulate "provider genuinely absent": no row matches.
                    if (cpeRegistry === 'not_found') {
                      return { data: null, error: null };
                    }
                  }
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
