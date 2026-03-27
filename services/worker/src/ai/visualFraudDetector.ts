/**
 * Visual Fraud Detector (Phase 5)
 *
 * Server-side document image analysis using Gemini 2.0 Pro Vision.
 * Analyzes document images for visual tampering indicators.
 *
 * Constitution 4A: Only processes PII-stripped document images.
 * The client must strip PII from images before sending to this endpoint.
 *
 * Detection signals:
 * - Font inconsistencies (mixed typefaces, irregular spacing)
 * - Image manipulation artifacts (cloning, splicing, JPEG ghost)
 * - Layout anomalies (misaligned fields, irregular margins)
 * - Metadata inconsistencies (creation date vs content date)
 * - Security feature absence (expected watermarks, seals, holograms)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

// =============================================================================
// TYPES
// =============================================================================

export type FraudRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface VisualFraudSignal {
  /** Signal identifier */
  id: string;
  /** Human-readable description */
  description: string;
  /** Severity: how concerning is this signal? */
  severity: 'info' | 'warning' | 'critical';
  /** Confidence that this signal is present (0-1) */
  confidence: number;
  /** Category of the signal */
  category: 'font' | 'layout' | 'manipulation' | 'metadata' | 'security_feature';
}

export interface VisualFraudResult {
  /** Overall risk level */
  riskLevel: FraudRiskLevel;
  /** Overall risk score (0-100, higher = more suspicious) */
  riskScore: number;
  /** Individual fraud signals detected */
  signals: VisualFraudSignal[];
  /** Summary explanation */
  summary: string;
  /** Recommended actions */
  recommendations: string[];
  /** Model used for analysis */
  model: string;
  /** Processing time in ms */
  processingTimeMs: number;
}

// =============================================================================
// ANALYSIS PROMPT
// =============================================================================

const VISUAL_FRAUD_SYSTEM_PROMPT = `You are a document forensics expert. Analyze the provided document image for visual indicators of tampering, forgery, or manipulation.

Evaluate the following categories:

1. **Font Analysis**: Look for mixed typefaces within the same field, inconsistent character spacing, font weight mismatches, and characters that appear pasted from different sources.

2. **Layout Analysis**: Check for misaligned text fields, irregular margins, inconsistent spacing between sections, and elements that appear displaced.

3. **Image Manipulation**: Look for JPEG compression artifacts around specific regions (suggesting editing), cloning artifacts, color/brightness discontinuities, and irregular noise patterns.

4. **Metadata Consistency**: Check if visible dates, formatting style, and design elements are consistent with the claimed issuing period and institution.

5. **Security Features**: For official documents, check for expected security elements like watermarks, official seals, holograms, microprinting indicators, or security backgrounds.

6. **Credential-Type-Specific Security Features**:
   - DEGREE/DIPLOMA: Look for university seal/emblem, registrar signature block, embossed stamp indicators, security paper texture, anti-copy patterns, holographic overlay
   - LICENSE: State seal, board logo, barcode/QR code, photograph placeholder, anti-tamper features, security background guilloché patterns
   - CERTIFICATE: Issuing organization logo, authorized signature, certificate number format, border design consistency
   - INSURANCE: Insurance company logo, ACORD form formatting (if COI), policy number format consistency
   - LEGAL: Law firm letterhead, notary stamp/seal, court filing stamps, case number format
   - FINANCIAL: Audit firm logo, financial institution watermarks, GAAP/IFRS formatting conventions
   - PATENT: Patent office seal, patent number format (US X,XXX,XXX), filing date stamps
   - SEC_FILING: EDGAR header formatting, SEC seal, filing acceptance stamp

7. **Cross-Document Consistency** (when analyzing):
   - Check if fonts are consistent throughout the document
   - Verify date formats are consistent (don't mix MM/DD/YYYY and DD/MM/YYYY)
   - Check that the overall design language is consistent (margins, spacing, alignment)
   - Look for resolution differences between different parts of the image

Respond ONLY with valid JSON in this format:
{
  "riskScore": <number 0-100>,
  "signals": [
    {
      "id": "<category>_<specific_signal>",
      "description": "<human-readable description>",
      "severity": "info" | "warning" | "critical",
      "confidence": <number 0-1>,
      "category": "font" | "layout" | "manipulation" | "metadata" | "security_feature"
    }
  ],
  "summary": "<1-2 sentence summary of findings>",
  "recommendations": ["<action items>"]
}

Be conservative — only flag genuine indicators. Do not flag normal document variations as fraud. A score of 0-20 means clean, 21-50 means minor concerns, 51-75 means significant concerns, 76-100 means strong fraud indicators.`;

// =============================================================================
// DETECTOR
// =============================================================================

const VISION_MODEL = 'gemini-2.5-flash'; // Flash supports vision and is cost-efficient

/**
 * Analyze a document image for visual fraud indicators.
 * Delegates to enhancedAnalyzeDocument for the actual analysis.
 *
 * @param imageBase64 - Base64-encoded document image (PII-stripped)
 * @param mimeType - Image MIME type (image/png, image/jpeg, etc.)
 * @param credentialType - Type of credential for context-aware analysis
 * @param apiKey - Gemini API key (defaults to env var)
 * @returns Visual fraud analysis result
 */
export async function analyzeDocumentImage(
  imageBase64: string,
  mimeType: string,
  credentialType: string,
  apiKey?: string,
): Promise<VisualFraudResult> {
  return enhancedAnalyzeDocument(imageBase64, mimeType, credentialType, apiKey);
}

/**
 * Credential-type-specific prompt additions for enhanced analysis.
 * Provides targeted guidance based on the document type being analyzed.
 */
const CREDENTIAL_TYPE_PROMPTS: Record<string, string> = {
  DEGREE: 'Pay special attention to: university seal/emblem presence and quality, registrar signature block, embossed stamp indicators, security paper texture patterns, anti-copy void patterns, and holographic overlay indicators.',
  DIPLOMA: 'Pay special attention to: university seal/emblem presence and quality, registrar signature block, embossed stamp indicators, security paper texture patterns, anti-copy void patterns, and holographic overlay indicators.',
  LICENSE: 'Pay special attention to: state seal presence and quality, board logo consistency, barcode/QR code presence and readability, photograph placeholder formatting, anti-tamper features, and security background guilloché patterns.',
  CERTIFICATE: 'Pay special attention to: issuing organization logo consistency, authorized signature presence, certificate number format validation, and border design consistency throughout the document.',
  INSURANCE: 'Pay special attention to: insurance company logo quality and placement, ACORD form formatting (if COI), and policy number format consistency.',
  LEGAL: 'Pay special attention to: law firm letterhead consistency, notary stamp/seal presence and quality, court filing stamps, and case number format validation.',
  FINANCIAL: 'Pay special attention to: audit firm logo presence, financial institution watermarks, and GAAP/IFRS formatting conventions.',
  PATENT: 'Pay special attention to: patent office seal presence, patent number format (US X,XXX,XXX pattern), and filing date stamp formatting.',
  SEC_FILING: 'Pay special attention to: EDGAR header formatting consistency, SEC seal presence, and filing acceptance stamp formatting.',
};

/**
 * Enhanced document image analysis with credential-type-specific instructions.
 *
 * Builds on the base visual fraud detection by adding type-specific security
 * feature checks and cross-document consistency analysis guidance.
 *
 * @param imageBase64 - Base64-encoded document image (PII-stripped)
 * @param mimeType - Image MIME type (image/png, image/jpeg, etc.)
 * @param credentialType - Type of credential for context-aware analysis
 * @param apiKey - Gemini API key (defaults to env var)
 * @returns Visual fraud analysis result with type-specific analysis
 */
export async function enhancedAnalyzeDocument(
  imageBase64: string,
  mimeType: string,
  credentialType: string,
  apiKey?: string,
): Promise<VisualFraudResult> {
  const start = Date.now();
  const key = apiKey ?? process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error('GEMINI_API_KEY is required for visual fraud detection');
  }

  const client = new GoogleGenerativeAI(key);
  const model = client.getGenerativeModel({
    model: VISION_MODEL,
    systemInstruction: VISUAL_FRAUD_SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  try {
    // Build type-specific prompt with additional guidance
    const typeUpper = credentialType.toUpperCase();
    const typeSpecificGuidance = CREDENTIAL_TYPE_PROMPTS[typeUpper] ?? '';
    const contextPrompt = `Analyze this ${credentialType} document image for signs of visual tampering or forgery. Focus on the specific security features and formatting standards expected for this document type.${typeSpecificGuidance ? `\n\n${typeSpecificGuidance}` : ''}`;

    const response = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: contextPrompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      }],
    });

    const text = response.response.text();
    const parsed = JSON.parse(text);
    const processingTimeMs = Date.now() - start;

    // Validate and normalize the response
    const riskScore = typeof parsed.riskScore === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.riskScore)))
      : 0;

    const signals: VisualFraudSignal[] = Array.isArray(parsed.signals)
      ? parsed.signals
          .filter((s: Record<string, unknown>) =>
            s.id && s.description && s.severity && typeof s.confidence === 'number')
          .map((s: Record<string, unknown>) => ({
            id: String(s.id),
            description: String(s.description),
            severity: ['info', 'warning', 'critical'].includes(s.severity as string)
              ? s.severity as 'info' | 'warning' | 'critical'
              : 'info',
            confidence: Math.max(0, Math.min(1, s.confidence as number)),
            category: ['font', 'layout', 'manipulation', 'metadata', 'security_feature']
              .includes(s.category as string)
              ? s.category as VisualFraudSignal['category']
              : 'metadata',
          }))
      : [];

    const riskLevel = scoreToRiskLevel(riskScore);

    return {
      riskLevel,
      riskScore,
      signals,
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'Analysis complete',
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.map(String)
        : [],
      model: VISION_MODEL,
      processingTimeMs,
    };
  } catch (err) {
    logger.error({ error: err, credentialType }, 'Visual fraud analysis failed');
    throw new Error(
      `Visual fraud analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    );
  }
}

/**
 * Map risk score to risk level.
 */
export function scoreToRiskLevel(score: number): FraudRiskLevel {
  if (score <= 20) return 'LOW';
  if (score <= 50) return 'MEDIUM';
  if (score <= 75) return 'HIGH';
  return 'CRITICAL';
}
