/**
 * Fraud Eval Dataset (Phase 5)
 *
 * Adversarial examples with known tampering for evaluating the
 * visual fraud detection system and text-based fraud signals.
 *
 * Each entry describes a document with:
 * - Known tampering indicators (or lack thereof for clean examples)
 * - Expected fraud signals that should be detected
 * - Expected risk level
 *
 * Dataset structure:
 * - 50 clean examples (no tampering) — baseline for false positive rate
 * - 50 tampered examples — various fraud techniques
 */

export interface FraudEvalEntry {
  /** Unique ID (FE-001 to FE-100) */
  id: string;
  /** Credential type */
  credentialType: string;
  /** Description of the document */
  description: string;
  /** Whether the document is tampered */
  isTampered: boolean;
  /** Tampering technique used (null for clean) */
  tamperingTechnique: string | null;
  /** Description of the tampering */
  tamperingDescription: string | null;
  /** Expected fraud signals that should be detected */
  expectedSignals: string[];
  /** Expected risk level */
  expectedRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Category of tampering */
  tamperingCategory: 'none' | 'font' | 'layout' | 'manipulation' | 'metadata' | 'security_feature' | 'composite';
  /** Tags for filtering */
  tags: string[];
}

// =============================================================================
// CLEAN EXAMPLES (no tampering — should score LOW risk)
// =============================================================================

const CLEAN_EXAMPLES: FraudEvalEntry[] = [
  {
    id: 'FE-001',
    credentialType: 'DEGREE',
    description: 'Standard university bachelor degree, properly formatted, official seal visible',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'degree', 'standard'],
  },
  {
    id: 'FE-002',
    credentialType: 'LICENSE',
    description: 'State professional license with holographic seal, consistent typography',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'license', 'standard'],
  },
  {
    id: 'FE-003',
    credentialType: 'CERTIFICATE',
    description: 'Accredited training certificate, proper letterhead and signature block',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'certificate', 'standard'],
  },
  {
    id: 'FE-004',
    credentialType: 'TRANSCRIPT',
    description: 'Official sealed transcript with watermark and registrar signature',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'transcript', 'standard'],
  },
  {
    id: 'FE-005',
    credentialType: 'PROFESSIONAL',
    description: 'CPA certification from state board, standard formatting',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'professional', 'standard'],
  },
  {
    id: 'FE-006',
    credentialType: 'DEGREE',
    description: 'PhD diploma with Latin honors, embossed seal',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'degree', 'phd'],
  },
  {
    id: 'FE-007',
    credentialType: 'CLE',
    description: 'CLE credit certificate with bar association stamp',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'cle', 'standard'],
  },
  {
    id: 'FE-008',
    credentialType: 'CERTIFICATE',
    description: 'ISO 9001 audit certification on official letterhead',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'certificate', 'iso'],
  },
  {
    id: 'FE-009',
    credentialType: 'DEGREE',
    description: 'International university degree with Apostille certification',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'degree', 'international'],
  },
  {
    id: 'FE-010',
    credentialType: 'LICENSE',
    description: 'Medical license with state seal, standard layout',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'license', 'medical'],
  },
  // Low-quality but authentic scans
  {
    id: 'FE-011',
    credentialType: 'DEGREE',
    description: 'Aged diploma from 1985, yellowed paper, slightly faded text — authentic age wear',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'degree', 'aged', 'edge-case'],
  },
  {
    id: 'FE-012',
    credentialType: 'CERTIFICATE',
    description: 'Photo of certificate at angle, some glare — authentic but low quality',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'certificate', 'low-quality', 'edge-case'],
  },
  {
    id: 'FE-013',
    credentialType: 'TRANSCRIPT',
    description: 'Photocopied transcript, some loss of detail — authentic copy',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'transcript', 'photocopy', 'edge-case'],
  },
  {
    id: 'FE-014',
    credentialType: 'LICENSE',
    description: 'Wallet-sized license card, slightly worn edges — normal wear',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'license', 'worn', 'edge-case'],
  },
  {
    id: 'FE-015',
    credentialType: 'DEGREE',
    description: 'Bilingual degree (English/Spanish), dual formatting — authentic international format',
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW',
    tamperingCategory: 'none',
    tags: ['clean', 'degree', 'bilingual', 'edge-case'],
  },
  // More standard clean examples
  ...Array.from({ length: 35 }, (_, i) => ({
    id: `FE-${String(16 + i).padStart(3, '0')}`,
    credentialType: ['DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'CLE',
      'SEC_FILING', 'REGULATION', 'FINANCIAL', 'PUBLICATION', 'INSURANCE', 'ATTESTATION',
      'PATENT', 'LEGAL', 'OTHER'][i % 15],
    description: `Standard ${['DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'CLE',
      'SEC_FILING', 'REGULATION', 'FINANCIAL', 'PUBLICATION', 'INSURANCE', 'ATTESTATION',
      'PATENT', 'LEGAL', 'OTHER'][i % 15].toLowerCase()} document #${i + 16}, properly formatted, no anomalies`,
    isTampered: false,
    tamperingTechnique: null,
    tamperingDescription: null,
    expectedSignals: [],
    expectedRiskLevel: 'LOW' as const,
    tamperingCategory: 'none' as const,
    tags: ['clean', 'batch'],
  })),
];

// =============================================================================
// TAMPERED EXAMPLES
// =============================================================================

const TAMPERED_EXAMPLES: FraudEvalEntry[] = [
  // Font tampering
  {
    id: 'FE-051',
    credentialType: 'DEGREE',
    description: 'Degree with name field in different font than rest of document',
    isTampered: true,
    tamperingTechnique: 'font_substitution',
    tamperingDescription: 'Recipient name uses Arial while rest of document uses Times New Roman',
    expectedSignals: ['font_inconsistency', 'font_mismatch'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'font',
    tags: ['tampered', 'degree', 'font'],
  },
  {
    id: 'FE-052',
    credentialType: 'TRANSCRIPT',
    description: 'Transcript with GPA value in slightly different font weight',
    isTampered: true,
    tamperingTechnique: 'text_replacement',
    tamperingDescription: 'GPA "3.95" replaced with different font weight than surrounding text',
    expectedSignals: ['font_weight_mismatch', 'text_replacement_artifact'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'font',
    tags: ['tampered', 'transcript', 'font', 'gpa'],
  },
  {
    id: 'FE-053',
    credentialType: 'LICENSE',
    description: 'License with irregular character spacing in license number',
    isTampered: true,
    tamperingTechnique: 'character_editing',
    tamperingDescription: 'Individual characters in license number have inconsistent kerning',
    expectedSignals: ['irregular_spacing', 'character_kerning_anomaly'],
    expectedRiskLevel: 'MEDIUM',
    tamperingCategory: 'font',
    tags: ['tampered', 'license', 'font', 'spacing'],
  },
  {
    id: 'FE-054',
    credentialType: 'CERTIFICATE',
    description: 'Certificate with date field using different text rendering',
    isTampered: true,
    tamperingTechnique: 'text_overlay',
    tamperingDescription: 'Issue date overlaid with different anti-aliasing than original text',
    expectedSignals: ['text_rendering_mismatch', 'overlay_detected'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'font',
    tags: ['tampered', 'certificate', 'font', 'date'],
  },
  {
    id: 'FE-055',
    credentialType: 'DEGREE',
    description: 'Degree with institution name in pixel-aligned font on vector document',
    isTampered: true,
    tamperingTechnique: 'raster_text_insertion',
    tamperingDescription: 'Institution name appears as rasterized text while rest is vector',
    expectedSignals: ['raster_vector_mismatch', 'text_quality_inconsistency'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'font',
    tags: ['tampered', 'degree', 'font', 'quality'],
  },

  // Layout tampering
  {
    id: 'FE-056',
    credentialType: 'TRANSCRIPT',
    description: 'Transcript with misaligned grade column',
    isTampered: true,
    tamperingTechnique: 'field_displacement',
    tamperingDescription: 'Grade column shifted 2px right from expected alignment with headers',
    expectedSignals: ['column_misalignment', 'field_displacement'],
    expectedRiskLevel: 'MEDIUM',
    tamperingCategory: 'layout',
    tags: ['tampered', 'transcript', 'layout'],
  },
  {
    id: 'FE-057',
    credentialType: 'CERTIFICATE',
    description: 'Certificate with inconsistent margins between sections',
    isTampered: true,
    tamperingTechnique: 'section_insertion',
    tamperingDescription: 'Additional certification line inserted with different vertical spacing',
    expectedSignals: ['irregular_margins', 'spacing_inconsistency'],
    expectedRiskLevel: 'MEDIUM',
    tamperingCategory: 'layout',
    tags: ['tampered', 'certificate', 'layout'],
  },
  {
    id: 'FE-058',
    credentialType: 'LICENSE',
    description: 'License with cropped and re-inserted photo',
    isTampered: true,
    tamperingTechnique: 'photo_replacement',
    tamperingDescription: 'Photo has different DPI than surrounding document',
    expectedSignals: ['dpi_mismatch', 'photo_boundary_artifact'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'layout',
    tags: ['tampered', 'license', 'layout', 'photo'],
  },
  {
    id: 'FE-059',
    credentialType: 'DEGREE',
    description: 'Degree with seal placed over text (should be under or integrated)',
    isTampered: true,
    tamperingTechnique: 'seal_overlay',
    tamperingDescription: 'Official seal appears as a layer on top of text, not embossed or integrated',
    expectedSignals: ['seal_layer_anomaly', 'overlay_detected'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'layout',
    tags: ['tampered', 'degree', 'layout', 'seal'],
  },

  // Image manipulation
  {
    id: 'FE-060',
    credentialType: 'DEGREE',
    description: 'Degree with cloned background texture around edited name field',
    isTampered: true,
    tamperingTechnique: 'clone_stamp',
    tamperingDescription: 'Clone stamp artifacts visible in security background near name field',
    expectedSignals: ['clone_artifact', 'texture_repetition'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'manipulation',
    tags: ['tampered', 'degree', 'manipulation', 'clone'],
  },
  {
    id: 'FE-061',
    credentialType: 'CERTIFICATE',
    description: 'Certificate with JPEG ghost around edited region',
    isTampered: true,
    tamperingTechnique: 'jpeg_double_compression',
    tamperingDescription: 'JPEG compression artifacts differ between edited and original regions',
    expectedSignals: ['jpeg_ghost', 'compression_inconsistency'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'manipulation',
    tags: ['tampered', 'certificate', 'manipulation', 'jpeg'],
  },
  {
    id: 'FE-062',
    credentialType: 'TRANSCRIPT',
    description: 'Transcript with color histogram anomaly in grade section',
    isTampered: true,
    tamperingTechnique: 'color_adjustment',
    tamperingDescription: 'White background in grade area has slightly different color temperature',
    expectedSignals: ['color_inconsistency', 'region_color_shift'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'manipulation',
    tags: ['tampered', 'transcript', 'manipulation', 'color'],
  },
  {
    id: 'FE-063',
    credentialType: 'LICENSE',
    description: 'License with spliced barcode from different document',
    isTampered: true,
    tamperingTechnique: 'splice',
    tamperingDescription: 'Barcode region has different noise pattern than surrounding area',
    expectedSignals: ['noise_inconsistency', 'splice_boundary'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'manipulation',
    tags: ['tampered', 'license', 'manipulation', 'splice'],
  },
  {
    id: 'FE-064',
    credentialType: 'DEGREE',
    description: 'Degree with AI-generated content fill in date field',
    isTampered: true,
    tamperingTechnique: 'generative_fill',
    tamperingDescription: 'Date field shows generative AI fill artifacts (smooth texture, no paper grain)',
    expectedSignals: ['generative_fill_detected', 'texture_anomaly'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'manipulation',
    tags: ['tampered', 'degree', 'manipulation', 'ai-generated'],
  },

  // Metadata inconsistencies
  {
    id: 'FE-065',
    credentialType: 'DEGREE',
    description: 'Degree claiming 2010 issue but using 2022 university logo redesign',
    isTampered: true,
    tamperingTechnique: 'anachronistic_elements',
    tamperingDescription: 'Logo/branding style postdates the claimed issue date by 12 years',
    expectedSignals: ['anachronistic_branding', 'date_design_mismatch'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'metadata',
    tags: ['tampered', 'degree', 'metadata', 'anachronism'],
  },
  {
    id: 'FE-066',
    credentialType: 'CERTIFICATE',
    description: 'Certificate with signatory who was not in role on claimed date',
    isTampered: true,
    tamperingTechnique: 'signature_anachronism',
    tamperingDescription: 'Dean signature from person who left the role 2 years before claimed date',
    expectedSignals: ['signatory_timeline_mismatch'],
    expectedRiskLevel: 'MEDIUM',
    tamperingCategory: 'metadata',
    tags: ['tampered', 'certificate', 'metadata', 'signature'],
  },
  {
    id: 'FE-067',
    credentialType: 'LICENSE',
    description: 'License with format that does not match known templates for that state',
    isTampered: true,
    tamperingTechnique: 'template_fabrication',
    tamperingDescription: 'Document layout does not match any known format for the issuing authority',
    expectedSignals: ['unknown_template', 'format_mismatch'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'metadata',
    tags: ['tampered', 'license', 'metadata', 'template'],
  },
  {
    id: 'FE-068',
    credentialType: 'TRANSCRIPT',
    description: 'Transcript with course numbers that do not exist in catalog',
    isTampered: true,
    tamperingTechnique: 'content_fabrication',
    tamperingDescription: 'Course codes follow format but do not correspond to real courses',
    expectedSignals: ['fabricated_content', 'invalid_course_codes'],
    expectedRiskLevel: 'MEDIUM',
    tamperingCategory: 'metadata',
    tags: ['tampered', 'transcript', 'metadata', 'fabrication'],
  },

  // Security feature tampering
  {
    id: 'FE-069',
    credentialType: 'DEGREE',
    description: 'Degree with missing watermark where one is expected',
    isTampered: true,
    tamperingTechnique: 'watermark_removal',
    tamperingDescription: 'Document type should have watermark but none is visible',
    expectedSignals: ['missing_watermark', 'security_feature_absent'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'security_feature',
    tags: ['tampered', 'degree', 'security', 'watermark'],
  },
  {
    id: 'FE-070',
    credentialType: 'LICENSE',
    description: 'License with obviously photoshopped holographic element',
    isTampered: true,
    tamperingTechnique: 'hologram_simulation',
    tamperingDescription: 'Holographic area has flat color gradient instead of true holographic properties',
    expectedSignals: ['fake_hologram', 'flat_security_element'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'security_feature',
    tags: ['tampered', 'license', 'security', 'hologram'],
  },
  {
    id: 'FE-071',
    credentialType: 'CERTIFICATE',
    description: 'Certificate with embossed seal that is clearly flat (printed)',
    isTampered: true,
    tamperingTechnique: 'seal_printing',
    tamperingDescription: 'Seal appears printed flat instead of embossed — no depth/shadow cues',
    expectedSignals: ['flat_seal', 'missing_embossing'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'security_feature',
    tags: ['tampered', 'certificate', 'security', 'seal'],
  },
  {
    id: 'FE-072',
    credentialType: 'TRANSCRIPT',
    description: 'Transcript missing institution security background pattern',
    isTampered: true,
    tamperingTechnique: 'background_removal',
    tamperingDescription: 'Plain white background where security pattern should be visible',
    expectedSignals: ['missing_security_background', 'security_feature_absent'],
    expectedRiskLevel: 'HIGH',
    tamperingCategory: 'security_feature',
    tags: ['tampered', 'transcript', 'security', 'background'],
  },

  // Composite tampering (multiple techniques)
  {
    id: 'FE-073',
    credentialType: 'DEGREE',
    description: 'Completely fabricated degree: wrong template, fake seal, edited name',
    isTampered: true,
    tamperingTechnique: 'complete_fabrication',
    tamperingDescription: 'Multiple fraud indicators: fabricated template, flat printed seal, font mismatches in name',
    expectedSignals: ['unknown_template', 'flat_seal', 'font_inconsistency'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'composite',
    tags: ['tampered', 'degree', 'composite', 'fabrication'],
  },
  {
    id: 'FE-074',
    credentialType: 'TRANSCRIPT',
    description: 'Altered transcript: grades changed, GPA recalculated, dates adjusted',
    isTampered: true,
    tamperingTechnique: 'multi_field_edit',
    tamperingDescription: 'Multiple fields edited: fonts differ for grades, layout slightly off for GPA row',
    expectedSignals: ['font_mismatch', 'field_displacement', 'text_replacement_artifact'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'composite',
    tags: ['tampered', 'transcript', 'composite', 'grades'],
  },
  {
    id: 'FE-075',
    credentialType: 'LICENSE',
    description: 'License with replaced photo AND edited expiration date',
    isTampered: true,
    tamperingTechnique: 'dual_edit',
    tamperingDescription: 'Photo has DPI mismatch, expiration date has font rendering difference',
    expectedSignals: ['dpi_mismatch', 'text_rendering_mismatch'],
    expectedRiskLevel: 'CRITICAL',
    tamperingCategory: 'composite',
    tags: ['tampered', 'license', 'composite', 'multi-edit'],
  },

  // Remaining tampered examples
  ...Array.from({ length: 25 }, (_, i) => {
    const techniques = [
      { tech: 'font_substitution', cat: 'font', signals: ['font_inconsistency'], risk: 'HIGH' },
      { tech: 'text_overlay', cat: 'font', signals: ['overlay_detected'], risk: 'HIGH' },
      { tech: 'field_displacement', cat: 'layout', signals: ['field_displacement'], risk: 'MEDIUM' },
      { tech: 'clone_stamp', cat: 'manipulation', signals: ['clone_artifact'], risk: 'CRITICAL' },
      { tech: 'splice', cat: 'manipulation', signals: ['splice_boundary'], risk: 'CRITICAL' },
      { tech: 'watermark_removal', cat: 'security_feature', signals: ['missing_watermark'], risk: 'HIGH' },
      { tech: 'template_fabrication', cat: 'metadata', signals: ['unknown_template'], risk: 'HIGH' },
      { tech: 'complete_fabrication', cat: 'composite', signals: ['font_inconsistency', 'unknown_template'], risk: 'CRITICAL' },
    ] as const;
    const t = techniques[i % techniques.length];
    const credTypes = ['DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL'];
    return {
      id: `FE-${String(76 + i).padStart(3, '0')}`,
      credentialType: credTypes[i % credTypes.length],
      description: `${credTypes[i % credTypes.length].toLowerCase()} with ${t.tech.replace(/_/g, ' ')} tampering #${i + 76}`,
      isTampered: true,
      tamperingTechnique: t.tech,
      tamperingDescription: `Automated adversarial example using ${t.tech.replace(/_/g, ' ')} technique`,
      expectedSignals: [...t.signals],
      expectedRiskLevel: t.risk,
      tamperingCategory: t.cat,
      tags: ['tampered', 'batch', t.cat],
    };
  }),
];

// =============================================================================
// EXPORTS
// =============================================================================

/** Full fraud eval dataset: 50 clean + 50 tampered = 100 entries */
export const FRAUD_EVAL_DATASET: FraudEvalEntry[] = [
  ...CLEAN_EXAMPLES,
  ...TAMPERED_EXAMPLES,
];

/** Get clean (non-tampered) entries */
export function getCleanEntries(): FraudEvalEntry[] {
  return FRAUD_EVAL_DATASET.filter(e => !e.isTampered);
}

/** Get tampered entries */
export function getTamperedEntries(): FraudEvalEntry[] {
  return FRAUD_EVAL_DATASET.filter(e => e.isTampered);
}

/** Get entries by tampering category */
export function getEntriesByTamperingCategory(category: FraudEvalEntry['tamperingCategory']): FraudEvalEntry[] {
  return FRAUD_EVAL_DATASET.filter(e => e.tamperingCategory === category);
}

/** Get entries by credential type */
export function getFraudEntriesByType(credentialType: string): FraudEvalEntry[] {
  return FRAUD_EVAL_DATASET.filter(e => e.credentialType === credentialType);
}
